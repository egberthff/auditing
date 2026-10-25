import { auditLedger, computeLedger } from "../ledger.js";
import { formatMoney } from "../money.js";

// Adapt one trip's stored records to the pure ledger (which works on ids and integer amounts).
export function buildLedger({ trip, members, expenses, transfers }) {
  const names = new Map(members.map(m => [m.id, m.name]));
  const nameOf = id => names.get(id) ?? "Unknown member";
  const money = minor => formatMoney(minor, trip.currency);
  const state = {
    people: members.filter(m => !m.leftAt).map(m => m.id),
    formerMembers: members.filter(m => m.leftAt).map(m => m.id),
    transactions: expenses.map(e => ({
      id: e.id, description: e.description, amount: e.amountCents,
      participants: e.participants, shares: e.shares, contributions: e.contributions,
    })),
    directDebts: transfers.map(t => ({
      id: t.id, kind: t.kind, from: t.fromMember, to: t.toMember, amount: t.amountCents, description: t.description,
    })),
  };
  const ledger = computeLedger(state);
  const audit = auditLedger(state, ledger, { name: nameOf, money });
  return { state, ledger, audit, nameOf, money };
}
