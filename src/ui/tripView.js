import { buildLedger } from "../domain/ledgerState.js";
import * as act from "../domain/tripActions.js";
import { exportTrip } from "../domain/importExport.js";
import { currencyDigits, parseAmount, toInputValue } from "../money.js";
import { esc, formatDateTime, toast } from "./dom.js";
import { roleOf } from "./tripList.js";

const { UserError } = act;

async function load(ctx, tripId) {
  const data = await ctx.repo.getTripData(tripId);
  if (!data) throw new UserError("This trip is no longer available on this device.");
  return data;
}

function amountOrFail(text, currency, what = "amount") {
  const value = parseAmount(text, currency);
  if (!(value > 0)) {
    const digits = currencyDigits(currency);
    throw new UserError(`Please enter a valid ${what}${digits ? ` (up to ${digits} decimal places)` : " (whole numbers only)"}.`);
  }
  return value;
}

// ---- sections ------------------------------------------------------------------------

function headSection(data, role) {
  const roleNote = role === "viewer"
    ? '<p class="hint">👀 You can view this trip. Only its bookkeeper can make changes.</p>'
    : role === "local" ? '<p class="hint">📱 This trip is saved on this device only. Sign in and upload it to back it up and share it.</p>' : "";
  return `
    <div class="card trip-head">
      <a href="#/" class="link-btn">← All trips</a>
      <h2>${esc(data.trip.name)} <span class="badge muted">${esc(data.trip.currency)}</span>
        ${data.trip.archived ? '<span class="badge muted">Archived</span>' : ""}</h2>
      ${roleNote}
    </div>`;
}

function summarySection(data, view) {
  const { ledger, nameOf, money } = view;
  const active = data.members.filter(m => !m.leftAt).length;
  const former = data.members.length - active;
  const outstanding = ledger.settlements.reduce((s, d) => s + d.amount, 0);
  const rows = [...ledger.rows].map(([id, r]) => {
    const net = ledger.net[id];
    const [cls, status] = net > 0 ? ["pos", "Is owed"] : net < 0 ? ["neg", "Owes"] : ["", "Settled"];
    return `<tr>
      <td><strong>${esc(nameOf(id))}</strong>${r.former ? ' <em class="muted-text">(left)</em>' : ""}</td>
      <td>${money(r.paid)}</td><td>${money(r.owed)}</td>
      <td class="${cls}">${net > 0 ? "+" : ""}${money(net)}</td><td>${status}</td></tr>`;
  }).join("");
  return `
    <div class="card">
      <h3>📊 Summary</h3>
      <div class="summary-stats">
        <div class="stat-box"><h4>Total spent</h4><div class="value">${money(ledger.totalExpenses)}</div></div>
        <div class="stat-box"><h4>Members</h4><div class="value">${active}${former ? ` <small>+${former} left</small>` : ""}</div></div>
        <div class="stat-box"><h4>Still to settle</h4><div class="value">${money(outstanding)}</div></div>
      </div>
      ${rows ? `<div class="table-wrap"><table>
        <thead><tr><th>Person</th><th>Paid</th><th>Fair share</th><th>Balance</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="no-data">Add members to get started.</p>'}
      <p class="hint">Fair share = an equal part of every expense made while that person was a member. Balance also includes debts and payments.</p>
    </div>`;
}

function membersSection(data, canEdit) {
  const active = data.members.filter(m => !m.leftAt);
  const former = data.members.filter(m => m.leftAt);
  const tags = [
    ...active.map(m => `<span class="person-tag">${esc(m.name)}${canEdit ? `
      <button type="button" class="tag-x" data-action="removeMember" data-id="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">×</button>` : ""}</span>`),
    ...former.map(m => `<span class="person-tag former" title="Left the trip${canEdit ? ". Add the same name again to bring them back" : ""}.">${esc(m.name)} <em>(left)</em></span>`),
  ].join("");
  return `
    <div class="card">
      <h3>👥 Members</h3>
      ${canEdit ? `
        <form data-form="addMember" class="inline-form">
          <input name="memberName" maxlength="50" placeholder="Name" required autocomplete="off">
          ${data.expenses.length ? `
            <fieldset class="radio-list"><legend>Bill the new member for:</legend>
              <label><input type="radio" name="billFrom" value="join" checked> Only expenses added from now on</label>
              <label><input type="radio" name="billFrom" value="start"> All expenses since the start of the trip</label>
            </fieldset>` : ""}
          <button type="submit">Add member</button>
        </form>` : ""}
      <div class="people-list">${tags || '<p class="no-data">No members yet.</p>'}</div>
    </div>`;
}

function expenseFormSection(data) {
  const active = data.members.filter(m => !m.leftAt);
  if (!active.length) return "";
  const cur = data.trip.currency;
  const placeholder = toInputValue(0, cur);
  return `
    <div class="card">
      <h3>➕ Add expense</h3>
      <form data-form="addExpense" data-currency="${esc(cur)}">
        <div class="form-row">
          <label>Amount (${esc(cur)}) <input name="amount" inputmode="decimal" autocomplete="off" required placeholder="${placeholder}"></label>
          <label>Description <input name="description" maxlength="200" required placeholder="What was it for?" autocomplete="off"></label>
        </div>
        <fieldset class="segmented"><legend>How was it paid?</legend>
          <label><input type="radio" name="paidMode" value="equal" required><span>Everyone paid equally</span></label>
          <label><input type="radio" name="paidMode" value="single"><span>One person paid</span></label>
          <label><input type="radio" name="paidMode" value="custom"><span>Custom amounts</span></label>
        </fieldset>
        <div data-show-for="single" hidden>
          <label>Who paid?
            <select name="payerId"><option value="">Select…</option>${active.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select>
          </label>
        </div>
        <div data-show-for="custom" hidden>
          <p class="hint">Enter what each member actually paid. The amounts must add up to the total.</p>
          ${active.map(m => `<label class="contribution-input">${esc(m.name)}
            <input name="contrib-${esc(m.id)}" inputmode="decimal" autocomplete="off" placeholder="${placeholder}"></label>`).join("")}
          <p class="hint" data-custom-total></p>
        </div>
        <p class="hint">The cost is split equally among the ${active.length} current member${active.length === 1 ? "" : "s"}: ${active.map(m => esc(m.name)).join(", ")}.</p>
        <button type="submit">Add expense</button>
      </form>
    </div>`;
}

function settlementSection(view, canEdit) {
  const { ledger, nameOf, money } = view;
  const rows = ledger.settlements.map(s => `<tr>
    <td><strong>${esc(nameOf(s.from))}</strong></td><td><strong>${esc(nameOf(s.to))}</strong></td>
    <td class="neg">${money(s.amount)}</td>
    ${canEdit ? `<td><button type="button" class="small-btn" data-action="markPaid" data-from="${esc(s.from)}" data-to="${esc(s.to)}">Mark paid</button></td>` : ""}
  </tr>`).join("");
  return `
    <div class="card">
      <h3>💳 Settle up</h3>
      ${rows ? `<div class="table-wrap"><table>
        <thead><tr><th>Who pays</th><th>To whom</th><th>Amount</th>${canEdit ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="ok-text">✓ Everyone is settled.</p>'}
    </div>`;
}

function historySection(data, view, canEdit) {
  const { nameOf, money } = view;
  const rows = [...data.expenses].reverse().map(e => {
    const paid = Object.entries(e.contributions).filter(([, c]) => c > 0).map(([id, c]) => `${esc(nameOf(id))} ${money(c)}`).join(", ");
    const lo = Math.min(...e.shares), hi = Math.max(...e.shares);
    const each = lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`;
    return `<tr>
      <td>${esc(formatDateTime(e.occurredAt))}</td><td>${esc(e.description)}</td><td>${money(e.amountCents)}</td>
      <td class="left">Paid: ${paid}<br><span class="muted-text">Shared by ${e.participants.map(id => esc(nameOf(id))).join(", ")} (${each} each)</span></td>
      ${canEdit ? `<td><button type="button" class="delete-btn" data-action="deleteExpense" data-id="${esc(e.id)}">Delete</button></td>` : ""}
    </tr>`;
  }).join("");
  return `
    <div class="card">
      <h3>📝 Expenses</h3>
      ${rows ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Details</th>${canEdit ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="no-data">No expenses yet.</p>'}
    </div>`;
}

function transfersSection(data, view, canEdit) {
  const { nameOf, money } = view;
  const options = data.members.map(m => `<option value="${esc(m.id)}">${esc(m.name)}${m.leftAt ? " (left)" : ""}</option>`).join("");
  const rows = [...data.transfers].reverse().map(t => `<tr>
    <td>${esc(formatDateTime(t.occurredAt))}</td>
    <td><strong>${esc(nameOf(t.fromMember))}</strong></td><td><strong>${esc(nameOf(t.toMember))}</strong></td>
    <td>${money(t.amountCents)}</td>
    <td class="left"><strong>${t.kind === "payment" ? "Paid" : "Owes"}</strong>${t.description ? ` · ${esc(t.description)}` : ""}</td>
    ${canEdit ? `<td><button type="button" class="delete-btn" data-action="deleteTransfer" data-id="${esc(t.id)}">Delete</button></td>` : ""}
  </tr>`).join("");
  return `
    <div class="card">
      <h3>🔁 Debts & payments</h3>
      ${canEdit && data.members.length > 1 ? `
        <form data-form="addDebt" class="grid-form">
          <label>Who owes <select name="from" required><option value="">Select…</option>${options}</select></label>
          <label>To whom <select name="to" required><option value="">Select…</option>${options}</select></label>
          <label>Amount (${esc(data.trip.currency)}) <input name="amount" inputmode="decimal" required autocomplete="off"></label>
          <label>Note <input name="note" maxlength="200" placeholder="Optional" autocomplete="off"></label>
          <button type="submit">Add debt</button>
        </form>
        <p class="hint">A debt is money owed outside the shared expenses (e.g. a personal loan). Payments are added with “Mark paid” above.</p>` : ""}
      ${rows ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>From</th><th>To</th><th>Amount</th><th>Type · Note</th>${canEdit ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<p class="no-data">No debts or payments yet.</p>'}
    </div>`;
}

function shareSection(ctx, data, role) {
  if (role === "viewer") return "";
  if (role === "local") {
    return ctx.auth.available ? `
      <div class="card"><h3>🔗 Share</h3>
        <p class="hint">${ctx.user
          ? 'Upload this trip to your account (from the trip list) to share it.'
          : 'Sign in, then upload this trip to your account to back it up and share it read-only.'}</p></div>` : "";
  }
  const viewers = data.viewers.map(v => `<li>${esc(v.email)}
    <button type="button" class="link-btn" data-action="removeViewer" data-id="${esc(v.id)}">Remove</button></li>`).join("");
  return `
    <div class="card">
      <h3>🔗 Share (read-only)</h3>
      <p class="hint">People you add here can sign in with that email and see this trip's balances. They can't change anything.</p>
      <form data-form="addViewer" class="inline-form">
        <input name="email" type="email" placeholder="friend@example.com" required maxlength="254" autocomplete="off">
        <button type="submit">Give view access</button>
      </form>
      ${viewers ? `<ul class="viewer-list">${viewers}</ul>` : '<p class="no-data">Not shared with anyone yet.</p>'}
    </div>`;
}

function settingsSection(data, canEdit) {
  return `
    <div class="card">
      <h3>⚙️ Trip</h3>
      ${canEdit ? `
        <details data-key="settings"><summary>Rename or change currency</summary>
          <form data-form="updateTrip" class="grid-form">
            <label>Trip name <input name="name" required maxlength="100" value="${esc(data.trip.name)}" data-no-preserve></label>
            <label>Currency <input name="currency" required maxlength="3" value="${esc(data.trip.currency)}" class="currency-input" data-no-preserve></label>
            <button type="submit">Save</button>
          </form>
          <p class="hint">Changing the currency only changes the label; amounts are not converted.</p>
        </details>` : ""}
      <div class="control-btns">
        <button type="button" data-action="export">📥 Export trip</button>
        ${canEdit ? `<button type="button" data-action="toggleArchive">${data.trip.archived ? "📂 Unarchive" : "🗄️ Archive"}</button>
        <button type="button" class="danger-btn" data-action="deleteTrip">🗑️ Delete trip</button>` : ""}
      </div>
    </div>`;
}

function auditSection(view) {
  const { audit } = view;
  return `
    <div class="card">
      <h3>🔎 Audit</h3>
      ${audit.isValid
        ? '<p class="ok-text">✓ Valid & reconciled: every expense is split equally, all amounts add up, and balances net to zero.</p>'
        : `<p class="danger-text">⚠ ${audit.issues.length} problem(s) found:</p>
           <ul class="issues">${audit.issues.map(i => `<li><code>${esc(i.code)}</code> ${esc(i.message)}</li>`).join("")}</ul>`}
    </div>`;
}

// ---- view ----------------------------------------------------------------------------

export async function render(ctx, { tripId }) {
  const data = await ctx.repo.getTripData(tripId);
  if (!data) {
    return `<div class="card"><h3>Trip not found</h3>
      <p>This trip isn't on this device${ctx.user ? "" : " (if it was shared with you, sign in first)"}.</p>
      <a href="#/" class="link-btn">← All trips</a></div>`;
  }
  const role = roleOf(data.trip, ctx.user);
  const canEdit = role !== "viewer";
  const view = buildLedger(data);
  return [
    headSection(data, role),
    view.audit.isValid ? "" : `<div class="banner danger">⚠ The audit found ${view.audit.issues.length} problem(s). See “Audit” at the bottom.</div>`,
    summarySection(data, view),
    settlementSection(view, canEdit),
    canEdit ? expenseFormSection(data) : "",
    membersSection(data, canEdit),
    historySection(data, view, canEdit),
    transfersSection(data, view, canEdit),
    shareSection(ctx, data, role),
    settingsSection(data, canEdit),
    auditSection(view),
  ].join("");
}

// Show the payer picker / custom amounts for the chosen payment mode
function syncExpenseForm(container) {
  const form = container.querySelector('form[data-form="addExpense"]');
  if (!form) return;
  const mode = form.querySelector('input[name="paidMode"]:checked')?.value;
  for (const el of form.querySelectorAll("[data-show-for]")) el.hidden = el.dataset.showFor !== mode;
  const totalEl = form.querySelector("[data-custom-total]");
  if (totalEl && mode === "custom") {
    const currency = form.dataset.currency;
    const values = [...form.querySelectorAll('input[name^="contrib-"]')].map(i => (i.value.trim() ? parseAmount(i.value, currency) : 0));
    const amount = parseAmount(form.amount.value, currency);
    const entered = values.reduce((s, v) => s + (Number.isNaN(v) ? 0 : v), 0);
    const fmt = v => toInputValue(v, currency);
    totalEl.textContent = values.some(Number.isNaN)
      ? "One of the amounts isn't a valid number."
      : amount > 0 ? `Entered ${fmt(entered)} of ${fmt(amount)}${entered === amount ? " ✓" : ` (${entered < amount ? "short by" : "over by"} ${fmt(Math.abs(amount - entered))})`}` : "";
  }
}

export function afterRender(ctx, container) {
  syncExpenseForm(container);
}

export function onChange(ctx, target, container) {
  if (target.closest('form[data-form="addExpense"]')) syncExpenseForm(container);
}

export function onInput(ctx, target, container) {
  if (target.closest('form[data-form="addExpense"]')) syncExpenseForm(container);
}

export const forms = {
  async addMember(ctx, form, { tripId }) {
    const data = await load(ctx, tripId);
    const billFrom = form.querySelector('input[name="billFrom"]:checked')?.value ?? "join";
    if (billFrom === "start" && data.expenses.length &&
        !confirm(`${form.memberName.value.trim()} will share every one of the ${data.expenses.length} existing expense(s), and everyone's share of those will be recalculated. Continue?`)) return false;
    const { member, rebilled } = await act.addMember(ctx.repo, data, form.memberName.value, { billFrom });
    toast(rebilled ? `${member.name} added and billed for ${rebilled} past expense(s).` : `${member.name} added.`, "success");
  },

  async addExpense(ctx, form, { tripId }) {
    const data = await load(ctx, tripId);
    const cur = data.trip.currency;
    const amountCents = amountOrFail(form.amount.value, cur);
    const mode = form.querySelector('input[name="paidMode"]:checked')?.value;
    const contributions = {};
    for (const input of form.querySelectorAll('input[name^="contrib-"]')) {
      if (!input.value.trim()) continue;
      const value = parseAmount(input.value, cur);
      if (Number.isNaN(value)) throw new UserError(`“${input.value}” isn't a valid amount.`);
      contributions[input.name.slice("contrib-".length)] = value;
    }
    await act.addExpense(ctx.repo, data, { description: form.description.value, amountCents, mode, payerId: form.payerId?.value || null, contributions });
    toast("Expense added.", "success");
  },

  async addDebt(ctx, form, { tripId }) {
    const data = await load(ctx, tripId);
    await act.addDebt(ctx.repo, data, {
      from: form.from.value, to: form.to.value, amountCents: amountOrFail(form.amount.value, data.trip.currency), description: form.note.value,
    });
    toast("Debt added.", "success");
  },

  async addViewer(ctx, form, { tripId }) {
    const viewer = await act.addViewer(ctx.repo, await load(ctx, tripId), form.email.value);
    toast(`${viewer.email} can now view this trip after signing in.`, "success");
  },

  async updateTrip(ctx, form, { tripId }) {
    await act.updateTrip(ctx.repo, await load(ctx, tripId), { name: form.name.value, currency: form.currency.value });
    toast("Trip updated.", "success");
    return false;
  },
};

export const actions = {
  async removeMember(ctx, el, { tripId }) {
    const data = await load(ctx, tripId);
    const member = data.members.find(m => m.id === el.dataset.id);
    const keeps = act.memberHasHistory(data, member.id);
    if (!confirm(keeps
      ? `${member.name} will not be billed for new expenses. Their share of past expenses and their payments stay, so they can still settle up. Continue?`
      : `Remove ${member.name}?`)) return;
    await act.removeMember(ctx.repo, data, member.id);
  },

  async deleteExpense(ctx, el, { tripId }) {
    const data = await load(ctx, tripId);
    const e = data.expenses.find(x => x.id === el.dataset.id);
    if (!e) return;
    const { money } = buildLedger(data);
    if (confirm(`Delete “${e.description}” (${money(e.amountCents)})?`)) await act.deleteExpense(ctx.repo, e.id);
  },

  async deleteTransfer(ctx, el, { tripId }) {
    const data = await load(ctx, tripId);
    const t = data.transfers.find(x => x.id === el.dataset.id);
    if (!t) return;
    const { money, nameOf } = buildLedger(data);
    const what = t.kind === "payment" ? "payment" : "debt";
    if (confirm(`Delete this ${what}: ${nameOf(t.fromMember)} → ${nameOf(t.toMember)}, ${money(t.amountCents)}?`)) await act.deleteTransfer(ctx.repo, t.id);
  },

  async markPaid(ctx, el, { tripId }) {
    const data = await load(ctx, tripId);
    const { ledger, nameOf, money } = buildLedger(data);
    const { from, to } = el.dataset;
    const owed = ledger.settlements.find(s => s.from === from && s.to === to);
    if (!owed) throw new UserError("Balances have changed since this was shown. Please check the updated settlements.");
    const entered = prompt(`How much did ${nameOf(from)} pay ${nameOf(to)}? (owes ${money(owed.amount)})`, toInputValue(owed.amount, data.trip.currency));
    if (entered === null) return;
    const amountCents = amountOrFail(entered, data.trip.currency, "payment");
    if (!confirm(`Record that ${nameOf(from)} paid ${nameOf(to)} ${money(amountCents)}?`)) return;
    await act.recordPayment(ctx.repo, await load(ctx, tripId), { from, to, amountCents });
    toast("Payment recorded.", "success");
  },

  async removeViewer(ctx, el, { tripId }) {
    const data = await load(ctx, tripId);
    const v = data.viewers.find(x => x.id === el.dataset.id);
    if (v && confirm(`Stop sharing this trip with ${v.email}?`)) await act.removeViewer(ctx.repo, v.id);
  },

  async export(ctx, el, { tripId }) {
    const data = await load(ctx, tripId);
    const blob = new Blob([JSON.stringify(exportTrip(data), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.trip.name.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "trip"}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  async toggleArchive(ctx, el, { tripId }) {
    const data = await load(ctx, tripId);
    await act.updateTrip(ctx.repo, data, { archived: !data.trip.archived });
  },

  async deleteTrip(ctx, el, { tripId }) {
    const data = await load(ctx, tripId);
    if (!confirm(`Delete the trip “${data.trip.name}”? You can restore it from “Recently deleted” in the trip list.`)) return;
    await act.deleteTrip(ctx.repo, tripId);
    location.hash = "#/";
  },
};
