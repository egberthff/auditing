// Fingerprint of a set of rows, computed exactly like public.trip_digest() in the database:
// SHA-256 over "id:updated_at_in_microseconds" for each row, sorted by id, joined with ",".
// Two devices (or a device and the server) hold the same rows iff the fingerprints match.

// Exact microseconds since the epoch from a timestamp string such as
// "2026-10-26T01:02:03.123456+00:00", "2026-10-26T01:02:03.123Z" or "2026-10-26 01:02:03+00".
export function epochMicros(ts) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(String(ts ?? ""));
  if (!m) return null;
  let zone = m[4] ?? "Z";
  if (/^[+-]\d{2}$/.test(zone)) zone += ":00";
  else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const wholeSeconds = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (Number.isNaN(wholeSeconds)) return null;
  return BigInt(wholeSeconds) * 1000n + BigInt((m[3] ?? "").padEnd(6, "0").slice(0, 6));
}

// rows: [{ id, updatedAt }]. Uuids are lowercase hex, so string order equals Postgres uuid order.
export async function digestRows(rows) {
  const text = [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(r => `${r.id}:${epochMicros(r.updatedAt)}`)
    .join(",");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
