// Local-first store. Every change is written to IndexedDB together with an outbox entry in
// one transaction, so a change can never be saved without being queued for sync (or vice
// versa). Records coming from the server are applied without touching the outbox.
import { openDatabase } from "./db.js";
import { TABLES, tripIdOf } from "./schema.js";

const CHILD_TABLES = TABLES.filter(t => t !== "trips");
const keyOf = (table, id) => `${table}:${id}`;

export async function createRepo({ dbName, now = () => new Date().toISOString(), channelName = "travel-audit" } = {}) {
  const db = await openDatabase(dbName);
  const events = new EventTarget();
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;

  const notify = (source) => {
    events.dispatchEvent(new CustomEvent("change", { detail: { source } }));
    if (source !== "other-tab") channel?.postMessage("change");
  };
  if (channel) channel.onmessage = () => notify("other-tab");

  function stamp(table, record) {
    const at = now();
    return {
      ...record,
      id: record.id ?? crypto.randomUUID(),
      createdAt: record.createdAt ?? at,
      updatedAt: at,
      deletedAt: record.deletedAt ?? null,
    };
  }

  const repo = {
    events,
    onChange(fn) {
      const handler = e => fn(e.detail);
      events.addEventListener("change", handler);
      return () => events.removeEventListener("change", handler);
    },

    // ---- reads -------------------------------------------------------------
    async get(table, id) {
      return db.get(table, id);
    },

    async listTrips({ includeDeleted = false } = {}) {
      const trips = await db.getAll("trips");
      return trips.filter(t => includeDeleted || !t.deletedAt).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    async listChildren(table, tripId, { includeDeleted = false } = {}) {
      const rows = await db.getAllFromIndex(table, "tripId", tripId);
      return rows.filter(r => includeDeleted || !r.deletedAt);
    },

    async getTripData(tripId) {
      const trip = await db.get("trips", tripId);
      if (!trip || trip.deletedAt) return null;
      const [members, expenses, transfers, viewers] = await Promise.all(
        ["members", "expenses", "transfers", "trip_viewers"].map(t => repo.listChildren(t, tripId)));
      const byTime = (a, b) => String(a.occurredAt ?? a.createdAt).localeCompare(String(b.occurredAt ?? b.createdAt));
      members.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      expenses.sort(byTime);
      transfers.sort(byTime);
      return { trip, members, expenses, transfers, viewers };
    },

    // ---- local writes (always queued for sync) -----------------------------
    // ops: [{ table, record }] written atomically, in order
    async saveBatch(ops) {
      if (!ops.length) return [];
      // Validate everything before the transaction starts, so a bad record can't leave a partial write
      const saved = ops.map(({ table, record }) => {
        if (!TABLES.includes(table)) throw new Error(`Unknown table ${table}`);
        const rec = stamp(table, record);
        if (table !== "trips" && !rec.tripId) throw new Error(`${table} record needs a tripId`);
        return { table, rec };
      });
      const tx = db.transaction([...new Set(ops.map(o => o.table)), "outbox"], "readwrite");
      for (const { table, rec } of saved) {
        tx.objectStore(table).put(rec);
        tx.objectStore("outbox").add({ key: keyOf(table, rec.id), table, id: rec.id, queuedAt: rec.updatedAt });
      }
      await tx.done;
      notify("local");
      return saved.map(s => s.rec);
    },

    async save(table, record) {
      return (await repo.saveBatch([{ table, record }]))[0];
    },

    async update(table, id, patch) {
      const current = await db.get(table, id);
      if (!current) throw new Error(`${table} ${id} not found`);
      return repo.save(table, { ...current, ...patch, id });
    },

    async softDelete(table, id) {
      return repo.update(table, id, { deletedAt: now() });
    },

    // ---- outbox -------------------------------------------------------------
    async outboxEntries() {
      return db.getAll("outbox");
    },

    async deleteOutbox(seqs) {
      if (!seqs.length) return;
      const tx = db.transaction("outbox", "readwrite");
      for (const seq of seqs) tx.store.delete(seq);
      await tx.done;
    },

    // Distinct records waiting to be pushed, optionally only those of some trips
    async pendingCount(tripFilter = () => true) {
      const entries = await db.getAll("outbox");
      const keys = new Set();
      for (const e of entries) {
        const rec = await db.get(e.table, e.id);
        if (rec && tripFilter(tripIdOf(e.table, rec))) keys.add(e.key);
      }
      return keys.size;
    },

    // ---- server changes ----------------------------------------------------
    // A record with a pending local change keeps the local version until it has been pushed.
    async applyRemote(table, records) {
      if (!records.length) return 0;
      const tx = db.transaction([table, "outbox"], "readwrite");
      const keyIndex = tx.objectStore("outbox").index("key");
      let applied = 0;
      for (const rec of records) {
        if (await keyIndex.count(keyOf(table, rec.id))) continue;
        await tx.objectStore(table).put(rec);
        applied++;
      }
      await tx.done;
      if (applied) notify("remote");
      return applied;
    },

    // Write records on this device only, without queuing them for sync (local data upgrades
    // that the server does itself, e.g. in a migration).
    async putLocal(table, records) {
      if (!records.length) return;
      const tx = db.transaction(table, "readwrite");
      for (const rec of records) tx.store.put(rec);
      await tx.done;
      notify("remote");
    },

    // Delete rows from this device only (they no longer exist on the server). Rows with a
    // change waiting to be pushed are kept: that change is newer than what the server has.
    async removeLocal(table, ids) {
      if (!ids.length) return 0;
      const tx = db.transaction([table, "outbox"], "readwrite");
      const keyIndex = tx.objectStore("outbox").index("key");
      let removed = 0;
      for (const id of ids) {
        if (await keyIndex.count(keyOf(table, id))) continue;
        await tx.objectStore(table).delete(id);
        removed++;
      }
      await tx.done;
      if (removed) notify("remote");
      return removed;
    },

    // Remove trips (and everything in them) from this device only, e.g. after access was revoked.
    async purgeTrips(tripIds) {
      if (!tripIds.length) return;
      const tx = db.transaction([...TABLES, "outbox"], "readwrite");
      const purgedKeys = new Set();
      for (const tripId of tripIds) {
        await tx.objectStore("trips").delete(tripId);
        purgedKeys.add(keyOf("trips", tripId));
        for (const table of CHILD_TABLES) {
          const ids = await tx.objectStore(table).index("tripId").getAllKeys(tripId);
          for (const id of ids) { await tx.objectStore(table).delete(id); purgedKeys.add(keyOf(table, id)); }
        }
      }
      let cursor = await tx.objectStore("outbox").openCursor();
      while (cursor) {
        if (purgedKeys.has(cursor.value.key)) await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
      notify("local");
    },

    // ---- meta ----------------------------------------------------------------
    async getMeta(key) {
      return (await db.get("meta", key))?.value;
    },
    async setMeta(key, value) {
      await db.put("meta", { key, value });
    },
    async deleteMetaPrefix(prefix) {
      const keys = await db.getAllKeys("meta");
      const tx = db.transaction("meta", "readwrite");
      for (const k of keys) if (String(k).startsWith(prefix)) tx.store.delete(k);
      await tx.done;
    },

    close() {
      channel?.close();
      db.close();
    },
  };
  return repo;
}
