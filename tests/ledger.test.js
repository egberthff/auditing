import { test } from "vitest";
import assert from "node:assert/strict";
import { toCents, formatAmount, allocate, seedOf, calculateDebts, computeLedger, auditLedger, addParticipantRetroactively, migrateState } from "../src/ledger.js";

const sum = a => a.reduce((x, y) => x + y, 0);

function txn(id, amount, participants, contributions) {
  return { id, amount, participants, shares: allocate(amount, participants.map(() => 1), id), contributions };
}

test("toCents parses exactly and rejects ambiguous input", () => {
  assert.equal(toCents("1.005"), NaN);
  assert.equal(toCents("1,234.56"), 123456);
  assert.equal(toCents("0.1"), 10);
  assert.equal(toCents("19.99"), 1999);
  assert.equal(toCents(".5"), 50);
  assert.equal(toCents("12."), 1200);
  assert.equal(toCents(""), NaN);
  assert.equal(toCents("abc"), NaN);
  assert.equal(toCents("-3.20"), -320);
});

test("formatAmount", () => {
  assert.equal(formatAmount(123456), "1,234.56");
  assert.equal(formatAmount(-5), "-0.05");
  assert.equal(formatAmount(NaN), "0.00");
});

test("allocate sums exactly and spreads rounding cents across seeds", () => {
  for (let total = 0; total < 500; total += 7) {
    for (let n = 1; n <= 6; n++) {
      const parts = allocate(total, Array(n).fill(1), total);
      assert.equal(sum(parts), total);
      assert.ok(parts.every(Number.isInteger));
      assert.ok(Math.max(...parts) - Math.min(...parts) <= 1);
    }
  }
  const extra = [0, 0, 0];
  for (let seed = 0; seed < 300; seed++) allocate(100, [1, 1, 1], seed).forEach((v, i) => { if (v === 34) extra[i]++; });
  assert.deepEqual(extra, [100, 100, 100]);
  assert.deepEqual(allocate(100, [1, 1, 1], 0), [34, 33, 33]); // seed 0 = legacy index order
});

test("review repro: A pays $100, B pays $300 -> A owes B exactly $100", () => {
  const people = ["A", "B"];
  const state = {
    people,
    transactions: [txn(1, 10000, people, { A: 10000, B: 0 }), txn(2, 30000, people, { A: 0, B: 30000 })],
    directDebts: [],
  };
  const L = computeLedger(state);
  assert.deepEqual(L.settlements, [{ from: "A", to: "B", amount: 10000 }]);
  assert.equal(auditLedger(state, L).isValid, true);
});

test("direct debts and payments flow into settlements", () => {
  const people = ["A", "B"];
  const state = {
    people,
    transactions: [txn(1, 10000, people, { A: 10000, B: 0 })],
    directDebts: [{ id: 2, from: "A", to: "B", amount: 2000 }, { id: 3, from: "A", to: "B", amount: 3000 }],
  };
  // B owed A 5000; A owes B 5000 via direct debts -> settled
  assert.deepEqual(computeLedger(state).settlements, []);
});

test("late joiner billed only for new expenses", () => {
  const state = {
    people: ["A", "B", "C"],
    transactions: [txn(1, 10000, ["A", "B"], { A: 10000, B: 0 }), txn(2, 9000, ["A", "B", "C"], { A: 0, B: 0, C: 9000 })],
    directDebts: [],
  };
  const L = computeLedger(state);
  assert.deepEqual(L.net, { A: 2000, B: -8000, C: 6000 });
  assert.deepEqual(L.settlements, [{ from: "B", to: "C", amount: 6000 }, { from: "B", to: "A", amount: 2000 }]);
  assert.equal(auditLedger(state, L).isValid, true);
});

test("late joiner billed for all expenses since the start", () => {
  const before = [txn(1, 9000, ["A", "B"], { A: 9000, B: 0 })];
  const transactions = addParticipantRetroactively(before, "C");
  assert.deepEqual(before[0].participants, ["A", "B"]); // input not mutated
  assert.deepEqual(transactions[0].participants, ["A", "B", "C"]);
  assert.equal(sum(transactions[0].shares), 9000);
  const state = { people: ["A", "B", "C"], transactions, directDebts: [] };
  const L = computeLedger(state);
  assert.deepEqual(L.settlements, [{ from: "B", to: "A", amount: 3000 }, { from: "C", to: "A", amount: 3000 }]);
  assert.equal(auditLedger(state, L).isValid, true);
  // already-included members are left untouched
  assert.equal(addParticipantRetroactively(transactions, "C")[0], transactions[0]);
});

test("removed member stops being billed but keeps their history", () => {
  const state = {
    people: ["A", "B"],
    formerMembers: ["C"],
    transactions: [txn(1, 9000, ["A", "B", "C"], { A: 9000, B: 0, C: 0 }), txn(2, 4000, ["A", "B"], { A: 4000, B: 0 })],
    directDebts: [],
  };
  const L = computeLedger(state);
  assert.equal(L.rows.get("C").former, true);
  assert.deepEqual(L.settlements, [{ from: "B", to: "A", amount: 5000 }, { from: "C", to: "A", amount: 3000 }]);
  assert.equal(auditLedger(state, L).isValid, true);
});

test("audit flags payers who are not sharing the expense and duplicate membership", () => {
  const state = { people: ["A", "B"], formerMembers: ["B"], transactions: [txn(1, 1000, ["A"], { A: 500, B: 500 })], directDebts: [] };
  const codes = auditLedger(state, computeLedger(state)).issues.map(i => i.code);
  assert.ok(codes.includes("CONTRIBUTOR_NOT_PARTICIPANT"));
  assert.ok(codes.includes("DUPLICATE_MEMBER"));
});

test("audit flags orphaned people and unbalanced transactions", () => {
  const state = { people: ["A"], transactions: [txn(1, 10000, ["A", "B"], { A: 10000, B: 0 })], directDebts: [] };
  const codes = auditLedger(state, computeLedger(state)).issues.map(i => i.code);
  assert.ok(codes.includes("ORPHAN_PERSON"));

  const bad = { people: ["A", "B"], transactions: [{ id: 1, amount: 10000, participants: ["A", "B"], shares: [5000, 5000], contributions: { A: 9000 } }], directDebts: [] };
  const badCodes = auditLedger(bad, computeLedger(bad)).issues.map(i => i.code);
  assert.ok(badCodes.includes("TXN_UNBALANCED"));
  assert.ok(badCodes.includes("NET_NONZERO"));
});

test("migrateState converts legacy float-dollar data and snapshots participants", () => {
  const legacy = {
    people: ["A", "B", "C"],
    transactions: [{ id: 1, amount: 10, payer: "", contributions: { A: 3.34, B: 3.33, C: 3.33 } }],
    savings: { A: 1.23 },
  };
  const m = migrateState(legacy);
  assert.equal(m.schemaVersion, 2);
  assert.equal(m.transactions[0].amount, 1000);
  assert.deepEqual(m.transactions[0].contributions, { A: 334, B: 333, C: 333 });
  assert.deepEqual(m.transactions[0].participants, ["A", "B", "C"]);
  assert.deepEqual(m.transactions[0].shares, [334, 333, 333]);
  assert.equal("savings" in m, false);
  const L = computeLedger(m);
  assert.deepEqual(L.settlements, []); // legacy equal split still nets to zero
  assert.equal(auditLedger(m, L).isValid, true);
});

test("migrateState leaves v1 cents data in cents", () => {
  const m = migrateState({ people: ["A", "B"], transactions: [{ id: 1, amount: 1001, contributions: { A: 1001, B: 0 } }] });
  assert.equal(m.transactions[0].amount, 1001);
  assert.deepEqual(m.transactions[0].shares, [501, 500]);
});

test("migrateState removes duplicate and reserved names", () => {
  const m = migrateState({
    schemaVersion: 2,
    people: ["A", "A", "B", "__proto__"],
    formerMembers: ["C", "C", "B", "__proto__"],
    transactions: [{ id: 7, amount: 3001, participants: ["A", "B", "B"], shares: [1000, 1000, 1001], contributions: { A: 3001, B: 0 } }],
  });
  assert.deepEqual(m.people, ["A", "B"]);
  assert.deepEqual(m.formerMembers, ["C"]);
  assert.deepEqual(m.transactions[0].participants, ["A", "B"]);
  assert.equal(sum(m.transactions[0].shares), 3001);
  assert.ok(Math.max(...m.transactions[0].shares) - Math.min(...m.transactions[0].shares) <= 1);
  assert.equal(auditLedger(m, computeLedger(m)).isValid, true);
});

test("audit flags a member listed twice on one expense", () => {
  const state = { people: ["A", "B"], transactions: [{ id: 1, amount: 3000, participants: ["A", "B", "B"], shares: [1000, 1000, 1000], contributions: { A: 3000, B: 0 } }], directDebts: [] };
  const codes = auditLedger(state, computeLedger(state)).issues.map(i => i.code);
  assert.ok(codes.includes("DUPLICATE_PARTICIPANT"));
});

test("toCents rejects amounts beyond exact integer range", () => {
  assert.equal(toCents("90071992547409.91"), 9007199254740991);
  assert.equal(toCents("90071992547409.92"), NaN);
  assert.equal(toCents("1" + "0".repeat(30)), NaN);
});

test("migrateState survives malformed data and gives every record a unique id", () => {
  for (const junk of [null, 42, "x", [], { people: "A", transactions: {}, directDebts: 5 }]) {
    assert.doesNotThrow(() => migrateState(junk));
  }
  const m = migrateState({
    schemaVersion: 2,
    people: ["A", "B"],
    transactions: [
      null, 7, ["array"],
      { id: 5, amount: 1000, participants: ["A", "B"], shares: [500, 500], contributions: { A: 1000 } },
      { id: 5, amount: 2000, participants: ["A", "B"], shares: [1000, 1000], contributions: { B: 2000 } },
      { amount: 300, participants: ["A", "B"], shares: [150, 150], contributions: "broken" },
    ],
    directDebts: [null, { id: 5, from: "A", to: "B", amount: 100 }, { from: "B", to: "A", amount: 100 }],
  });
  assert.equal(m.transactions.length, 3);
  assert.equal(m.directDebts.length, 2);
  const ids = [...m.transactions, ...m.directDebts].map(x => String(x.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(m.transactions[2].contributions, {});
  const audit = auditLedger(m, computeLedger(m));
  assert.ok(audit.issues.some(i => i.code === "TXN_UNBALANCED")); // the broken record is flagged, not hidden
  assert.ok(!audit.issues.some(i => i.code === "DUPLICATE_ID"));
});

test("a payment settles the debt it pays", () => {
  const people = ["A", "B"];
  const state = { people, transactions: [txn(1, 10000, people, { A: 0, B: 10000 })], directDebts: [{ id: 2, kind: "payment", from: "A", to: "B", amount: 5000 }] };
  const L = computeLedger(state);
  assert.deepEqual(L.settlements, []);
  assert.equal(auditLedger(state, L).isValid, true);
});

test("old reversed-debt payments and new payment records give the same balances", () => {
  const people = ["A", "B"];
  const transactions = [txn(1, 10000, people, { A: 0, B: 10000 })];
  const legacy = computeLedger({ people, transactions, directDebts: [{ id: 2, from: "B", to: "A", amount: 3000, description: "Payment: A paid B" }] });
  const modern = computeLedger({ people, transactions, directDebts: [{ id: 2, kind: "payment", from: "A", to: "B", amount: 3000 }] });
  assert.deepEqual(legacy.net, modern.net);
  assert.deepEqual(modern.settlements, [{ from: "A", to: "B", amount: 2000 }]);
});

test("property: random ledgers conserve money and settle in at most n-1 transfers", () => {
  let seed = 42;
  const rnd = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  for (let run = 0; run < 1000; run++) {
    // Simulate a trip: members join (billed from now or from the start) and leave between expenses
    let people = ["P0"], formerMembers = [], transactions = [], next = 1;
    const directDebts = [];
    for (let i = 0; i < rnd(15); i++) {
      const event = rnd(6);
      if (event === 0) {
        const name = `P${next++}`;
        if (rnd(2)) transactions = addParticipantRetroactively(transactions, name);
        people.push(name);
      } else if (event === 1 && people.length > 1) {
        const leaver = people[rnd(people.length)];
        people = people.filter(p => p !== leaver);
        formerMembers.push(leaver);
      }
      const amount = 1 + rnd(100000);
      const weights = people.map(() => rnd(5));
      if (sum(weights) === 0) weights[0] = 1;
      const paid = allocate(amount, weights, i);
      const id = run * 100 + i;
      transactions.push(txn(id, amount, people.slice(), Object.fromEntries(people.map((p, j) => [p, paid[j]]))));
    }
    const everyone = [...people, ...formerMembers];
    for (let i = 0; i < rnd(4) && everyone.length > 1; i++) {
      const a = rnd(everyone.length), b = (a + 1 + rnd(everyone.length - 1)) % everyone.length;
      directDebts.push({ id: `debt-${i}`, from: everyone[a], to: everyone[b], amount: 1 + rnd(5000) });
    }
    const state = { people, formerMembers, transactions, directDebts };
    // Pay off random parts of the current settlements, re-planning after each payment
    for (let k = 0; k < rnd(4); k++) {
      const plan = computeLedger(state).settlements;
      if (plan.length === 0) break;
      const s = plan[rnd(plan.length)];
      directDebts.push({ id: `pay-${k}`, kind: "payment", from: s.from, to: s.to, amount: 1 + rnd(s.amount) });
    }
    const L = computeLedger(state);
    for (const t of transactions) {
      assert.equal(sum(t.shares), t.amount);
      assert.ok(Math.max(...t.shares) - Math.min(...t.shares) <= 1);
    }
    assert.equal(sum(Object.values(L.net)), 0);
    assert.equal(sum(L.settlements.map(d => d.amount)), sum(Object.values(L.net).filter(v => v > 0)));
    assert.ok(L.settlements.every(d => Number.isSafeInteger(d.amount) && d.amount > 0));
    assert.ok(L.settlements.length <= Math.max(0, everyone.length - 1));
    assert.deepEqual(auditLedger(state, L).issues, []);
  }
});

test("calculateDebts includes keys outside the people list", () => {
  assert.deepEqual(calculateDebts({ A: 500, Ghost: -500 }), [{ from: "Ghost", to: "A", amount: 500 }]);
});

test("seedOf gives stable numeric seeds for numeric and UUID ids", () => {
  assert.equal(seedOf(42), 42);
  assert.equal(seedOf("0f8fad5b-d9cb-469f-a165-70867728950e"), 0x7728950e);
  assert.equal(seedOf("zzz-yyy"), 0);
  const counts = [0, 0, 0];
  for (let i = 0; i < 300; i++) allocate(100, [1, 1, 1], seedOf(crypto.randomUUID())).forEach((v, j) => { if (v === 34) counts[j]++; });
  assert.ok(counts.every(c => c > 60), "rounding cent spreads across members: " + counts);
});

test("auditLedger messages use member names and the trip currency", () => {
  const state = { people: ["id-a"], formerMembers: ["id-a"], transactions: [], directDebts: [] };
  const { issues } = auditLedger(state, computeLedger(state), { name: id => ({ "id-a": "Alice" })[id] ?? id, money: c => "¥" + c });
  assert.match(issues[0].message, /^Alice is listed/);
});
