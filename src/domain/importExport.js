// Trip export/import, plus conversion of data saved by the previous single-page version.
// Imports always get fresh ids, so importing the same file twice creates two separate trips.
import { equalShares, migrateState, seedOf } from "../ledger.js";
import { isValidCurrency } from "../money.js";
import { buildLedger } from "./ledgerState.js";
import { periodsFor } from "./reconcile.js";
import { UserError } from "./tripActions.js";

export const EXPORT_FORMAT = "travel-audit-trip";

export function exportTrip(data) {
  const strip = ({ tripId, updatedAt, deletedAt, ...rest }) => rest;
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    trip: { name: data.trip.name, currency: data.trip.currency },
    members: data.members.map(strip),
    expenses: data.expenses.map(strip),
    transfers: data.transfers.map(strip),
  };
}

const isRecord = x => x !== null && typeof x === "object" && !Array.isArray(x);
const validDate = v => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

// Writes a whole trip in one atomic batch and reports the audit result for it.
async function writeTrip(repo, { name, currency, ownerId, members, expenses, transfers }) {
  const trip = { id: crypto.randomUUID(), name: String(name).slice(0, 100) || "Imported trip", currency, ownerId, archived: false };
  const withTrip = r => ({ ...r, tripId: trip.id });
  const start = Date.now();
  await repo.saveBatch([
    { table: "trips", record: trip },
    // Members are listed by creation time, so keep the file's order. Without a membership history,
    // a member counts as joined from the first expense they share, so imported splits aren't flagged.
    ...members.map((m, i) => {
      const record = { ...m, createdAt: m.createdAt ?? new Date(start + i).toISOString() };
      return { table: "members", record: withTrip({ ...record, periods: periodsFor(record, expenses) }) };
    }),
    ...expenses.map(e => ({ table: "expenses", record: withTrip(e) })),
    ...transfers.map(t => ({ table: "transfers", record: withTrip(t) })),
  ]);
  const data = await repo.getTripData(trip.id);
  return { tripId: trip.id, audit: buildLedger(data).audit };
}

function importTripExport(repo, file, ownerId) {
  const currency = String(file.trip?.currency ?? "USD").toUpperCase();
  if (!isValidCurrency(currency)) throw new UserError(`The file uses an unknown currency "${currency}".`);
  const list = key => (Array.isArray(file[key]) ? file[key].filter(isRecord) : []);
  const idMap = new Map();
  const members = list("members").map(m => {
    const id = crypto.randomUUID();
    idMap.set(m.id, id);
    return {
      id, name: String(m.name ?? "").trim().slice(0, 50) || "Unnamed",
      billFrom: m.billFrom === "start" ? "start" : "join", leftAt: validDate(m.leftAt), createdAt: validDate(m.createdAt) ?? undefined,
      periods: Array.isArray(m.periods)
        ? m.periods.filter(isRecord).map(p => ({ joinedAt: validDate(p.joinedAt), leftAt: validDate(p.leftAt) }))
        : undefined,
    };
  });
  const mapId = (id, what) => {
    if (!idMap.has(id)) throw new UserError(`The file is damaged: ${what} refers to a member that isn't in the file.`);
    return idMap.get(id);
  };
  const expenses = list("expenses").map(e => {
    const label = `expense "${e.description ?? ""}"`;
    const participants = (Array.isArray(e.participants) ? e.participants : []).map(p => mapId(p, label));
    const contributions = {};
    for (const [p, c] of Object.entries(isRecord(e.contributions) ? e.contributions : {})) contributions[mapId(p, label)] = Number(c);
    return {
      id: crypto.randomUUID(), description: String(e.description ?? "").slice(0, 200), amountCents: Number(e.amountCents),
      paidMode: ["equal", "single", "custom"].includes(e.paidMode) ? e.paidMode : "custom",
      payerId: e.payerId ? mapId(e.payerId, label) : null,
      participants, shares: (Array.isArray(e.shares) ? e.shares : []).map(Number), contributions, splitConfirmed: e.splitConfirmed === true,
      occurredAt: validDate(e.occurredAt) ?? new Date().toISOString(),
    };
  });
  const transfers = list("transfers").map(t => ({
    id: crypto.randomUUID(), kind: t.kind === "payment" ? "payment" : "debt",
    fromMember: mapId(t.fromMember, "a debt or payment"), toMember: mapId(t.toMember, "a debt or payment"),
    amountCents: Number(t.amountCents), description: String(t.description ?? "").slice(0, 200),
    occurredAt: validDate(t.occurredAt) ?? new Date().toISOString(),
  }));
  return writeTrip(repo, { name: file.trip?.name ?? "Imported trip", currency, ownerId, members, expenses, transfers });
}

// `legacy` is the previous app's state ({ people, formerMembers, transactions, directDebts },
// names as keys, integer cents). Anyone referenced who is no longer a member becomes a former member.
export function convertLegacy(legacy) {
  const state = migrateState(legacy);
  const names = new Set([...state.people, ...state.formerMembers]);
  for (const t of state.transactions) {
    t.participants.forEach(p => names.add(p));
    Object.keys(t.contributions).forEach(p => names.add(p));
    if (t.payer) names.add(t.payer);
  }
  for (const d of state.directDebts) { names.add(d.from); names.add(d.to); }
  names.delete("");

  const now = new Date().toISOString();
  const ids = new Map([...names].map(n => [n, crypto.randomUUID()]));
  const members = [...names].map(name => ({
    id: ids.get(name), name: name.slice(0, 50), billFrom: "join", leftAt: state.people.includes(name) ? null : now,
  }));

  const expenses = state.transactions.map(t => {
    const id = crypto.randomUUID();
    const participants = t.participants.map(p => ids.get(p));
    const contributions = {};
    for (const [p, c] of Object.entries(t.contributions)) contributions[ids.get(p)] = c;
    const payers = Object.entries(t.contributions).filter(([, c]) => c > 0);
    const paidEqually = t.shares.length === participants.length && t.participants.every((p, i) => (t.contributions[p] || 0) === t.shares[i]);
    const paidMode = payers.length === 1 && payers[0][1] === t.amount ? "single" : paidEqually ? "equal" : "custom";
    return {
      id, description: String(t.description ?? "").slice(0, 200), amountCents: t.amount, paidMode,
      payerId: paidMode === "single" ? ids.get(payers[0][0]) : null,
      participants,
      // Shares were fixed when the expense was recorded; recompute only if they no longer line up
      shares: t.shares.length === participants.length ? t.shares : equalShares(t.amount, participants, seedOf(id)),
      contributions,
      occurredAt: validDate(t.date) ?? now,
    };
  });

  const transfers = state.directDebts.map(d => {
    // Old "Mark Paid" entries were stored as a reversed debt; store them as the payment they were
    const legacyPayment = d.kind !== "payment" && /^Payment/.test(d.description || "");
    const [from, to] = legacyPayment ? [d.to, d.from] : [d.from, d.to];
    return {
      id: crypto.randomUUID(), kind: d.kind === "payment" || legacyPayment ? "payment" : "debt",
      fromMember: ids.get(from), toMember: ids.get(to), amountCents: d.amount,
      description: String(d.description ?? "").slice(0, 200), occurredAt: validDate(d.date) ?? now,
    };
  });
  return { members, expenses, transfers };
}

export function importLegacy(repo, legacy, { name = "Imported trip", currency = "USD", ownerId = null } = {}) {
  return writeTrip(repo, { name, currency, ownerId, ...convertLegacy(legacy) });
}

// Accepts a trip export from this app or an export file from the previous version.
export async function importFile(repo, json, { ownerId = null } = {}) {
  if (isRecord(json) && json.format === EXPORT_FORMAT) return importTripExport(repo, json, ownerId);
  if (isRecord(json) && Array.isArray(json.people) && Array.isArray(json.transactions)) {
    return importLegacy(repo, json, { name: "Imported trip", ownerId });
  }
  throw new UserError("This is not a Travel Audit export file.");
}
