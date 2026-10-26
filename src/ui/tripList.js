import { buildLedger } from "../domain/ledgerState.js";
import { createTrip, restoreTrip, UserError } from "../domain/tripActions.js";
import { importFile } from "../domain/importExport.js";
import { splitDrift } from "../domain/reconcile.js";
import { esc, formatDateTime, toast } from "./dom.js";

const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "PHP", "JPY", "AUD", "CAD", "SGD", "THB", "IDR", "INR", "KRW", "CNY", "HKD", "NZD", "CHF", "MXN", "AED", "MYR", "VND"];

export const roleOf = (trip, user) => (!trip.ownerId ? "local" : trip.ownerId === user?.id ? "owner" : "viewer");

function roleBadge(role) {
  if (role === "viewer") return '<span class="badge muted">View only</span>';
  if (role === "local") return '<span class="badge warning" title="Not backed up online yet">On this device only</span>';
  return "";
}

async function tripCard(ctx, trip) {
  const role = roleOf(trip, ctx.user);
  const data = await ctx.repo.getTripData(trip.id);
  const { ledger, audit, money } = buildLedger(data);
  const active = data.members.filter(m => !m.leftAt).length;
  const owed = ledger.settlements.reduce((s, d) => s + d.amount, 0);
  const editable = role !== "viewer";
  return `
    <li class="trip-item">
      <a class="trip-link" href="#/trip/${esc(trip.id)}">
        <strong>${esc(trip.name)}</strong> ${roleBadge(role)} ${audit.isValid ? "" : '<span class="badge danger">Audit issues</span>'}
        ${splitDrift(data).length ? '<span class="badge warning">Needs review</span>' : ""}
        <span class="trip-meta">${active} member${active === 1 ? "" : "s"} · ${money(ledger.totalExpenses)} spent${owed ? ` · ${money(owed)} to settle` : " · settled"}</span>
      </a>
      <span class="trip-actions">
        ${role === "local" && ctx.user ? `<button type="button" class="small-btn" data-action="upload" data-id="${esc(trip.id)}">Upload to my account</button>` : ""}
        ${editable ? `<button type="button" class="link-btn" data-action="${trip.archived ? "unarchive" : "archive"}" data-id="${esc(trip.id)}">${trip.archived ? "Unarchive" : "Archive"}</button>` : ""}
      </span>
    </li>`;
}

export async function render(ctx) {
  const trips = await ctx.repo.listTrips({ includeDeleted: true });
  const live = trips.filter(t => !t.deletedAt);
  const current = live.filter(t => !t.archived);
  const archived = live.filter(t => t.archived);
  const deleted = trips.filter(t => t.deletedAt && roleOf(t, ctx.user) !== "viewer");
  const cards = async list => (await Promise.all(list.map(t => tripCard(ctx, t)))).join("");

  return `
    <div class="card">
      <h3>✈️ New trip</h3>
      <form data-form="createTrip" class="grid-form">
        <label>Trip name <input name="name" required maxlength="100" placeholder="e.g. Bali 2026" autocomplete="off"></label>
        <label>Currency <input name="currency" required maxlength="3" value="USD" list="currencies" autocomplete="off" class="currency-input"></label>
        <button type="submit">Create trip</button>
      </form>
      <datalist id="currencies">${COMMON_CURRENCIES.map(c => `<option value="${c}">`).join("")}</datalist>
    </div>

    <div class="card">
      <h3>🧳 Your trips</h3>
      ${current.length
        ? `<ul class="trip-list">${await cards(current)}</ul>`
        : `<p class="no-data">${esc(ctx.sync.status.detail ?? "No trips yet. Create one above.")}</p>`}
      ${archived.length ? `
        <details data-key="archived">
          <summary>Archived trips (${archived.length})</summary>
          <ul class="trip-list">${await cards(archived)}</ul>
        </details>` : ""}
      ${deleted.length ? `
        <details data-key="deleted">
          <summary>Recently deleted (${deleted.length})</summary>
          <ul class="trip-list">${deleted.map(t => `
            <li class="trip-item">
              <span><strong>${esc(t.name)}</strong> <span class="trip-meta">deleted ${esc(formatDateTime(t.deletedAt))}</span></span>
              <button type="button" class="small-btn" data-action="restore" data-id="${esc(t.id)}">Restore</button>
            </li>`).join("")}</ul>
        </details>` : ""}
    </div>

    <div class="card">
      <h3>📤 Import</h3>
      <p class="hint">Import a trip file exported from this app (or from the previous version). It becomes a new trip.</p>
      <label class="file-btn">Choose a file…<input type="file" name="importFile" accept=".json,application/json" data-no-preserve hidden></label>
    </div>`;
}

export const forms = {
  async createTrip(ctx, form) {
    const trip = await createTrip(ctx.repo, { name: form.name.value, currency: form.currency.value, ownerId: ctx.user?.id ?? null });
    location.hash = `#/trip/${trip.id}`;
  },
};

export const actions = {
  async archive(ctx, el) { await ctx.repo.update("trips", el.dataset.id, { archived: true }); },
  async unarchive(ctx, el) { await ctx.repo.update("trips", el.dataset.id, { archived: false }); },
  async restore(ctx, el) { await restoreTrip(ctx.repo, el.dataset.id); toast("Trip restored."); },
  async upload(ctx, el) {
    const trip = await ctx.repo.get("trips", el.dataset.id);
    if (!ctx.user) throw new UserError("Sign in first.");
    if (!confirm(`Upload “${trip.name}” to your account (${ctx.user.email})? It will then sync to your other devices and can be shared.`)) return;
    await ctx.repo.update("trips", trip.id, { ownerId: ctx.user.id });
  },
};

export async function onChange(ctx, target) {
  if (target.name !== "importFile" || !target.files?.[0]) return;
  const file = target.files[0];
  target.value = "";
  try {
    if (file.size > 20 * 1024 * 1024) throw new UserError("That file is too large to be a trip export.");
    let json;
    try { json = JSON.parse(await file.text()); } catch { throw new UserError("That file isn't valid JSON."); }
    const { tripId, audit } = await importFile(ctx.repo, json, { ownerId: ctx.user?.id ?? null });
    toast(audit.isValid ? "Trip imported." : `Trip imported, but the audit found ${audit.issues.length} problem(s). Please review it.`, audit.isValid ? "success" : "error");
    location.hash = `#/trip/${tripId}`;
  } catch (error) {
    toast(error instanceof UserError ? error.message : `Import failed: ${error.message}`, "error");
  }
}
