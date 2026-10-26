// In-memory stand-in for the parts of supabase-js the sync engine uses. It applies the same
// ownership/visibility rules as the real RLS policies and stamps updated_at like the server.
import { TABLES } from "../../src/store/schema.js";
import { digestRows } from "../../src/sync/digest.js";

const KEEP_DELETED = new Set(["expenses", "transfers", "members"]); // mirrors the keep_deleted() trigger

export function createFakeServer() {
  const tables = Object.fromEntries(TABLES.map(t => [t, new Map()]));
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  return {
    tables,
    offline: false,
    reject: null, // (table, row) => error message, to simulate a database check failing
    stamp() { clock += 7; return new Date(clock).toISOString(); },
    // Let time pass on the server (beyond the pull overlap window)
    advance(ms) { clock += ms; },
    rows(table) { return [...tables[table].values()]; },
  };
}

export function createFakeSupabase(server, user = { id: "owner-1", email: "owner@example.com" }) {
  const session = { user };
  const networkError = { error: { message: "TypeError: Failed to fetch", code: "" }, status: 0, data: null };
  const tripOf = (table, row) => (table === "trips" ? row : server.tables.trips.get(row.trip_id));

  function canRead(table, row) {
    const trip = tripOf(table, row);
    if (!trip || !session.user) return false;
    if (trip.owner_id === session.user.id) return true;
    if (table === "trip_viewers") return false;
    return server.rows("trip_viewers").some(v => v.trip_id === trip.id && !v.deleted_at && v.email === session.user.email);
  }

  function canWrite(table, row) {
    if (!session.user) return false;
    if (table === "trips") {
      const existing = server.tables.trips.get(row.id);
      return row.owner_id === session.user.id && (!existing || existing.owner_id === session.user.id);
    }
    return server.tables.trips.get(row.trip_id)?.owner_id === session.user.id;
  }

  function query(table) {
    const filters = [];
    const orders = [];
    let range = [0, Infinity];
    let columns = "*";
    const q = {
      select(cols = "*") { columns = cols; return q; },
      gte(col, value) { filters.push(r => Date.parse(r[col]) >= Date.parse(value)); return q; },
      in(col, values) { const set = new Set(values); filters.push(r => set.has(r[col])); return q; },
      order(col) { orders.push(col); return q; },
      range(from, to) { range = [from, to]; return q; },
      then(resolve, reject) {
        if (server.offline) return Promise.resolve(networkError).then(resolve, reject);
        let rows = server.rows(table).filter(r => canRead(table, r)).filter(r => filters.every(f => f(r)));
        rows.sort((a, b) => {
          for (const col of orders) {
            const x = col === "updated_at" ? Date.parse(a[col]) : a[col];
            const y = col === "updated_at" ? Date.parse(b[col]) : b[col];
            if (x < y) return -1;
            if (x > y) return 1;
          }
          return 0;
        });
        rows = rows.slice(range[0], range[1] + 1).map(r => (columns === "id" ? { id: r.id } : structuredClone(r)));
        return Promise.resolve({ data: rows, error: null, status: 200 }).then(resolve, reject);
      },
    };
    return q;
  }

  const client = {
    calls: [],
    auth: {
      async getSession() { return { data: { session: session.user ? session : null } }; },
    },
    signOut() { session.user = null; },
    from(table) {
      return {
        select: cols => query(table).select(cols),
        async upsert(rows) {
          client.calls.push({ table, ids: rows.map(r => r.id) });
          if (server.offline) return networkError;
          for (const row of rows) {
            if (!canWrite(table, row)) return { error: { message: "new row violates row-level security policy", code: "42501" }, status: 403 };
            const problem = server.reject?.(table, row);
            if (problem) return { error: { message: problem, code: "23514" }, status: 400 };
          }
          for (const row of rows) {
            const existing = server.tables[table].get(row.id);
            const kept = existing && existing.deleted_at && KEEP_DELETED.has(table) ? existing : row;
            server.tables[table].set(row.id, { ...structuredClone(kept), updated_at: server.stamp() });
          }
          return { error: null, status: 201 };
        },
      };
    },
    async rpc(name, { trip_ids: tripIds }) {
      if (server.offline) return networkError;
      if (name !== "trip_digest") return { data: null, error: { message: "unknown function", code: "PGRST202" }, status: 404 };
      const data = [];
      for (const tripId of tripIds) {
        for (const table of TABLES) {
          const rows = server.rows(table).filter(r => (table === "trips" ? r.id : r.trip_id) === tripId && canRead(table, r));
          if (rows.length) data.push({ trip_id: tripId, table_name: table, row_count: rows.length, digest: await digestRows(rows.map(r => ({ id: r.id, updatedAt: r.updated_at }))) });
        }
      }
      return { data, error: null, status: 200 };
    },
    channel() { return { on() { return this; }, subscribe() { return this; } }; },
    removeChannel() {},
  };
  return client;
}

// Timers that only fire when the test says so
export function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval() { return 0; },
    clearInterval() {},
    lastDelay() { return [...pending.values()].at(-1)?.ms; },
  };
}
