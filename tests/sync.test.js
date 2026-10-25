import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { createRepo } from "../src/store/repo.js";
import { createSyncEngine } from "../src/sync/syncEngine.js";
import * as actions from "../src/domain/tripActions.js";
import { buildLedger } from "../src/domain/ledgerState.js";
import { createFakeServer, createFakeSupabase, manualTimers } from "./helpers/fakeSupabase.js";

const OWNER = { id: "owner-1", email: "owner@example.com" };
let n = 0;

async function device({ server, user = OWNER, online = { value: true } } = {}) {
  const repo = await createRepo({ dbName: `sync-${Date.now()}-${n++}`, channelName: `sync-${n}` });
  const supabase = createFakeSupabase(server, user);
  const timers = manualTimers();
  const sync = createSyncEngine({ repo, supabase, isOnline: () => online.value, timers });
  return { repo, supabase, sync, timers, online };
}

async function ownedTrip(repo, names = ["Ann", "Ben"]) {
  const trip = await actions.createTrip(repo, { name: "Bali", currency: "USD", ownerId: OWNER.id });
  for (const name of names) await actions.addMember(repo, await repo.getTripData(trip.id), name);
  return trip;
}

describe("push", () => {
  test("changes made offline wait in the outbox and go up in order once online", async () => {
    const server = createFakeServer();
    const d = await device({ server, online: { value: false } });
    const trip = await ownedTrip(d.repo);
    const data = await d.repo.getTripData(trip.id);
    await actions.addExpense(d.repo, data, { description: "Hotel", amountCents: 1000, mode: "single", payerId: data.members[0].id });

    expect((await d.sync.sync()).state).toBe("offline");
    expect(d.sync.status.pending).toBe(4);
    expect(server.rows("expenses")).toHaveLength(0);

    d.online.value = true;
    const status = await d.sync.sync();
    expect(status).toMatchObject({ state: "synced", pending: 0 });
    expect(d.supabase.calls.map(c => c.table)).toEqual(["trips", "members", "expenses"]);
    expect(server.rows("members")).toHaveLength(2);
    expect(server.rows("expenses")[0]).toMatchObject({ amount_cents: 1000, trip_id: trip.id });
    expect(await d.repo.outboxEntries()).toEqual([]);
  });

  test("a record changed several times is pushed once, at its latest version", async () => {
    const server = createFakeServer();
    const d = await device({ server });
    const trip = await ownedTrip(d.repo, []);
    await d.repo.update("trips", trip.id, { name: "Bali 2" });
    await d.repo.update("trips", trip.id, { name: "Bali 3" });
    await d.sync.sync();
    expect(d.supabase.calls).toEqual([{ table: "trips", ids: [trip.id] }]);
    expect(server.tables.trips.get(trip.id).name).toBe("Bali 3");
  });

  test("guest trips stay on the device until claimed by the signed-in account", async () => {
    const server = createFakeServer();
    const d = await device({ server });
    const trip = await actions.createTrip(d.repo, { name: "Guest trip" });
    await actions.addMember(d.repo, await d.repo.getTripData(trip.id), "Ann");
    await d.sync.sync();
    expect(server.rows("trips")).toHaveLength(0);
    expect(await d.repo.outboxEntries()).toHaveLength(2);

    await d.repo.update("trips", trip.id, { ownerId: OWNER.id });
    await d.sync.sync();
    expect(server.rows("trips")).toHaveLength(1);
    expect(server.rows("members")).toHaveLength(1);
    expect(await d.repo.outboxEntries()).toEqual([]);
  });

  test("a record the server refuses stops the queue, is reported, and clears once fixed locally", async () => {
    const server = createFakeServer();
    const d = await device({ server });
    const trip = await ownedTrip(d.repo);
    const data = await d.repo.getTripData(trip.id);
    const ann = data.members[0].id;
    await actions.addExpense(d.repo, data, { description: "Good", amountCents: 1000, mode: "single", payerId: ann });
    const bad = await actions.addExpense(d.repo, data, { description: "Bad", amountCents: 2000, mode: "single", payerId: ann });
    await actions.addExpense(d.repo, data, { description: "After", amountCents: 3000, mode: "single", payerId: ann });
    server.reject = (table, row) => (table === "expenses" && row.description === "Bad" && !row.deleted_at ? "Expense \"Bad\": rejected" : null);

    const status = await d.sync.sync();
    expect(status.state).toBe("error");
    expect(status.error).toMatchObject({ retryable: false, table: "expenses", message: 'Expense "Bad": rejected' });
    expect(status.error.record.id).toBe(bad.id);
    expect(server.rows("expenses").map(e => e.description)).toEqual(["Good"]);
    expect(d.timers.pending.size).toBe(0); // no automatic retry for a validation error

    await actions.deleteExpense(d.repo, bad.id);
    expect((await d.sync.sync()).state).toBe("synced");
    expect(server.rows("expenses").map(e => [e.description, Boolean(e.deleted_at)]))
      .toEqual([["Good", false], ["Bad", true], ["After", false]]);
  });

  test("network failures keep everything queued and retry with growing delays", async () => {
    const server = createFakeServer();
    server.offline = true; // navigator says online, but requests fail (e.g. captive portal)
    const d = await device({ server });
    await ownedTrip(d.repo);
    let status = await d.sync.sync();
    expect(status).toMatchObject({ state: "retrying", pending: 3 });
    expect(d.timers.lastDelay()).toBe(2000);
    await d.sync.sync();
    expect(d.timers.lastDelay()).toBe(4000);
    server.offline = false;
    status = await d.sync.sync();
    expect(status).toMatchObject({ state: "synced", pending: 0 });
    expect(server.rows("members")).toHaveLength(2);
  });

  test("without a session nothing is sent", async () => {
    const server = createFakeServer();
    const d = await device({ server });
    await ownedTrip(d.repo);
    d.supabase.signOut();
    expect((await d.sync.sync()).state).toBe("signed-out");
    expect(server.rows("trips")).toHaveLength(0);
  });
});

describe("pull", () => {
  test("a second device receives everything and computes the same balances", async () => {
    const server = createFakeServer();
    const a = await device({ server });
    const trip = await ownedTrip(a.repo, ["Ann", "Ben", "Cy"]);
    const data = await a.repo.getTripData(trip.id);
    await actions.addExpense(a.repo, data, { description: "Hotel", amountCents: 10001, mode: "single", payerId: data.members[0].id });
    await a.sync.sync();

    const b = await device({ server });
    await b.sync.sync();
    const copy = await b.repo.getTripData(trip.id);
    expect(buildLedger(copy).ledger.net).toEqual(buildLedger(await a.repo.getTripData(trip.id)).ledger.net);
    expect(buildLedger(copy).audit.isValid).toBe(true);
    // pulling again changes nothing and queues nothing
    await b.sync.sync();
    expect(await b.repo.outboxEntries()).toEqual([]);
  });

  test("more rows than one page are all pulled", async () => {
    const server = createFakeServer();
    const a = await device({ server });
    const trip = await ownedTrip(a.repo, ["Ann"]);
    const ann = (await a.repo.getTripData(trip.id)).members[0].id;
    await a.repo.saveBatch(Array.from({ length: 2345 }, (_, i) => ({
      table: "transfers",
      record: { tripId: trip.id, kind: "debt", fromMember: ann, toMember: ann, amountCents: i + 1, description: "", occurredAt: new Date().toISOString() },
    })));
    await a.sync.sync();
    const b = await device({ server });
    await b.sync.sync();
    expect(await b.repo.listChildren("transfers", trip.id)).toHaveLength(2345);
  });

  test("the owner's edits on two devices converge: the last one synced wins", async () => {
    const server = createFakeServer();
    const a = await device({ server });
    const trip = await ownedTrip(a.repo, []);
    await a.sync.sync();
    const b = await device({ server });
    await b.sync.sync();

    await a.repo.update("trips", trip.id, { name: "From A" });
    await b.repo.update("trips", trip.id, { name: "From B" });
    await a.sync.sync();
    expect((await b.repo.get("trips", trip.id)).name).toBe("From B"); // local unpushed edit is kept
    await b.sync.sync();
    await a.sync.sync();
    expect((await a.repo.get("trips", trip.id)).name).toBe("From B");
    expect((await b.repo.get("trips", trip.id)).name).toBe("From B");
  });

  test("viewers receive shared trips read-only, and lose them when access is removed", async () => {
    const server = createFakeServer();
    const owner = await device({ server });
    const trip = await ownedTrip(owner.repo);
    const invite = await actions.addViewer(owner.repo, await owner.repo.getTripData(trip.id), "friend@example.com");
    await owner.sync.sync();

    const viewer = await device({ server, user: { id: "viewer-1", email: "friend@example.com" } });
    await viewer.sync.sync();
    const seen = await viewer.repo.getTripData(trip.id);
    expect(seen.members).toHaveLength(2);
    expect(seen.viewers).toEqual([]); // the viewer list is private to the owner

    // A viewer's local edit is never accepted by the server
    await viewer.repo.update("trips", trip.id, { name: "Hacked" });
    expect((await viewer.sync.sync()).state).toBe("synced"); // not owned: stays local, not pushed
    expect(server.tables.trips.get(trip.id).name).toBe("Bali");

    await actions.removeViewer(owner.repo, invite.id);
    await owner.sync.sync();
    await viewer.sync.sync();
    expect(await viewer.repo.getTripData(trip.id)).toBeNull();
    expect(await viewer.repo.outboxEntries()).toEqual([]);
  });
});
