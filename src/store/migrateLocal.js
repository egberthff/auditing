// One-time move of data saved by the previous version (localStorage) into a trip.
// The old localStorage data is left in place as a fallback copy.
import { importLegacy } from "../domain/importExport.js";

const LEGACY_FIELDS = ["schemaVersion", "people", "formerMembers", "transactions", "directDebts"];

function readLegacy(storage) {
  const raw = storage.getItem("travelAudit.v2");
  if (raw !== null) return JSON.parse(raw);
  const data = {};
  let found = false;
  for (const key of LEGACY_FIELDS) {
    const value = storage.getItem(key);
    if (value !== null) { data[key] = JSON.parse(value); found = true; }
  }
  return found ? data : null;
}

// Returns { tripId, audit } when something was imported, null otherwise.
export async function importLegacyLocalData(repo, storage = globalThis.localStorage) {
  if (!storage || (await repo.getMeta("legacyImported"))) return null;
  let result = null;
  try {
    const data = readLegacy(storage);
    const hasData = data && ["people", "transactions", "directDebts", "formerMembers"].some(k => Array.isArray(data[k]) && data[k].length);
    if (hasData) result = await importLegacy(repo, data, { name: "Imported trip" });
  } catch (error) {
    // Unreadable old data stays in localStorage untouched; don't retry on every start
    console.error("Could not import data from the previous version", error);
    result = { error };
  }
  await repo.setMeta("legacyImported", true);
  return result;
}
