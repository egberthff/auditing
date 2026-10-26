// Synced tables, in dependency order (a row's parent always comes earlier).
// Local records use camelCase; the server uses snake_case with the same column set.
export const TABLES = ["trips", "trip_viewers", "members", "expenses", "transfers"];

export const COLUMNS = {
  trips: ["id", "ownerId", "name", "currency", "archived", "createdAt", "updatedAt", "deletedAt"],
  trip_viewers: ["id", "tripId", "email", "createdAt", "updatedAt", "deletedAt"],
  members: ["id", "tripId", "name", "billFrom", "leftAt", "periods", "createdAt", "updatedAt", "deletedAt"],
  expenses: ["id", "tripId", "description", "amountCents", "paidMode", "payerId", "participants", "shares", "contributions",
    "splitConfirmed", "occurredAt", "createdAt", "updatedAt", "deletedAt"],
  transfers: ["id", "tripId", "kind", "fromMember", "toMember", "amountCents", "description", "occurredAt", "createdAt", "updatedAt", "deletedAt"],
};

const toSnake = key => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

// When a member was on the trip: [{ joinedAt, leftAt }]. Records made before membership history
// existed get one period, from when they were added until they left.
export function periodsOf(member) {
  return Array.isArray(member.periods) && member.periods.length
    ? member.periods
    : [{ joinedAt: member.createdAt ?? null, leftAt: member.leftAt ?? null }];
}

// Fill columns that the database requires but older local records may not have.
function withDefaults(table, record) {
  if (table === "members") return { ...record, periods: periodsOf(record) };
  if (table === "expenses") return { ...record, splitConfirmed: Boolean(record.splitConfirmed) };
  return record;
}

// Server timestamps (updated_at) are set by the database, so they are not sent.
export function toServerRow(table, record) {
  const full = withDefaults(table, record);
  const row = {};
  for (const key of COLUMNS[table]) if (key !== "updatedAt") row[toSnake(key)] = full[key] ?? null;
  return row;
}

export function fromServerRow(table, row) {
  const record = {};
  for (const key of COLUMNS[table]) record[key] = row[toSnake(key)] ?? null;
  if (table === "trips") record.archived = Boolean(record.archived);
  if (table === "expenses") {
    record.amountCents = Number(record.amountCents);
    record.shares = (record.shares || []).map(Number);
    record.participants = record.participants || [];
    record.contributions = record.contributions || {};
  }
  if (table === "transfers") record.amountCents = Number(record.amountCents);
  return withDefaults(table, record);
}

export const tripIdOf = (table, record) => (table === "trips" ? record.id : record.tripId);
