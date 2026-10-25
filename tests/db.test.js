// Runs the real migration in PGlite (Postgres compiled to WASM) against a minimal stand-in
// for Supabase's `auth` schema, then checks the accounting triggers and row level security.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync(new URL("../supabase/migrations/0001_init.sql", import.meta.url), "utf8");

const SUPABASE_STUB = `
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on all functions in schema auth to anon, authenticated;
`;

const OWNER = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const TRIP = "aaaaaaaa-0000-4000-8000-000000000001";
const ALICE = "bbbbbbbb-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const OUTSIDER = "bbbbbbbb-0000-4000-8000-000000000099";

let db;

// Run `fn` as a signed-in user, inside a transaction that is always rolled back.
async function as(userId, email, fn) {
  return db.transaction(async tx => {
    await tx.query("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [userId, JSON.stringify({ sub: userId, email })]);
    try { return await fn(tx); } finally { await tx.rollback(); }
  });
}

async function errorOf(promise) {
  try { await promise; return null; } catch (e) { return e; }
}

const expense = (overrides = {}) => ({
  id: crypto.randomUUID(), trip_id: TRIP, description: "dinner", amount_cents: 1001, paid_mode: "single",
  payer_id: ALICE, participants: [ALICE, BOB], shares: [501, 500], contributions: { [ALICE]: 1001 }, ...overrides,
});

async function insertExpense(tx, e) {
  return tx.query(
    `insert into public.expenses (id, trip_id, description, amount_cents, paid_mode, payer_id, participants, shares, contributions)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [e.id, e.trip_id, e.description, e.amount_cents, e.paid_mode, e.payer_id, e.participants, e.shares, JSON.stringify(e.contributions)]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await db.exec(MIGRATION);
  await db.exec(`
    insert into auth.users values ('${OWNER}', 'owner@example.com'), ('${VIEWER}', 'viewer@example.com'), ('${STRANGER}', 'stranger@example.com');
    insert into public.trips (id, owner_id, name, currency) values ('${TRIP}', '${OWNER}', 'Bali', 'USD');
    insert into public.members (id, trip_id, name) values ('${ALICE}', '${TRIP}', 'Alice'), ('${BOB}', '${TRIP}', 'Bob');
    insert into public.trip_viewers (id, trip_id, email) values (gen_random_uuid(), '${TRIP}', 'viewer@example.com');
  `);
}, 60000);

// Shut the WASM database down before the test worker exits (otherwise the worker can crash on exit)
afterAll(async () => { await db?.close(); });

describe("accounting rules enforced by the database", () => {
  test("a balanced, equally shared expense is accepted and stamped by the server", async () => {
    await as(OWNER, "owner@example.com", async tx => {
      const e = expense();
      await insertExpense(tx, e);
      const { rows } = await tx.query("select updated_at from public.expenses where id = $1", [e.id]);
      expect(rows[0].updated_at).toBeTruthy();
    });
  });

  test.each([
    ["contributions not adding up", { contributions: { [ALICE]: 1000 } }, /contributions add up to 1000, not 1001/],
    ["unequal shares", { shares: [801, 200] }, /shares must be equal/],
    ["shares not adding up", { shares: [500, 500] }, /shares must be equal/],
    ["negative contribution", { contributions: { [ALICE]: 1101, [BOB]: -100 } }, /whole, non-negative/],
    ["fractional contribution", { contributions: { [ALICE]: 1000.5, [BOB]: 0.5 } }, /whole, non-negative/],
    ["text contribution", { contributions: { [ALICE]: "1001" } }, /whole, non-negative/],
    ["duplicate participant", { participants: [ALICE, ALICE], shares: [501, 500] }, /listed more than once/],
    ["participants/shares mismatch", { shares: [1001] }, /do not line up/],
    ["no participants", { participants: [], shares: [] }, /at least one member/],
    ["member from outside the trip", { participants: [ALICE, OUTSIDER] }, /not a member of this trip/],
    ["zero amount", { amount_cents: 0, shares: [0, 0], contributions: { [ALICE]: 0 } }, /check/],
  ])("rejects %s", async (_, overrides, message) => {
    const err = await as(OWNER, "owner@example.com", tx => errorOf(insertExpense(tx, expense(overrides))));
    expect(err?.message).toMatch(message);
  });

  test("a bad expense can still be soft-deleted (so a stuck sync can be cleared)", async () => {
    await as(OWNER, "owner@example.com", async tx => {
      const e = expense({ shares: [900, 101] });
      await tx.query(
        `insert into public.expenses (id, trip_id, amount_cents, paid_mode, participants, shares, contributions, deleted_at)
         values ($1, $2, $3, 'single', $4, $5, $6, now())`,
        [e.id, TRIP, e.amount_cents, e.participants, e.shares, JSON.stringify(e.contributions)]);
    });
  });

  test("transfers must be between two different members of the trip", async () => {
    const insert = (tx, from, to) => tx.query(
      "insert into public.transfers (id, trip_id, kind, from_member, to_member, amount_cents) values (gen_random_uuid(), $1, 'debt', $2, $3, 500)",
      [TRIP, from, to]);
    await as(OWNER, "owner@example.com", tx => insert(tx, ALICE, BOB));
    expect((await as(OWNER, "owner@example.com", tx => errorOf(insert(tx, ALICE, ALICE))))?.message).toMatch(/check/);
    expect((await as(OWNER, "owner@example.com", tx => errorOf(insert(tx, ALICE, OUTSIDER))))?.message).toMatch(/not a member/);
  });

  test("records cannot move between trips and trips cannot change owner", async () => {
    const err1 = await as(OWNER, "owner@example.com", tx => errorOf(tx.query(`update public.trips set owner_id = '${STRANGER}' where id = '${TRIP}'`)));
    expect(err1?.message).toMatch(/cannot change owner|row-level security/);
    const err2 = await as(OWNER, "owner@example.com", async tx => {
      await tx.query(`insert into public.trips (id, owner_id, name) values (gen_random_uuid(), '${OWNER}', 'Other')`);
      const { rows } = await tx.query(`select id from public.trips where name = 'Other'`);
      return errorOf(tx.query(`update public.members set trip_id = $1 where id = '${ALICE}'`, [rows[0].id]));
    });
    expect(err2?.message).toMatch(/cannot move/);
  });
});

describe("row level security", () => {
  const count = (tx, table) => tx.query(`select count(*)::int as n from public.${table}`).then(r => r.rows[0].n);

  test("the owner sees everything in their trip", async () => {
    await as(OWNER, "owner@example.com", async tx => {
      expect(await count(tx, "trips")).toBe(1);
      expect(await count(tx, "members")).toBe(2);
      expect(await count(tx, "trip_viewers")).toBe(1);
    });
  });

  test("an invited viewer can read but not write, and cannot see the viewer list", async () => {
    await as(VIEWER, "Viewer@Example.com", async tx => {
      expect(await count(tx, "trips")).toBe(1);
      expect(await count(tx, "members")).toBe(2);
      expect(await count(tx, "trip_viewers")).toBe(0);
    });
    const insertErr = await as(VIEWER, "viewer@example.com", tx => errorOf(insertExpense(tx, expense())));
    expect(insertErr?.message).toMatch(/row-level security/);
    const updated = await as(VIEWER, "viewer@example.com", tx => tx.query(`update public.members set name = 'Hacked' where id = '${ALICE}'`));
    expect(updated.affectedRows).toBe(0);
  });

  test("a stranger sees nothing and cannot write into someone else's trip", async () => {
    await as(STRANGER, "stranger@example.com", async tx => {
      for (const table of ["trips", "members", "expenses", "transfers", "trip_viewers"]) expect(await count(tx, table)).toBe(0);
    });
    const err = await as(STRANGER, "stranger@example.com", tx => errorOf(
      tx.query(`insert into public.members (id, trip_id, name) values (gen_random_uuid(), '${TRIP}', 'Mallory')`)));
    expect(err?.message).toMatch(/row-level security/);
  });

  test("nobody can create a trip owned by someone else", async () => {
    const err = await as(STRANGER, "stranger@example.com", tx => errorOf(
      tx.query(`insert into public.trips (id, owner_id, name) values (gen_random_uuid(), '${OWNER}', 'Fake')`)));
    expect(err?.message).toMatch(/row-level security/);
  });

  test("hard deletes are not allowed for anyone signed in", async () => {
    const err = await as(OWNER, "owner@example.com", tx => errorOf(tx.query(`delete from public.members where id = '${BOB}'`)));
    expect(err?.message).toMatch(/permission denied/);
  });

  test("a removed viewer loses access", async () => {
    await as(OWNER, "owner@example.com", async tx => {
      await tx.query(`update public.trip_viewers set deleted_at = now() where email = 'viewer@example.com'`);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
        [VIEWER, JSON.stringify({ sub: VIEWER, email: "viewer@example.com" })]);
      expect(await count(tx, "trips")).toBe(0);
    });
  });
});
