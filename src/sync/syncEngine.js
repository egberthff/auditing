// Offline-first sync between the local repo (IndexedDB) and Supabase.
//
// push: send queued local changes in the order they were made, as idempotent upserts by id.
//       An outbox entry is removed only after the server accepted that record.
// pull: fetch rows changed since the last cursor (server updated_at), page by page, and
//       apply them locally unless the record has a local change still waiting to be pushed.
//
// verify: every trip the user can see is checked against a server-side digest; trips that
//       are missing or differ are downloaded again in full, so all devices end up identical.
//
// Each trip has one writer (its owner), so the only conflict is the owner editing the same
// record on two devices while offline; the change that reaches the server last wins, and the
// database keeps deleted records deleted.
import { TABLES, fromServerRow, toServerRow, tripIdOf } from "../store/schema.js";
import { digestRows } from "./digest.js";

const PAGE_SIZE = 1000;
const PUSH_CHUNK = 200;
const TRIP_BATCH = 50; // trips per full download / digest request
const CURSOR_OVERLAP_MS = 5000; // re-read a little so rows committed late are not skipped
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export class SyncError extends Error {
  constructor(message, { retryable, code, status, table, record } = {}) {
    super(message);
    Object.assign(this, { retryable, code, status, table, record });
  }
}

// Network trouble, timeouts, rate limits, server errors and expired tokens are worth retrying.
// Anything else (validation, permissions) needs a person to look at it.
export function classifyError(error, status) {
  if (error instanceof SyncError) return error;
  const code = error?.code ?? "";
  // Unknown column / function: the app is newer than the database schema
  if (["PGRST204", "PGRST202", "42703", "42883"].includes(code)) {
    return new SyncError("The online database needs an update before this version of the app can sync. "
      + "Run the newest file in supabase/migrations in the Supabase SQL editor.", { retryable: false, code, status });
  }
  const message = error?.message || String(error);
  const network = error instanceof TypeError || /fetch|network|timed? ?out|load failed|offline/i.test(message) || (!code && !status);
  const retryable = network || status >= 500 || status === 408 || status === 429 || code === "PGRST301" || status === 401;
  return new SyncError(message, { retryable, code, status });
}

// afterSync(user): optional hook run after each verified pull (e.g. automatic split fixes);
// it returns how many changes it queued, and those are pushed in the same run.
export function createSyncEngine({ repo, supabase, isOnline = () => globalThis.navigator?.onLine ?? true, timers = globalThis, afterSync = null }) {
  const listeners = new Set();
  let status = { state: supabase ? "idle" : "local-only", pending: 0, lastSyncedAt: null, verifiedAt: null, detail: null, error: null };
  let running = null;
  let again = false;
  let timer = null;
  let failures = 0;
  let stopped = false;
  let lastUser = null;
  const cleanups = [];

  const emit = patch => {
    status = { ...status, ...patch };
    for (const fn of listeners) fn(status);
  };

  async function currentUser() {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data?.session?.user ?? null;
  }

  async function ownedTripFilter(user) {
    const trips = await repo.listTrips({ includeDeleted: true });
    const owned = new Set(trips.filter(t => user && t.ownerId === user.id).map(t => t.id));
    return tripId => owned.has(tripId);
  }

  async function refreshPending(user) {
    const owned = user ? await ownedTripFilter(user) : () => true;
    emit({ pending: await repo.pendingCount(owned) });
  }

  async function push(user) {
    const entries = await repo.outboxEntries();
    const isOwned = await ownedTripFilter(user);
    // One item per record, at the position of its first queued change (keeps parents before children)
    const items = [];
    const byKey = new Map();
    for (const e of entries) {
      let item = byKey.get(e.key);
      if (!item) { item = { table: e.table, id: e.id, seqs: [] }; byKey.set(e.key, item); items.push(item); }
      item.seqs.push(e.seq);
    }
    let i = 0;
    while (i < items.length) {
      const table = items[i].table;
      const chunk = [];
      while (i < items.length && items[i].table === table && chunk.length < PUSH_CHUNK) chunk.push(items[i++]);
      const rows = [];
      const done = [];
      for (const item of chunk) {
        const record = await repo.get(table, item.id);
        if (!record) { done.push(...item.seqs); continue; }
        // Trips not (yet) owned by this account stay queued: guest trips upload after sign-in
        if (!isOwned(tripIdOf(table, record))) continue;
        rows.push({ row: toServerRow(table, record), record, seqs: item.seqs });
      }
      if (rows.length) await upsert(table, rows);
      await repo.deleteOutbox([...done, ...rows.flatMap(r => r.seqs)]);
    }
  }

  async function upsert(table, rows) {
    const { error, status: httpStatus } = await supabase.from(table).upsert(rows.map(r => r.row), { onConflict: "id" });
    if (!error) return;
    const failure = classifyError(error, httpStatus);
    if (failure.retryable || rows.length === 1) {
      throw Object.assign(failure, { table, record: rows.length === 1 ? rows[0].record : undefined });
    }
    // Find the record the server refused: push one at a time, so the ones before it still go through
    for (const r of rows) {
      const single = await supabase.from(table).upsert([r.row], { onConflict: "id" });
      if (single.error) throw Object.assign(classifyError(single.error, single.status), { table, record: r.record });
      await repo.deleteOutbox(r.seqs);
    }
  }

  async function pull(user) {
    for (const table of TABLES) {
      const cursorKey = `cursor:${table}`;
      const cursor = await repo.getMeta(cursorKey);
      const since = cursor ? new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS).toISOString() : null;
      let newest = cursor ?? null;
      for (let from = 0; ; from += PAGE_SIZE) {
        let query = supabase.from(table).select("*");
        if (since) query = query.gte("updated_at", since);
        const { data, error, status: httpStatus } = await query
          .order("updated_at", { ascending: true }).order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
        if (error) throw classifyError(error, httpStatus);
        await repo.applyRemote(table, data.map(row => fromServerRow(table, row)));
        for (const row of data) if (!newest || Date.parse(row.updated_at) > Date.parse(newest)) newest = row.updated_at;
        if (data.length < PAGE_SIZE) break;
      }
      if (newest && newest !== cursor) await repo.setMeta(cursorKey, newest);
    }
  }

  const chunksOf = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

  async function fetchAll(table, buildQuery) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error, status: httpStatus } = await buildQuery(supabase.from(table).select("*"))
        .order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
      if (error) throw classifyError(error, httpStatus);
      rows.push(...data);
      if (data.length < PAGE_SIZE) return rows;
    }
  }

  async function visibleTripIds() {
    const ids = new Set();
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error, status: httpStatus } = await supabase.from("trips").select("id").order("id").range(from, from + PAGE_SIZE - 1);
      if (error) throw classifyError(error, httpStatus);
      data.forEach(r => ids.add(r.id));
      if (data.length < PAGE_SIZE) return ids;
    }
  }

  async function localRows(table, tripId) {
    if (table === "trips") {
      const trip = await repo.get("trips", tripId);
      return trip ? [trip] : [];
    }
    return repo.listChildren(table, tripId, { includeDeleted: true });
  }

  async function pendingTripIds() {
    const ids = new Set();
    for (const e of await repo.outboxEntries()) {
      const record = await repo.get(e.table, e.id);
      if (record) ids.add(tripIdOf(e.table, record));
    }
    return ids;
  }

  // Download whole trips regardless of cursors. With prune, local rows the server doesn't
  // have (and that aren't waiting to be pushed) are removed, so the device matches exactly.
  async function downloadTrips(tripIds, { prune = false } = {}) {
    for (const chunk of chunksOf(tripIds, TRIP_BATCH)) {
      for (const table of TABLES) {
        const rows = await fetchAll(table, q => q.in(table === "trips" ? "id" : "trip_id", chunk));
        await repo.applyRemote(table, rows.map(row => fromServerRow(table, row)));
        if (!prune) continue;
        const onServer = new Set(rows.map(r => r.id));
        const stale = [];
        for (const tripId of chunk) for (const r of await localRows(table, tripId)) if (!onServer.has(r.id)) stale.push(r.id);
        await repo.removeLocal(table, stale);
      }
    }
  }

  // Trip ids whose local rows differ from the server's (row count or fingerprint, per table).
  async function mismatchedTrips(tripIds) {
    const bad = [];
    for (const chunk of chunksOf(tripIds, TRIP_BATCH)) {
      const { data, error, status: httpStatus } = await supabase.rpc("trip_digest", { trip_ids: chunk });
      if (error) throw classifyError(error, httpStatus);
      const server = new Map(data.map(d => [`${d.trip_id}:${d.table_name}`, d]));
      for (const tripId of chunk) {
        for (const table of TABLES) {
          const rows = await localRows(table, tripId);
          const remote = server.get(`${tripId}:${table}`);
          const same = rows.length === Number(remote?.row_count ?? 0)
            && (rows.length === 0 || (await digestRows(rows)) === remote.digest);
          if (!same) { bad.push(tripId); break; }
        }
      }
    }
    return bad;
  }

  // Make the trips on this device match what the user can see on the server, and prove that
  // every one of them holds exactly the server's rows.
  async function reconcileTrips(user) {
    const visible = await visibleTripIds();
    const local = await repo.listTrips({ includeDeleted: true });
    const localIds = new Set(local.map(t => t.id));

    // Shared trips whose access was removed disappear from the device
    const hidden = local.filter(t => t.ownerId && t.ownerId !== user.id && !visible.has(t.id)).map(t => t.id);
    if (hidden.length) await repo.purgeTrips(hidden);

    // A new device, or a trip shared after this device last synced: its older rows predate the cursors
    const missing = [...visible].filter(id => !localIds.has(id));
    if (missing.length) {
      emit({ detail: localIds.size ? "Downloading shared trips…" : "Downloading your trips…" });
      await downloadTrips(missing);
    }

    // Trips with unpushed changes are checked on a later run, once those changes are on the server
    const pending = await pendingTripIds();
    const toCheck = [...visible].filter(id => !pending.has(id));
    let bad = await mismatchedTrips(toCheck);
    if (bad.length) {
      emit({ detail: "Repairing differences…" });
      await downloadTrips(bad, { prune: true });
      bad = await mismatchedTrips(bad);
    }
    if (bad.length) {
      throw new SyncError(`${bad.length} trip(s) still differ from the server after downloading them again; retrying.`, { retryable: true });
    }
  }

  async function runOnce() {
    let user = null;
    try { user = await currentUser(); } catch { /* treated as signed out */ }
    lastUser = user;
    await refreshPending(user);
    if (!supabase) return emit({ state: "local-only" });
    if (!user) return emit({ state: "signed-out", error: null });
    if (!isOnline()) return emit({ state: "offline", error: null });
    const firstSync = !(await repo.getMeta("cursor:trips"));
    emit({ state: "syncing", error: null, detail: firstSync ? "Downloading your trips…" : null });
    try {
      for (let round = 0; round < 3; round++) {
        await push(user);
        await pull(user);
        await reconcileTrips(user);
        // Hooks may queue follow-up changes (e.g. split fixes); push those in this same run
        const queued = afterSync ? await afterSync(user) : 0;
        if (!queued) break;
      }
      failures = 0;
      await refreshPending(user);
      const at = new Date().toISOString();
      emit({ state: "synced", lastSyncedAt: at, verifiedAt: status.pending ? status.verifiedAt : at, detail: null, error: null });
    } catch (e) {
      const error = classifyError(e);
      await refreshPending(user).catch(() => {});
      if (error.retryable) {
        failures++;
        emit({ state: "retrying", error, detail: null });
        schedule(Math.min(2000 * 2 ** (failures - 1), MAX_BACKOFF_MS));
      } else {
        emit({ state: "error", error, detail: null });
      }
    }
  }

  function sync() {
    if (stopped) return Promise.resolve(status);
    if (running) { again = true; return running; }
    running = runOnce().finally(() => {
      running = null;
      if (again) { again = false; schedule(0); }
    }).then(() => status);
    return running;
  }

  function schedule(delayMs) {
    if (stopped) return;
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { timer = null; sync(); }, delayMs);
  }

  return {
    get status() { return status; },
    subscribe(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn); },
    sync,
    schedule,
    // Wire up the automatic triggers (browser only)
    start({ intervalMs = 60000, debounceMs = 2000 } = {}) {
      const onWake = () => schedule(0);
      const onVisible = () => { if (globalThis.document?.visibilityState === "visible") schedule(0); };
      globalThis.addEventListener?.("online", onWake);
      globalThis.addEventListener?.("offline", onWake);
      globalThis.document?.addEventListener("visibilitychange", onVisible);
      const interval = timers.setInterval(() => { if (status.state !== "retrying") sync(); }, intervalMs);
      // Local edits: push soon after the person stops typing. Remote/other-tab changes need no push.
      const offChange = repo.onChange(({ source }) => {
        if (source === "local") { if (status.state === "error") emit({ state: "idle", error: null }); schedule(debounceMs); }
        else refreshPending(lastUser).catch(() => {});
      });
      // New or changed trips from the bookkeeper's other devices show up without waiting for the timer
      let tripsChannel = null;
      if (supabase) {
        tripsChannel = supabase.channel("my-trips")
          .on("postgres_changes", { event: "*", schema: "public", table: "trips" }, () => schedule(500));
        tripsChannel.subscribe();
      }
      cleanups.push(() => {
        if (tripsChannel) supabase.removeChannel(tripsChannel);
        globalThis.removeEventListener?.("online", onWake);
        globalThis.removeEventListener?.("offline", onWake);
        globalThis.document?.removeEventListener("visibilitychange", onVisible);
        timers.clearInterval(interval);
        offChange();
      });
      schedule(0);
    },
    // Live updates for one trip while it's open (viewers see the bookkeeper's changes as they happen)
    watchTrip(tripId) {
      if (!supabase || !tripId) return () => {};
      const channel = supabase.channel(`trip-${tripId}`);
      for (const table of ["members", "expenses", "transfers"]) {
        channel.on("postgres_changes", { event: "*", schema: "public", table, filter: `trip_id=eq.${tripId}` }, () => schedule(300));
      }
      channel.on("postgres_changes", { event: "*", schema: "public", table: "trips", filter: `id=eq.${tripId}` }, () => schedule(300));
      channel.subscribe();
      return () => supabase.removeChannel(channel);
    },
    // Forget sync progress, e.g. after signing out, so the next account starts clean
    async resetCursors() {
      await repo.deleteMetaPrefix("cursor:");
    },
    stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      cleanups.splice(0).forEach(fn => fn());
    },
  };
}
