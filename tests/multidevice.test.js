// The bookkeeper on several devices (and viewers), all syncing through one server.
import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { createRepo } from "../src/store/repo.js";
import { createSyncEngine } from "../src/sync/syncEngine.js";
import * as actions from "../src/domain/tripActions.js";
import { buildLedger } from "../src/domain/ledgerState.js";
import { autoFixes, memberExpected, runAutoFixes, splitDrift } from "../src/domain/reconcile.js";
import { createFakeServer, createFakeSupabase, manualTimers } from "./helpers/fakeSupabase.js";

const OWNER = { id: "owner-1", email: "owner@example.com" };
let n = 0;

async function device(server, user = OWNER) {
  const repo = await createRepo({ dbName: `md-${Date.now()}-${n++}`, channelName: `md-${n}` });
  const online = { value: true };
  const sync = createSyncEngine({
    repo, supabase: createFakeSupabase(server, user), isOnline: () => online.value, timers: manualTimers(),
    afterSync: u => runAutoFixes(repo, u),
  });
  return { repo, sync, online };
}

const tripOf = async (d, id) => d.repo.getTripData(id);
const memberId = (data, name) => data.members.find(m => m.name === name).id;
const netByName = data => Object.fromEntries(Object.entries(buildLedger(data).ledger.net).map(([id, v]) => [data.members.find(m => m.id === id)?.name, v]));

// Everything a device holds for a trip, comparable across devices
async function snapshot(d, tripId) {
  const data = await d.repo.getTripData(tripId);
  if (!data) return null;
  const clean = rows => rows.map(({ updatedAt, ...r }) => r).sort((a, b) => a.id.localeCompare(b.id));
  return { trip: data.trip.name, members: clean(data.members), expenses: clean(data.expenses), transfers: clean(data.transfers) };
}

async function newTrip(d, names) {
  const trip = await actions.createTrip(d.repo, { name: "Bali", currency: "USD", ownerId: OWNER.id });
  for (const name of names) await actions.addMember(d.repo, await tripOf(d, trip.id), name);
  return trip;
}

describe("a second device", () => {
  test("signing in on a new device downloads every trip, and the device is verified identical", async () => {
    const server = createFakeServer();
    const phone = await device(server);
    const trip = await newTrip(phone, ["Ann", "Ben", "Cy"]);
    let data = await tripOf(phone, trip.id);
    await actions.addExpense(phone.repo, data, { description: "Villa", amountCents: 30001, mode: "single", payerId: memberId(data, "Ann") });
    await actions.addDebt(phone.repo, await tripOf(phone, trip.id), { from: memberId(data, "Ben"), to: memberId(data, "Cy"), amountCents: 500 });
    await phone.sync.sync();

    const laptop = await device(server);
    const status = await laptop.sync.sync();
    expect(status.state).toBe("synced");
    expect(status.verifiedAt).toBe(status.lastSyncedAt);
    expect(await snapshot(laptop, trip.id)).toEqual(await snapshot(phone, trip.id));
    expect(netByName(await tripOf(laptop, trip.id))).toEqual(netByName(await tripOf(phone, trip.id)));
  });

  test("changes made on the new device flow back to the first one", async () => {
    const server = createFakeServer();
    const phone = await device(server);
    const trip = await newTrip(phone, ["Ann", "Ben"]);
    await phone.sync.sync();
    const laptop = await device(server);
    await laptop.sync.sync();

    laptop.online.value = false;
    const data = await tripOf(laptop, trip.id);
    await actions.addExpense(laptop.repo, data, { description: "Dinner", amountCents: 4000, mode: "single", payerId: memberId(data, "Ben") });
    await laptop.sync.sync(); // offline: stays queued
    expect((await tripOf(phone, trip.id)).expenses).toHaveLength(0);

    laptop.online.value = true;
    await laptop.sync.sync();
    await phone.sync.sync();
    expect(await snapshot(phone, trip.id)).toEqual(await snapshot(laptop, trip.id));
  });
});

// Later activity moves this device's pull cursors well past the trip's rows, so an ordinary
// incremental pull would never fetch those rows again; only verification can repair them.
async function moveCursorsPastExistingRows(server, d, ownerId = OWNER.id) {
  server.advance(60 * 60 * 1000);
  const later = await actions.createTrip(d.repo, { name: "Later trip", currency: "USD", ownerId });
  await actions.addMember(d.repo, await d.repo.getTripData(later.id), "Someone"); // moves the members cursor too
  await d.sync.sync();
}

describe("verification repairs a device that drifted", () => {
  test("a row missing locally (without a queued change) is detected and downloaded again", async () => {
    const server = createFakeServer();
    const a = await device(server);
    const trip = await newTrip(a, ["Ann", "Ben"]);
    await a.sync.sync();
    await moveCursorsPastExistingRows(server, a);
    const lost = (await tripOf(a, trip.id)).members[0];
    await a.repo.removeLocal("members", [lost.id]); // e.g. storage damage
    expect((await tripOf(a, trip.id)).members).toHaveLength(1);
    const status = await a.sync.sync();
    expect(status.state).toBe("synced");
    expect((await tripOf(a, trip.id)).members).toHaveLength(2);
  });

  test("a stale local version and a stray local row are corrected to match the server", async () => {
    const server = createFakeServer();
    const a = await device(server);
    const trip = await newTrip(a, ["Ann"]);
    await a.sync.sync();
    const ann = (await tripOf(a, trip.id)).members[0];
    await a.repo.putLocal("members", [{ ...ann, name: "Wrong", updatedAt: "2000-01-01T00:00:00.000Z" }]);
    await a.repo.putLocal("members", [{ ...ann, id: crypto.randomUUID(), name: "Ghost" }]);
    await a.sync.sync();
    expect((await tripOf(a, trip.id)).members.map(m => m.name)).toEqual(["Ann"]);
  });

  test("a viewer whose device synced before being invited still receives the whole trip", async () => {
    const server = createFakeServer();
    const owner = await device(server);
    const trip = await newTrip(owner, ["Ann", "Ben"]);
    const data = await tripOf(owner, trip.id);
    await actions.addExpense(owner.repo, data, { description: "Villa", amountCents: 9000, mode: "single", payerId: memberId(data, "Ann") });
    await owner.sync.sync();

    const friend = await device(server, { id: "viewer-1", email: "friend@example.com" });
    await friend.sync.sync();
    await moveCursorsPastExistingRows(server, friend, "viewer-1"); // the friend uses the app for their own trip
    await actions.addViewer(owner.repo, await tripOf(owner, trip.id), "friend@example.com");
    await owner.sync.sync();
    await friend.sync.sync();

    const seen = await tripOf(friend, trip.id);
    expect(seen.members).toHaveLength(2);
    expect(seen.expenses).toHaveLength(1);
    expect(netByName(seen)).toEqual(netByName(await tripOf(owner, trip.id)));
  });
});

describe("offline edits on two devices", () => {
  async function twoDevices(names = ["Ann", "Ben", "Cy"]) {
    const server = createFakeServer();
    const a = await device(server);
    const trip = await newTrip(a, names);
    const data = await tripOf(a, trip.id);
    await actions.addExpense(a.repo, data, { description: "Villa", amountCents: 9000, mode: "single", payerId: memberId(data, "Ann") });
    await a.sync.sync();
    const b = await device(server);
    await b.sync.sync();
    a.online.value = false;
    b.online.value = false;
    const both = async () => {
      a.online.value = true; b.online.value = true;
      await a.sync.sync(); await b.sync.sync(); await a.sync.sync();
    };
    return { server, a, b, trip, both };
  }

  test("a deletion wins over an edit of the same expense made elsewhere", async () => {
    const { a, b, trip, both } = await twoDevices();
    const villa = (await tripOf(a, trip.id)).expenses[0];
    await actions.deleteExpense(a.repo, villa.id);
    await actions.addMember(b.repo, await tripOf(b, trip.id), "Di", { billFrom: "start" }); // re-splits the villa on B
    await both();
    for (const d of [a, b]) expect((await tripOf(d, trip.id)).expenses).toHaveLength(0);
    expect(await snapshot(a, trip.id)).toEqual(await snapshot(b, trip.id));
  });

  test("a member billed from the start is added to an expense recorded offline elsewhere (automatically, identically)", async () => {
    const { a, b, trip, both } = await twoDevices();
    await actions.addMember(a.repo, await tripOf(a, trip.id), "Dana", { billFrom: "start" });
    const onB = await tripOf(b, trip.id);
    await actions.addExpense(b.repo, onB, { description: "Boat", amountCents: 1000, mode: "single", payerId: memberId(onB, "Ben") });
    await both();

    const left = await snapshot(a, trip.id);
    expect(left).toEqual(await snapshot(b, trip.id));
    const data = await tripOf(a, trip.id);
    const dana = memberId(data, "Dana");
    for (const e of data.expenses) expect(e.participants).toContain(dana);
    expect(buildLedger(data).audit.isValid).toBe(true);
    expect(splitDrift(data)).toEqual([]);
    expect(netByName(data).Dana).toBe(-(2250 + 250)); // a quarter of the villa and of the boat
  });

  test("an expense recorded offline after someone left elsewhere is flagged on both devices, and can be fixed", async () => {
    const { a, b, trip, both } = await twoDevices();
    const onA = await tripOf(a, trip.id);
    await actions.removeMember(a.repo, onA, memberId(onA, "Cy"));
    await new Promise(r => setTimeout(r, 5));
    const onB = await tripOf(b, trip.id);
    await actions.addExpense(b.repo, onB, { description: "Boat", amountCents: 1000, mode: "single", payerId: memberId(onB, "Ann") });
    await both();

    for (const d of [a, b]) {
      const drift = splitDrift(await tripOf(d, trip.id));
      expect(drift.map(x => [x.expense.description, x.extra.map(m => m.name), x.missing.map(m => m.name)])).toEqual([["Boat", ["Cy"], []]]);
    }
    await actions.fixSplit(a.repo, await tripOf(a, trip.id), splitDrift(await tripOf(a, trip.id))[0].expense.id);
    await a.sync.sync();
    await b.sync.sync();
    const data = await tripOf(b, trip.id);
    expect(splitDrift(data)).toEqual([]);
    expect(data.expenses.find(e => e.description === "Boat").participants).not.toContain(memberId(data, "Cy"));
    expect(await snapshot(a, trip.id)).toEqual(await snapshot(b, trip.id));
  });

  test("“Keep as is” clears the flag on every device", async () => {
    const { a, b, trip, both } = await twoDevices();
    const onA = await tripOf(a, trip.id);
    await actions.removeMember(a.repo, onA, memberId(onA, "Cy"));
    await new Promise(r => setTimeout(r, 5));
    const onB = await tripOf(b, trip.id);
    await actions.addExpense(b.repo, onB, { description: "Boat", amountCents: 1000, mode: "single", payerId: memberId(onB, "Ann") });
    await both();
    const flagged = splitDrift(await tripOf(b, trip.id))[0].expense;
    await actions.keepSplit(b.repo, await tripOf(b, trip.id), flagged.id);
    await b.sync.sync();
    await a.sync.sync();
    expect(splitDrift(await tripOf(a, trip.id))).toEqual([]);
  });

  test("property: random offline edits on two devices converge to identical, valid books", async () => {
    let seed = 7;
    const rnd = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
    for (let run = 0; run < 12; run++) {
      const { a, b, trip, both } = await twoDevices(["Ann", "Ben"]);
      for (const d of [a, b]) {
        for (let i = 0; i < 6; i++) {
          const data = await tripOf(d, trip.id);
          const active = data.members.filter(m => !m.leftAt);
          const action = rnd(6);
          if (action === 0) await actions.addMember(d.repo, data, `M${run}-${i}-${rnd(1000)}`, { billFrom: rnd(2) ? "start" : "join" });
          else if (action === 1 && active.length > 1) await actions.removeMember(d.repo, data, active[rnd(active.length)].id);
          else if (action === 2 && data.expenses.length) await actions.deleteExpense(d.repo, data.expenses[rnd(data.expenses.length)].id);
          else if (active.length) {
            await actions.addExpense(d.repo, data, { description: `E${i}`, amountCents: 1 + rnd(50000), mode: "single", payerId: active[rnd(active.length)].id });
          }
        }
      }
      await both();
      await both();
      expect(await snapshot(a, trip.id)).toEqual(await snapshot(b, trip.id));
      const data = await tripOf(a, trip.id);
      expect(buildLedger(data).audit.issues).toEqual([]);
      expect(autoFixes(data)).toEqual([]); // nothing left to fix automatically
      for (const d of [a, b]) expect(d.sync.status.state).toBe("synced");
    }
  }, 120000);
});

describe("membership timing", () => {
  const at = iso => ({ occurredAt: iso, participants: [], contributions: {} });
  const member = extra => ({ id: "m", createdAt: "2026-01-05T00:00:00Z", billFrom: "join", leftAt: null, ...extra });

  test("members are expected only for expenses while they were on the trip", () => {
    const m = member({ periods: [{ joinedAt: "2026-01-05T00:00:00Z", leftAt: "2026-01-10T00:00:00Z" }, { joinedAt: "2026-01-20T00:00:00Z", leftAt: null }] });
    expect(memberExpected(m, at("2026-01-04T00:00:00Z"), [])).toBe(false);
    expect(memberExpected(m, at("2026-01-06T00:00:00Z"), [])).toBe(true);
    expect(memberExpected(m, at("2026-01-15T00:00:00Z"), [])).toBe(false); // away
    expect(memberExpected(m, at("2026-01-25T00:00:00Z"), [])).toBe(true);
  });

  test("billed-from-the-start members are expected for everything before they left", () => {
    const m = member({ billFrom: "start", leftAt: "2026-01-10T00:00:00Z" });
    expect(memberExpected(m, at("2025-12-01T00:00:00Z"), [])).toBe(true);
    expect(memberExpected(m, at("2026-01-11T00:00:00Z"), [])).toBe(false);
  });

  test("records without history count from the first expense they share", () => {
    const m = member({ createdAt: "2026-02-01T00:00:00Z" });
    const old = { ...at("2026-01-01T00:00:00Z"), participants: ["m"] };
    expect(memberExpected(m, old, [old])).toBe(true);
  });

  test("someone who paid is never flagged as an extra", () => {
    const people = [
      { id: "a", name: "Ann", createdAt: "2026-01-01T00:00:00Z", billFrom: "join", leftAt: null, periods: [{ joinedAt: "2026-01-01T00:00:00Z", leftAt: null }] },
      { id: "c", name: "Cy", createdAt: "2026-01-01T00:00:00Z", billFrom: "join", leftAt: "2026-01-02T00:00:00Z", periods: [{ joinedAt: "2026-01-01T00:00:00Z", leftAt: "2026-01-02T00:00:00Z" }] },
    ];
    const paidByCy = { id: "e", amountCents: 100, occurredAt: "2026-01-03T00:00:00Z", participants: ["a", "c"], shares: [50, 50], contributions: { a: 0, c: 100 } };
    expect(splitDrift({ members: people, expenses: [paidByCy] })).toEqual([]);
    const notPaid = { ...paidByCy, contributions: { a: 100, c: 0 } };
    expect(splitDrift({ members: people, expenses: [notPaid] })[0].extra.map(m => m.name)).toEqual(["Cy"]);
  });
});
