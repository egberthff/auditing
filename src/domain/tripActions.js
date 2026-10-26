// Every change a bookkeeper can make. Each one validates its input, then writes through the
// repo (local first, queued for sync). Rules mirror the server's checks in 0001_init.sql.
import { equalShares, seedOf } from "../ledger.js";
import { currencyDigits, formatMoney, isValidCurrency } from "../money.js";
import { buildLedger } from "./ledgerState.js";
import { correctedSplit, periodsFor, splitDrift, withParticipants } from "./reconcile.js";

export class UserError extends Error {}
const fail = message => { throw new UserError(message); };
const isMinor = v => Number.isSafeInteger(v) && v >= 0;
const nowIso = () => new Date().toISOString();

// ---- trips -------------------------------------------------------------------

function cleanTripName(name) {
  const clean = String(name ?? "").trim();
  if (!clean) fail("Please enter a trip name.");
  if (clean.length > 100) fail("Trip names can be at most 100 characters.");
  return clean;
}

function cleanCurrency(currency) {
  const code = String(currency ?? "").trim().toUpperCase();
  if (!isValidCurrency(code)) fail(`"${currency}" is not a known 3-letter currency code (for example USD, EUR, PHP).`);
  return code;
}

export async function createTrip(repo, { name, currency = "USD", ownerId = null }) {
  return repo.save("trips", { name: cleanTripName(name), currency: cleanCurrency(currency), ownerId, archived: false });
}

export async function updateTrip(repo, data, { name, currency, archived }) {
  const patch = {};
  if (name !== undefined) patch.name = cleanTripName(name);
  if (archived !== undefined) patch.archived = Boolean(archived);
  if (currency !== undefined) {
    patch.currency = cleanCurrency(currency);
    // Stored amounts are in minor units; switching e.g. USD (cents) to JPY (no decimals) would rescale them
    const hasMoney = data.expenses.length > 0 || data.transfers.length > 0;
    if (hasMoney && currencyDigits(patch.currency) !== currencyDigits(data.trip.currency)) {
      fail(`${patch.currency} uses a different number of decimals than ${data.trip.currency}, so it can't be changed once amounts are recorded.`);
    }
  }
  return repo.update("trips", data.trip.id, patch);
}

export const deleteTrip = (repo, tripId) => repo.softDelete("trips", tripId);
export const restoreTrip = (repo, tripId) => repo.update("trips", tripId, { deletedAt: null });

// ---- members -------------------------------------------------------------------

export function memberHasHistory(data, memberId) {
  return data.expenses.some(e => e.participants.includes(memberId) || (e.contributions[memberId] || 0) > 0)
    || data.transfers.some(t => t.fromMember === memberId || t.toMember === memberId);
}

// billFrom: "join" = only expenses added from now on; "start" = also every existing expense.
export async function addMember(repo, data, rawName, { billFrom = "join" } = {}) {
  const name = String(rawName ?? "").trim();
  if (!name) fail("Please enter a name.");
  if (name.length > 50) fail("Names can be at most 50 characters.");
  if (!["join", "start"].includes(billFrom)) fail("Unknown billing option.");
  const existing = data.members.find(m => m.name.toLowerCase() === name.toLowerCase());
  if (existing && !existing.leftAt) fail(`${existing.name} is already a member.`);

  // Re-adding someone who left brings them back under the same record and spelling,
  // with a new membership period (so the time they were away stays on record)
  const joinedAt = nowIso();
  const member = existing
    ? { ...existing, leftAt: null, billFrom, periods: [...periodsFor(existing, data.expenses), { joinedAt, leftAt: null }] }
    : { id: crypto.randomUUID(), tripId: data.trip.id, name, billFrom, leftAt: null, periods: [{ joinedAt, leftAt: null }] };
  const ops = [{ table: "members", record: member }];
  if (billFrom === "start") {
    for (const e of data.expenses) {
      if (!e.participants.includes(member.id)) ops.push({ table: "expenses", record: withParticipants(e, [...e.participants, member.id]) });
    }
  }
  await repo.saveBatch(ops);
  return { member, rebilled: ops.length - 1 };
}

export async function removeMember(repo, data, memberId) {
  const member = data.members.find(m => m.id === memberId);
  if (!member || member.leftAt) fail("That person is not a current member.");
  if (!memberHasHistory(data, memberId)) {
    await repo.softDelete("members", memberId);
    return "deleted";
  }
  // Keeps their share of past expenses; they are just not billed for new ones
  const leftAt = nowIso();
  const periods = periodsFor(member, data.expenses).map((p, i, all) => (i === all.length - 1 && !p.leftAt ? { ...p, leftAt } : p));
  await repo.update("members", memberId, { leftAt, periods });
  return "left";
}

// ---- expenses -------------------------------------------------------------------

// mode: "equal" (everyone paid their own share), "single" (payerId paid it all),
// "custom" (contributions = { memberId: amount } of what each person actually paid).
export async function addExpense(repo, data, { description, amountCents, mode, payerId = null, contributions: entered = {} }) {
  const money = minor => formatMoney(minor, data.trip.currency);
  const active = data.members.filter(m => !m.leftAt);
  if (!active.length) fail("Add at least one member first.");
  const text = String(description ?? "").trim();
  if (!text) fail("Please describe what was paid for.");
  if (text.length > 200) fail("Descriptions can be at most 200 characters.");
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) fail("Please enter a valid amount.");

  const id = crypto.randomUUID();
  const participants = active.map(m => m.id);
  const shares = equalShares(amountCents, participants, seedOf(id));
  const contributions = Object.fromEntries(participants.map(p => [p, 0]));
  let paidMode;
  if (mode === "equal") {
    paidMode = "equal";
    participants.forEach((p, i) => { contributions[p] = shares[i]; });
    payerId = null;
  } else if (mode === "single") {
    paidMode = "single";
    if (!participants.includes(payerId)) fail("Please select who paid.");
    contributions[payerId] = amountCents;
  } else if (mode === "custom") {
    paidMode = "custom";
    payerId = null;
    let total = 0;
    for (const [memberId, value] of Object.entries(entered)) {
      if (!participants.includes(memberId)) fail("Only current members can pay towards a new expense.");
      if (!isMinor(value)) fail("Each amount paid must be a valid, non-negative amount.");
      contributions[memberId] = value;
      total += value;
    }
    if (total <= 0) fail("At least one person must have paid something.");
    if (total !== amountCents) fail(`The amounts paid add up to ${money(total)}, but the expense is ${money(amountCents)}.`);
  } else {
    fail("Please choose how it was paid.");
  }
  return repo.save("expenses", {
    id, tripId: data.trip.id, description: text, amountCents, paidMode, payerId,
    participants, shares, contributions, occurredAt: nowIso(),
  });
}

export const deleteExpense = (repo, id) => repo.softDelete("expenses", id);

// "Fix split": share the expense among the people who were on the trip at that time.
export async function fixSplit(repo, data, expenseId) {
  const entry = splitDrift(data).find(d => d.expense.id === expenseId);
  if (!entry) fail("This expense no longer needs fixing.");
  const fixed = correctedSplit(entry);
  if (!fixed) fail("Nobody would be left sharing this expense; delete it instead, or keep it as is.");
  return repo.save("expenses", fixed);
}

// "Keep as is": the bookkeeper confirms the split is intended.
export async function keepSplit(repo, data, expenseId) {
  const expense = data.expenses.find(e => e.id === expenseId);
  if (!expense) fail("That expense no longer exists.");
  return repo.save("expenses", { ...expense, splitConfirmed: true });
}

// ---- debts and payments ----------------------------------------------------------

function checkTransferParties(data, from, to) {
  const ids = new Set(data.members.map(m => m.id));
  if (!ids.has(from) || !ids.has(to)) fail("Please choose both people.");
  if (from === to) fail("Choose two different people.");
}

export async function addDebt(repo, data, { from, to, amountCents, description = "" }) {
  checkTransferParties(data, from, to);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) fail("Please enter a valid amount.");
  const text = String(description).trim();
  if (text.length > 200) fail("Descriptions can be at most 200 characters.");
  return repo.save("transfers", {
    tripId: data.trip.id, kind: "debt", fromMember: from, toMember: to, amountCents, description: text, occurredAt: nowIso(),
  });
}

// `from` pays `to` towards a suggested settlement. Checked against the balances as they are
// now, so a stale screen (or another device's change) can't record an over-payment.
export async function recordPayment(repo, data, { from, to, amountCents }) {
  checkTransferParties(data, from, to);
  const { ledger, money, nameOf } = buildLedger(data);
  const owed = ledger.settlements.find(s => s.from === from && s.to === to);
  if (!owed) fail("Balances have changed since this was shown. Please check the updated settlements.");
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) fail("Please enter a valid amount.");
  if (amountCents > owed.amount) fail(`${nameOf(from)} only owes ${nameOf(to)} ${money(owed.amount)}.`);
  return repo.save("transfers", {
    tripId: data.trip.id, kind: "payment", fromMember: from, toMember: to, amountCents,
    description: `${nameOf(from)} paid ${nameOf(to)}`, occurredAt: nowIso(),
  });
}

export const deleteTransfer = (repo, id) => repo.softDelete("transfers", id);

// ---- viewers -------------------------------------------------------------------

export async function addViewer(repo, data, rawEmail) {
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254) fail("Please enter a valid email address.");
  if (data.viewers.some(v => v.email === email)) fail(`${email} can already view this trip.`);
  const removed = (await repo.listChildren("trip_viewers", data.trip.id, { includeDeleted: true })).find(v => v.email === email);
  if (removed) return repo.update("trip_viewers", removed.id, { deletedAt: null });
  return repo.save("trip_viewers", { tripId: data.trip.id, email });
}

export const removeViewer = (repo, id) => repo.softDelete("trip_viewers", id);
