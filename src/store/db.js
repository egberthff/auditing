import { openDB } from "idb";
import { TABLES } from "./schema.js";

export const DB_NAME = "travel-audit";

export function openDatabase(name = DB_NAME) {
  return openDB(name, 1, {
    upgrade(db) {
      for (const table of TABLES) {
        const store = db.createObjectStore(table, { keyPath: "id" });
        if (table !== "trips") store.createIndex("tripId", "tripId");
      }
      // Local changes waiting to be pushed, in the order they were made
      db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true }).createIndex("key", "key");
      db.createObjectStore("meta", { keyPath: "key" });
    },
    blocking() {
      // A newer version of the app wants to upgrade the database in another tab
      if (typeof location !== "undefined") location.reload();
    },
  });
}
