// Offline-first sync between the local repo (IndexedDB) and Supabase.
//
// push: send queued local changes in the order they were made, as idempotent upserts by id.
//       An outbox entry is removed only after the server accepted that record.
// pull: fetch rows changed since the last cursor (server updated_at), page by page, and
//       apply them locally unless the record has a local change still waiting to be pushed.
//
// Each trip has one writer (its owner), so the only conflict is the owner editing the same
// record on two devices while offline; the change that reaches the server last wins.
import { TABLES, fromServerRow, toServerRow, tripIdOf } from "../store/schema.js";

const PAGE_SIZE = 1000;
const PUSH_CHUNK = 200;
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
  const message = error?.message || String(error);
  const network = error instanceof TypeError || /fetch|network|timed? ?out|load failed|offline/i.test(message) || (!code && !status);
  const retryable = network || status >= 500 || status === 408 || status === 429 || code === "PGRST301" || status === 401;
  return new SyncError(message, { retryable, code, status });
}

export function createSyncEngine({ repo, supabase, isOnline = () => globalThis.navigator?.onLine ?? true, timers = globalThis }) {
  const listeners = new Set();
  let status = { state: supabase ? "idle" : "local-only", pending: 0, lastSyncedAt: null, error: null };
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
    await pruneHiddenTrips(user);
  }

  // Trips shared with this user whose access was removed disappear from the device.
  async function pruneHiddenTrips(user) {
    const visible = new Set();
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error, status: httpStatus } = await supabase.from("trips").select("id").order("id").range(from, from + PAGE_SIZE - 1);
      if (error) throw classifyError(error, httpStatus);
      data.forEach(r => visible.add(r.id));
      if (data.length < PAGE_SIZE) break;
    }
    const local = await repo.listTrips({ includeDeleted: true });
    const hidden = local.filter(t => t.ownerId && t.ownerId !== user.id && !visible.has(t.id)).map(t => t.id);
    if (hidden.length) await repo.purgeTrips(hidden);
  }

  async function runOnce() {
    let user = null;
    try { user = await currentUser(); } catch { /* treated as signed out */ }
    lastUser = user;
    await refreshPending(user);
    if (!supabase) return emit({ state: "local-only" });
    if (!user) return emit({ state: "signed-out", error: null });
    if (!isOnline()) return emit({ state: "offline", error: null });
    emit({ state: "syncing", error: null });
    try {
      await push(user);
      await pull(user);
      failures = 0;
      await refreshPending(user);
      emit({ state: "synced", lastSyncedAt: new Date().toISOString(), error: null });
    } catch (e) {
      const error = classifyError(e);
      await refreshPending(user).catch(() => {});
      if (error.retryable) {
        failures++;
        emit({ state: "retrying", error });
        schedule(Math.min(2000 * 2 ** (failures - 1), MAX_BACKOFF_MS));
      } else {
        emit({ state: "error", error });
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
      cleanups.push(() => {
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
