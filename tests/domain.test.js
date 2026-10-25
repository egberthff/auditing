import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { createRepo } from "../src/store/repo.js";
import * as actions from "../src/domain/tripActions.js";
import { buildLedger } from "../src/domain/ledgerState.js";
import { exportTrip, importFile } from "../src/domain/importExport.js";
import { importLegacyLocalData } from "../src/store/migrateLocal.js";
import { formatMoney, parseAmount } from "../src/money.js";

let n = 0;
const newRepo = () => createRepo({ dbName: `test-${Date.now()}-${n++}`, channelName: `test-${n}` });

async function tripWith(repo, names, currency = "USD") {
  const trip = await actions.createTrip(repo, { name: "Trip", currency });
  for (const name of names) await actions.addMember(repo, await repo.getTripData(trip.id), name);
  const data = await repo.getTripData(trip.id);
  const id = name => data.members.find(m => m.name === name).id;
  return { trip, id, data: () => repo.getTripData(trip.id) };
}

describe("money", () => {
  test("parses and formats by currency precision", () => {
    expect(parseAmount("1,234.56", "USD")).toBe(123456);
    expect(parseAmount("1.005", "USD")).toBeNaN();
    expect(parseAmount("-1", "USD")).toBeNaN();
    expect(parseAmount("1500", "JPY")).toBe(1500);
    expect(parseAmount("1500.5", "JPY")).toBeNaN();
    expect(parseAmount("1.234", "KWD")).toBe(1234);
    expect(parseAmount("9".repeat(20), "USD")).toBeNaN();
    // decimal commas and both grouping styles; ambiguous input is refused, never inflated
    expect(parseAmount("10,50", "EUR")).toBe(1050);
    expect(parseAmount("10,5", "EUR")).toBe(1050);
    expect(parseAmount("1.234,56", "EUR")).toBe(123456);
    expect(parseAmount("1 234,56", "EUR")).toBe(123456);
    expect(parseAmount("1,234", "USD")).toBe(123400);
    expect(parseAmount("12,345,678", "USD")).toBe(1234567800);
    expect(parseAmount("1,2,3", "USD")).toBeNaN();
    expect(parseAmount("12,3456", "USD")).toBeNaN();
    expect(parseAmount("1,23.45", "USD")).toBeNaN();
    expect(parseAmount("1.2.3", "USD")).toBeNaN();
    expect(parseAmount("1.234.56", "USD")).toBeNaN();
    expect(parseAmount("", "USD")).toBeNaN();
    expect(parseAmount(",", "USD")).toBeNaN();
    expect(formatMoney(123456, "USD")).toMatch(/1,234\.56/);
    expect(formatMoney(1500, "JPY")).toMatch(/1,500/);
  });
});

describe("repo", () => {
  test("every local write is queued for sync in the same transaction", async () => {
    const repo = await newRepo();
    const { trip } = await tripWith(repo, ["Ann", "Ben"]);
    const entries = await repo.outboxEntries();
    expect(entries.map(e => e.table)).toEqual(["trips", "members", "members"]);
    expect(entries[0].id).toBe(trip.id);
  });

  test("a batch with an invalid record writes nothing", async () => {
    const repo = await newRepo();
    await expect(repo.saveBatch([{ table: "trips", record: { name: "A", currency: "USD" } }, { table: "members", record: { name: "no trip" } }]))
      .rejects.toThrow(/tripId/);
    expect(await repo.listTrips()).toEqual([]);
    expect(await repo.outboxEntries()).toEqual([]);
  });

  test("remote rows don't overwrite a record with an unpushed local change", async () => {
    const repo = await newRepo();
    const trip = await actions.createTrip(repo, { name: "Local name" });
    expect(await repo.applyRemote("trips", [{ ...trip, name: "Server name" }])).toBe(0);
    expect((await repo.get("trips", trip.id)).name).toBe("Local name");
    await repo.deleteOutbox((await repo.outboxEntries()).map(e => e.seq));
    expect(await repo.applyRemote("trips", [{ ...trip, name: "Server name" }])).toBe(1);
    expect((await repo.get("trips", trip.id)).name).toBe("Server name");
  });

  test("purging a trip removes its records and queued changes from this device", async () => {
    const repo = await newRepo();
    const { trip } = await tripWith(repo, ["Ann"]);
    await repo.purgeTrips([trip.id]);
    expect(await repo.listTrips({ includeDeleted: true })).toEqual([]);
    expect(await repo.listChildren("members", trip.id, { includeDeleted: true })).toEqual([]);
    expect(await repo.outboxEntries()).toEqual([]);
  });
});

describe("trip actions", () => {
  test("expenses split equally; settlements and audit follow", async () => {
    const repo = await newRepo();
    const t = await tripWith(repo, ["Ann", "Ben", "Cy"]);
    await actions.addExpense(repo, await t.data(), { description: "Hotel", amountCents: 30000, mode: "single", payerId: t.id("Ann") });
    await actions.addExpense(repo, await t.data(), { description: "Taxi", amountCents: 1000, mode: "equal" });
    await actions.addExpense(repo, await t.data(), {
      description: "Dinner", amountCents: 9000, mode: "custom", contributions: { [t.id("Ben")]: 6000, [t.id("Cy")]: 3000 },
    });
    const { ledger, audit } = buildLedger(await t.data());
    expect(audit.isValid).toBe(true);
    expect(ledger.net).toEqual({ [t.id("Ann")]: 17000, [t.id("Ben")]: -7000, [t.id("Cy")]: -10000 });
  });

  test("custom amounts must add up, and payers must be current members", async () => {
    const repo = await newRepo();
    const t = await tripWith(repo, ["Ann", "Ben"]);
    await expect(actions.addExpense(repo, await t.data(), { description: "x", amountCents: 1000, mode: "custom", contributions: { [t.id("Ann")]: 900 } }))
      .rejects.toThrow(/add up to \$9\.00, but the expense is \$10\.00/);
    await expect(actions.addExpense(repo, await t.data(), { description: "x", amountCents: 1000, mode: "single", payerId: "someone-else" }))
      .rejects.toThrow(/who paid/);
    await expect(actions.addExpense(repo, await t.data(), { description: "", amountCents: 1000, mode: "equal" })).rejects.toThrow(/describe/);
  });

  test("members joining later: billed from now on, or retroactively from the start", async () => {
    const repo = await newRepo();
    const t = await tripWith(repo, ["Ann", "Ben"]);
    await actions.addExpense(repo, await t.data(), { description: "Hotel", amountCents: 9000, mode: "single", payerId: t.id("Ann") });
    await actions.addMember(repo, await t.data(), "Cy");
    await actions.addMember(repo, await t.data(), "Di", { billFrom: "start" });
    const data = await t.data();
    const di = data.members.find(m => m.name === "Di").id;
    const cy = data.members.find(m => m.name === "Cy").id;
    expect(data.expenses[0].participants).toContain(di);
    expect(data.expenses[0].participants).not.toContain(cy);
    expect(buildLedger(data).ledger.net[di]).toBe(-3000);
    expect(buildLedger(data).ledger.net[cy]).toBe(0);
  });

  test("removing a member keeps their history; re-adding the same name brings them back", async () => {
    const repo = await newRepo();
    const t = await tripWith(repo, ["Ann", "Ben", "Cy"]);
    await actions.addExpense(repo, await t.data(), { description: "Hotel", amountCents: 9000, mode: "single", payerId: t.id("Ann") });
    expect(await actions.removeMember(repo, await t.data(), t.id("Cy"))).toBe("left");
    await actions.addExpense(repo, await t.data(), { description: "Dinner", amountCents: 4000, mode: "single", payerId: t.id("Ann") });
    let { ledger } = buildLedger(await t.data());
    expect(ledger.net[t.id("Cy")]).toBe(-3000);
    expect(ledger.net[t.id("Ben")]).toBe(-5000);
    await actions.addMember(repo, await t.data(), "cy");
    const back = (await t.data()).members.find(m => m.id === t.id("Cy"));
    expect(back).toMatchObject({ name: "Cy", leftAt: null });
    await expect(actions.addMember(repo, await t.data(), "ANN")).rejects.toThrow(/already a member/);
    const extra = await actions.addMember(repo, await t.data(), "Typo");
    expect(await actions.removeMember(repo, await t.data(), extra.member.id)).toBe("deleted");
  });

  test("payments are checked against current balances", async () => {
    const repo = await newRepo();
    const t = await tripWith(repo, ["Ann", "Ben"]);
    await actions.addExpense(repo, await t.data(), { description: "Hotel", amountCents: 10000, mode: "single", payerId: t.id("Ann") });
    await expect(actions.recordPayment(repo, await t.data(), { from: t.id("Ben"), to: t.id("Ann"), amountCents: 6000 })).rejects.toThrow(/only owes/);
    await actions.recordPayment(repo, await t.data(), { from: t.id("Ben"), to: t.id("Ann"), amountCents: 5000 });
    expect(buildLedger(await t.data()).ledger.settlements).toEqual([]);
    await expect(actions.recordPayment(repo, await t.data(), { from: t.id("Ben"), to: t.id("Ann"), amountCents: 1 })).rejects.toThrow(/changed/);
  });

  test("currency can't change precision once amounts exist", async () => {
    const repo = await newRepo();
    const t = await tripWith(repo, ["Ann"]);
    await actions.updateTrip(repo, await t.data(), { currency: "EUR" });
    await actions.addExpense(repo, await t.data(), { description: "x", amountCents: 100, mode: "equal" });
    await expect(actions.updateTrip(repo, await t.data(), { currency: "JPY" })).rejects.toThrow(/decimals/);
    await expect(actions.createTrip(repo, { name: "x", currency: "ABCD" })).rejects.toThrow(/currency/);
  });

  test("viewers: valid unique emails, removable and re-addable", async () => {
    const repo = await newRepo();
    const t = await tripWith(repo, []);
    const v = await actions.addViewer(repo, await t.data(), " Friend@Example.com ");
    expect(v.email).toBe("friend@example.com");
    await expect(actions.addViewer(repo, await t.data(), "friend@example.com")).rejects.toThrow(/already/);
    await expect(actions.addViewer(repo, await t.data(), "not-an-email")).rejects.toThrow(/valid email/);
    await actions.removeViewer(repo, v.id);
    const again = await actions.addViewer(repo, await t.data(), "friend@example.com");
    expect(again.id).toBe(v.id);
  });
});

describe("import and export", () => {
  test("a trip export re-imports as an identical but separate trip", async () => {
    const repo = await newRepo();
    const t = await tripWith(repo, ["Ann", "Ben"], "EUR");
    await actions.addExpense(repo, await t.data(), { description: "Hotel", amountCents: 9001, mode: "single", payerId: t.id("Ann") });
    await actions.addDebt(repo, await t.data(), { from: t.id("Ben"), to: t.id("Ann"), amountCents: 500 });
    const file = JSON.parse(JSON.stringify(exportTrip(await t.data())));
    const { tripId, audit } = await importFile(repo, file);
    expect(audit.isValid).toBe(true);
    expect(tripId).not.toBe(t.trip.id);
    const copy = await repo.getTripData(tripId);
    expect(copy.trip.currency).toBe("EUR");
    const names = d => Object.fromEntries(Object.entries(buildLedger(d).ledger.net).map(([id, v]) => [d.members.find(m => m.id === id).name, v]));
    expect(names(copy)).toEqual(names(await t.data()));
  });

  test("damaged and foreign files are refused", async () => {
    const repo = await newRepo();
    await expect(importFile(repo, { hello: 1 })).rejects.toThrow(/not a Travel Audit/);
    await expect(importFile(repo, { format: "travel-audit-trip", trip: { name: "x", currency: "USD" }, members: [], expenses: [{ participants: ["ghost"] }] }))
      .rejects.toThrow(/damaged/);
    expect(await repo.listTrips()).toEqual([]);
  });

  test("data from the previous version is imported once as a trip, with names becoming members", async () => {
    const repo = await newRepo();
    const old = {
      schemaVersion: 2, people: ["Ann", "Ben"], formerMembers: ["Cy"],
      transactions: [
        { id: 1, amount: 9000, description: "Hotel", participants: ["Ann", "Ben", "Cy"], shares: [3000, 3000, 3000], contributions: { Ann: 9000, Ben: 0, Cy: 0 } },
      ],
      directDebts: [
        { id: 2, from: "Ann", to: "Ben", amount: 1000, description: "Payment: Ben paid Ann" }, // old reversed payment
        { id: 3, kind: "payment", from: "Cy", to: "Ann", amount: 500, description: "Payment: Cy paid Ann" },
      ],
    };
    const storage = new Map([["travelAudit.v2", JSON.stringify(old)]]);
    const local = { getItem: k => storage.get(k) ?? null };
    const result = await importLegacyLocalData(repo, local);
    expect(result.audit.isValid).toBe(true);
    expect(await importLegacyLocalData(repo, local)).toBeNull(); // only once
    const data = await repo.getTripData(result.tripId);
    const byName = Object.fromEntries(data.members.map(m => [m.name, m]));
    expect(byName.Cy.leftAt).not.toBeNull();
    expect(data.expenses[0].paidMode).toBe("single");
    expect(data.transfers.map(t => [t.kind, byName.Ann.id === t.toMember])).toEqual([["payment", true], ["payment", true]]);
    const net = buildLedger(data).ledger.net;
    expect([net[byName.Ann.id], net[byName.Ben.id], net[byName.Cy.id]]).toEqual([6000 - 1000 - 500, -3000 + 1000, -3000 + 500]);
  });
});
