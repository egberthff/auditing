// Keeping splits consistent when the bookkeeper changes membership on one device and records
// expenses on another while offline. Two kinds of correction:
//  * automatic: members billed "from the start" belong in every expense up to when they left.
//    Every device computes exactly the same fix, so the devices agree.
//  * for review: an expense whose members don't match who was on the trip at that time
//    (it depends on device clocks, so the bookkeeper decides: fix the split or keep it).
import { equalShares, seedOf } from "../ledger.js";

const time = iso => Date.parse(iso);
const whenOf = expense => time(expense.occurredAt ?? expense.createdAt);
const byJoinOrder = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id);

// When the member was on the trip. Records from before membership history existed get one
// period starting no later than the first expense they share (like the 0002 migration does).
export function periodsFor(member, expenses) {
  if (Array.isArray(member.periods) && member.periods.length) return member.periods;
  const shared = expenses.filter(e => e.participants.includes(member.id)).map(whenOf).filter(Number.isFinite);
  const joined = Math.min(time(member.createdAt) || Infinity, ...shared);
  return [{ joinedAt: Number.isFinite(joined) ? new Date(joined).toISOString() : null, leftAt: member.leftAt ?? null }];
}

// Should `member` share `expense`, given when each happened?
export function memberExpected(member, expense, expenses) {
  if (member.deletedAt) return false;
  const when = whenOf(expense);
  if (member.billFrom === "start") return !member.leftAt || when < time(member.leftAt);
  return periodsFor(member, expenses).some(p =>
    (p.joinedAt == null || time(p.joinedAt) <= when) && (p.leftAt == null || when < time(p.leftAt)));
}

// Same expense, shared by `participants` (split again equally). Used by every device, so equal input gives equal rows.
export function withParticipants(expense, participants) {
  const contributions = {};
  for (const id of participants) contributions[id] = expense.contributions[id] ?? 0;
  // People who paid stay recorded as payers even if they no longer share the cost
  for (const [id, paid] of Object.entries(expense.contributions)) if (paid > 0) contributions[id] = paid;
  return { ...expense, participants, shares: equalShares(expense.amountCents, participants, seedOf(expense.id)), contributions };
}

// Expenses that need a "from the start" member added. Deterministic for the same records.
export function autoFixes({ members, expenses }) {
  const fromStart = members.filter(m => m.billFrom === "start" && !m.deletedAt).sort(byJoinOrder);
  const fixes = [];
  for (const e of expenses) {
    const missing = fromStart.filter(m => !e.participants.includes(m.id) && memberExpected(m, e, expenses));
    if (missing.length) fixes.push(withParticipants(e, [...e.participants, ...missing.map(m => m.id)]));
  }
  return fixes;
}

// Expenses whose sharing doesn't match who was on the trip at the time.
// missing: members who were there but don't share it; extra: members who weren't there, share it,
// and paid nothing towards it. Expenses the bookkeeper confirmed ("Keep as is") are skipped.
export function splitDrift({ members, expenses }) {
  const byId = new Map(members.map(m => [m.id, m]));
  const drift = [];
  for (const e of expenses) {
    if (e.splitConfirmed) continue;
    const missing = members.filter(m => m.billFrom !== "start" && !e.participants.includes(m.id) && memberExpected(m, e, expenses)).sort(byJoinOrder);
    const extra = e.participants.map(id => byId.get(id))
      .filter(m => m && !memberExpected(m, e, expenses) && !((e.contributions[m.id] ?? 0) > 0));
    if (missing.length || extra.length) drift.push({ expense: e, missing, extra });
  }
  return drift;
}

// The corrected expense for one drift entry (missing added, extra removed, split again).
export function correctedSplit(entry) {
  const drop = new Set(entry.extra.map(m => m.id));
  const participants = [...entry.expense.participants.filter(id => !drop.has(id)), ...entry.missing.map(m => m.id)];
  return participants.length ? withParticipants(entry.expense, participants) : null;
}

// One-time local upgrade: give members saved before membership history existed their period,
// computed the same way as the server's 0002 migration (so nothing needs to be re-synced).
export async function fillMissingPeriods(repo) {
  for (const trip of await repo.listTrips({ includeDeleted: true })) {
    const members = await repo.listChildren("members", trip.id, { includeDeleted: true });
    const missing = members.filter(m => !Array.isArray(m.periods) || !m.periods.length);
    if (!missing.length) continue;
    const expenses = await repo.listChildren("expenses", trip.id, { includeDeleted: true });
    await repo.putLocal("members", missing.map(m => ({ ...m, periods: periodsFor(m, expenses) })));
  }
}

// Sync hook: apply the automatic fixes to every trip this account keeps the books for.
// Returns how many expenses were changed (they are queued for sync like any edit).
export async function runAutoFixes(repo, user) {
  let changed = 0;
  for (const trip of await repo.listTrips()) {
    if (trip.ownerId !== user.id) continue;
    const data = await repo.getTripData(trip.id);
    const fixes = data ? autoFixes(data) : [];
    if (fixes.length) {
      await repo.saveBatch(fixes.map(record => ({ table: "expenses", record })));
      changed += fixes.length;
    }
  }
  return changed;
}
