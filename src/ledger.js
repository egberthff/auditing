// Pure accounting core: no DOM, no storage. All money is integer cents.

export const SCHEMA_VERSION = 2;

// Parse a user-entered dollar string into integer cents without going through floats.
// Returns NaN for anything that is not a plain amount with at most 2 decimals.
export function toCents(input) {
  const s = String(input ?? "").trim().replace(/,/g, "");
  const m = /^(-)?(?=\d|\.\d)(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return NaN;
  const cents = Number(m[2] || "0") * 100 + Number((m[3] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return NaN; // beyond exact integer range: would lose cents
  return m[1] ? -cents : cents;
}

export function formatAmount(cents) {
  if (typeof cents !== "number" || !isFinite(cents)) return "0.00";
  return (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Split `total` cents across `weights` so the parts are integers summing exactly to `total`.
// Leftover cents go by largest fractional remainder; ties rotate by `seed` so the same
// person does not absorb every rounding cent. seed = 0 reproduces the old index-order split.
export function allocate(total, weights, seed = 0) {
  const n = weights.length;
  const W = weights.reduce((a, b) => a + b, 0);
  if (n === 0 || W <= 0) return weights.map(() => 0);
  const raw = weights.map(w => (total * w) / W);
  const out = raw.map(Math.floor);
  const rem = total - out.reduce((a, b) => a + b, 0);
  const rot = i => (((i - seed) % n) + n) % n;
  const order = raw.map((r, i) => ({ i, f: r - out[i] })).sort((a, b) => b.f - a.f || rot(a.i) - rot(b.i));
  for (let k = 0; k < rem; k++) out[order[k].i]++;
  return out;
}

// Numeric rounding seed from a record id (legacy numeric ids or UUIDs), so the extra
// cent of an uneven split lands on a different member from one record to the next.
export function seedOf(id) {
  if (typeof id === "number" && Number.isSafeInteger(id)) return id;
  return parseInt(String(id ?? "").replace(/[^0-9a-f]/gi, "").slice(-8) || "0", 16) || 0;
}

export function equalShares(total, participants, seed = 0) {
  return allocate(total, participants.map(() => 1), seed);
}

// Greedy settlement: largest debtor pays largest creditor. Iterates every key of `net`
// (not just current people) so balances belonging to removed people still surface.
export function calculateDebts(net) {
  const bal = { ...net };
  const keys = Object.keys(bal);
  const creditors = keys.filter(p => bal[p] > 0).sort((a, b) => bal[b] - bal[a]);
  const debtors = keys.filter(p => bal[p] < 0).sort((a, b) => bal[a] - bal[b]);
  const debts = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci], d = debtors[di];
    const amount = Math.min(bal[c], -bal[d]);
    debts.push({ from: d, to: c, amount });
    bal[c] -= amount;
    bal[d] += amount;
    if (bal[c] === 0) ci++;
    if (bal[d] === 0) di++;
  }
  return debts;
}

// Single source of truth for every balance shown in the UI.
// Each transaction is split equally among its own `participants` (the members on the trip
// when it happened). Former members keep their rows so their history still settles.
export function computeLedger({ people, formerMembers = [], transactions, directDebts }) {
  const rows = new Map(people.map(p => [p, { paid: 0, owed: 0, adj: 0, former: false, orphan: false }]));
  for (const p of formerMembers) if (!rows.has(p)) rows.set(p, { paid: 0, owed: 0, adj: 0, former: true, orphan: false });
  const row = p => {
    if (!rows.has(p)) rows.set(p, { paid: 0, owed: 0, adj: 0, former: false, orphan: true });
    return rows.get(p);
  };
  let totalExpenses = 0;
  for (const t of transactions) {
    totalExpenses += t.amount;
    const parts = t.participants || people;
    const shares = t.shares || equalShares(t.amount, parts);
    parts.forEach((p, i) => { row(p).owed += shares[i] || 0; });
    for (const [p, c] of Object.entries(t.contributions || {})) if (c) row(p).paid += c;
  }
  for (const d of directDebts) {
    // Debt: `from` owes `to`. Payment: `from` paid `to`, so it moves the balances the other way.
    const sign = d.kind === "payment" ? -1 : 1;
    row(d.from).adj -= sign * d.amount;
    row(d.to).adj += sign * d.amount;
  }
  const net = {};
  for (const [p, r] of rows) net[p] = r.paid - r.owed + r.adj;
  return { rows, net, totalExpenses, settlements: calculateDebts(net) };
}

// Invariant checks. Any issue makes the audit invalid.
// `name` and `money` let the UI show member names and the trip currency in messages.
export function auditLedger({ people = [], formerMembers = [], transactions, directDebts }, L, { name = id => id, money = formatAmount } = {}) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  const sum = a => a.reduce((x, y) => x + y, 0);
  const isCents = v => Number.isSafeInteger(v) && v >= 0;
  const seen = new Set();

  for (const p of formerMembers) if (people.includes(p)) add("DUPLICATE_MEMBER", `${name(p)} is listed as both a current and a former member`);
  for (const t of transactions) {
    const label = `"${t.description || t.id}"`;
    if (seen.has(String(t.id))) add("DUPLICATE_ID", `Duplicate transaction id ${t.id}`);
    seen.add(String(t.id));
    if (!isCents(t.amount) || t.amount === 0) add("BAD_AMOUNT", `Transaction ${label} has invalid amount ${t.amount}`);
    const contribs = Object.values(t.contributions || {});
    if (contribs.some(c => !isCents(c))) add("BAD_AMOUNT", `Transaction ${label} has a non-integer or negative contribution`);
    const paid = sum(contribs);
    if (paid !== t.amount) add("TXN_UNBALANCED", `Transaction ${label}: contributions ${money(paid)} ≠ amount ${money(t.amount)}`);
    if (t.shares) {
      if (!t.participants || t.participants.length !== t.shares.length) add("BAD_SHARES", `Transaction ${label}: participants and shares do not line up`);
      else if (sum(t.shares) !== t.amount) add("BAD_SHARES", `Transaction ${label}: shares ${money(sum(t.shares))} ≠ amount ${money(t.amount)}`);
      else if (t.shares.length && Math.max(...t.shares) - Math.min(...t.shares) > 1) add("BAD_SHARES", `Transaction ${label}: shares are not equal`);
    }
    if (t.participants) {
      if (new Set(t.participants).size !== t.participants.length) add("DUPLICATE_PARTICIPANT", `Transaction ${label}: a member is listed more than once`);
      for (const [p, c] of Object.entries(t.contributions || {}))
        if (c > 0 && !t.participants.includes(p)) add("CONTRIBUTOR_NOT_PARTICIPANT", `Transaction ${label}: ${name(p)} paid ${money(c)} but is not sharing this expense`);
    }
  }
  for (const d of directDebts) {
    const what = d.kind === "payment" ? "Payment" : "Direct debt";
    if (seen.has(String(d.id))) add("DUPLICATE_ID", `Duplicate record id ${d.id}`);
    seen.add(String(d.id));
    if (!isCents(d.amount) || d.amount === 0) add("BAD_AMOUNT", `${what} ${name(d.from)} → ${name(d.to)} has invalid amount ${d.amount}`);
    if (d.from === d.to) add("SELF_DEBT", `${what} from ${name(d.from)} to themselves`);
  }
  for (const [p, r] of L.rows) {
    if (r.orphan) add("ORPHAN_PERSON", `${name(p)} is not a current or former member but has a balance of ${money(L.net[p])}`);
  }
  const netSum = sum(Object.values(L.net));
  if (netSum !== 0) add("NET_NONZERO", `Balances do not net to zero (off by ${money(netSum)})`);
  const owedPositive = sum(Object.values(L.net).filter(v => v > 0));
  const settled = sum(L.settlements.map(d => d.amount));
  if (owedPositive !== settled) add("SETTLEMENT_MISMATCH", `Settlements ${money(settled)} ≠ amounts owed ${money(owedPositive)}`);

  return { isValid: issues.length === 0, issues };
}

// A member who joins later but should share every expense so far: add them to each
// existing transaction and re-split it equally. Returns new objects; input is not mutated.
export function addParticipantRetroactively(transactions, name) {
  return transactions.map(t => {
    if (t.participants.includes(name)) return t;
    const participants = [...t.participants, name];
    return {
      ...t,
      participants,
      shares: equalShares(t.amount, participants, seedOf(t.id)),
      contributions: { ...t.contributions, [name]: t.contributions[name] || 0 },
    };
  });
}

// Normalise stored or imported data to the current schema.
// v1 data (no schemaVersion) is snapshotted against the current people list so later
// add/remove of people no longer rewrites history. Data written by the old single-file
// page (auditingpage.html) stored float dollars; it is detected by non-integer amounts.
// Limitation: a legacy dollar dataset made only of whole-dollar values is indistinguishable
// from cents and is kept as-is (the audit will not flag it).
// Names usable as people. "__proto__" cannot be a plain-object key, so it would vanish from the books.
function uniqueNames(list) {
  return [...new Set(list.map(String))].filter(p => p !== "__proto__");
}

const isRecord = x => x !== null && typeof x === "object" && !Array.isArray(x);

// Never throws: anything malformed is dropped or normalised so the app always loads,
// and whatever survives is left for auditLedger to flag.
export function migrateState(data) {
  if (!isRecord(data)) data = {};
  const people = Array.isArray(data.people) ? uniqueNames(data.people) : [];
  const transactions = Array.isArray(data.transactions) ? data.transactions.filter(isRecord) : [];
  const directDebts = Array.isArray(data.directDebts) ? data.directDebts.filter(isRecord) : [];

  // Delete works by id, so every record needs one that no other record has
  const usedIds = new Set();
  let freeId = Math.max(0, ...[...transactions, ...directDebts].map(x => Number(x.id)).filter(Number.isSafeInteger)) + 1;
  const uniqueId = id => {
    const valid = (typeof id === "number" && Number.isSafeInteger(id)) || (typeof id === "string" && id !== "");
    if (valid && !usedIds.has(String(id))) { usedIds.add(String(id)); return id; }
    while (usedIds.has(String(freeId))) freeId++;
    usedIds.add(String(freeId));
    return freeId++;
  };
  const values = [
    ...transactions.map(t => t.amount),
    ...transactions.flatMap(t => (isRecord(t.contributions) ? Object.values(t.contributions) : [])),
    ...directDebts.map(d => d.amount),
  ];
  const legacyDollars = !data.schemaVersion && values.some(v => typeof v === "number" && !Number.isInteger(v));
  const conv = v => (legacyDollars ? toCents(Number(v).toFixed(2)) : Number(v));

  const formerMembers = Array.isArray(data.formerMembers) ? uniqueNames(data.formerMembers).filter(p => !people.includes(p)) : [];

  return {
    schemaVersion: SCHEMA_VERSION,
    people,
    formerMembers,
    transactions: transactions.map(t => {
      const id = uniqueId(t.id);
      const amount = conv(t.amount);
      const contributions = {};
      if (isRecord(t.contributions)) for (const [p, c] of Object.entries(t.contributions)) contributions[p] = conv(c || 0);
      let participants = people.slice(), shares;
      if (!Array.isArray(t.participants)) {
        shares = equalShares(amount, participants); // seed 0 matches how v1 split the cents
      } else {
        participants = uniqueNames(t.participants);
        // Keep the stored split unless duplicates had to be removed
        shares = Array.isArray(t.shares) && participants.length === t.participants.length
          ? t.shares
          : equalShares(amount, participants, seedOf(id));
      }
      return { ...t, id, amount, description: String(t.description ?? ""), contributions, participants, shares };
    }),
    directDebts: directDebts.map(d => ({
      ...d, id: uniqueId(d.id), from: String(d.from ?? ""), to: String(d.to ?? ""),
      amount: conv(d.amount), description: String(d.description ?? ""),
    })),
  };
}

