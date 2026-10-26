import "./styles.css";
import { createRepo } from "./store/repo.js";
import { importLegacyLocalData } from "./store/migrateLocal.js";
import { supabase } from "./sync/supabase.js";
import { createSyncEngine } from "./sync/syncEngine.js";
import { createAuth } from "./auth/auth.js";
import { UserError } from "./domain/tripActions.js";
import { fillMissingPeriods, runAutoFixes } from "./domain/reconcile.js";
import { esc, renderPreservingInput, setBanner, toast } from "./ui/dom.js";
import * as tripList from "./ui/tripList.js";
import * as tripView from "./ui/tripView.js";
import * as signIn from "./ui/signIn.js";
import { renderSyncPill, explainSyncProblem } from "./ui/syncStatus.js";

const app = document.getElementById("app");

async function start() {
  let repo;
  try {
    repo = await createRepo();
  } catch (error) {
    // IndexedDB can be unavailable (some private browsing modes, storage disabled)
    app.innerHTML = `<div class="card"><h3>Storage unavailable</h3><p>This browser is blocking local storage, so trips can't be saved.
      Try a normal (non-private) window or allow site data. (${esc(error.message)})</p></div>`;
    return;
  }

  const auth = createAuth(supabase);
  // After every verified sync, members billed "from the start" are added to any expense recorded
  // on another device that didn't know about them yet (same result on every device)
  const sync = createSyncEngine({ repo, supabase, afterSync: user => runAutoFixes(repo, user) });
  const ctx = {
    repo, auth, sync,
    user: await auth.currentUser().catch(() => null),
    rerender: () => queueRender(),
  };

  // Data from the previous single-page version becomes a trip on first run
  const legacy = await importLegacyLocalData(repo);
  await fillMissingPeriods(repo);
  if (legacy?.error) setBanner("appBanner", "⚠ Data from the previous version couldn't be imported automatically. It is still kept in this browser; please contact support or export it from the old version.");
  else if (legacy?.tripId) toast("Your existing data was moved into a trip called “Imported trip”.", "info");

  // ---- routing ----------------------------------------------------------------
  const views = { list: tripList, trip: tripView };
  const route = () => {
    const m = /^#\/trip\/([0-9a-f-]{36})$/i.exec(location.hash);
    return m ? { view: "trip", tripId: m[1] } : { view: "list" };
  };
  let current = route();
  let stopWatching = () => {};
  const watch = () => {
    stopWatching();
    stopWatching = current.view === "trip" ? sync.watchTrip(current.tripId) : () => {};
  };
  window.addEventListener("hashchange", () => { current = route(); watch(); queueRender(); window.scrollTo(0, 0); });

  // ---- rendering ----------------------------------------------------------------
  let renderTimer = null;
  let renderSeq = 0;
  let showingDisplayError = false;
  function queueRender() {
    // A macrotask, so form handlers can reset their form before the screen refreshes
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 0);
  }
  async function render() {
    const seq = ++renderSeq;
    try {
      const view = views[current.view];
      const html = await view.render(ctx, current);
      if (seq !== renderSeq) return; // a newer render started meanwhile
      renderPreservingInput(app, html);
      view.afterRender?.(ctx, app, current);
      if (showingDisplayError) { showingDisplayError = false; setBanner("appBanner", ""); }
    } catch (error) {
      console.error(error);
      showingDisplayError = true;
      setBanner("appBanner", `⚠ Display error: ${esc(error.message)}. Your data is safe; reload the page, and use Export if it keeps happening.`, "danger");
    }
  }

  // ---- events: one delegated listener for every view ------------------------------
  async function run(fn) {
    try {
      await fn();
    } catch (error) {
      if (error instanceof UserError) toast(error.message, "error");
      else { console.error(error); toast(`Something went wrong: ${error.message}`, "error"); }
    }
  }
  document.addEventListener("click", e => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const [scope, name] = el.dataset.action.includes(":") ? el.dataset.action.split(":") : [current.view, el.dataset.action];
    const handler = scope === "signin" ? signIn.actions[name] : scope === "app" ? appActions[name] : views[scope]?.actions?.[name];
    if (!handler) return;
    e.preventDefault();
    run(() => handler(ctx, el, current));
  });
  document.addEventListener("submit", e => {
    const form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    const [scope, name] = form.dataset.form.includes(":") ? form.dataset.form.split(":") : [current.view, form.dataset.form];
    const handler = scope === "signin" ? signIn.forms[name] : views[scope]?.forms?.[name];
    if (handler) run(async () => { if (await handler(ctx, form, current) !== false) form.reset(); });
  });
  document.addEventListener("change", e => views[current.view].onChange?.(ctx, e.target, app));
  document.addEventListener("input", e => views[current.view].onInput?.(ctx, e.target, app));

  // ---- account & sync -------------------------------------------------------------
  const pill = document.getElementById("syncPill");
  sync.subscribe(status => renderSyncPill(pill, status, ctx));
  pill.addEventListener("click", () => run(async () => {
    const status = sync.status;
    if (status.state === "signed-out") return signIn.open(ctx);
    if (status.state === "error" && !confirm(`${explainSyncProblem(status.error)}\n\nTry again now?`)) return;
    await sync.sync();
  }));

  const appActions = {
    signOut: async () => {
      const pending = sync.status.pending;
      const warning = pending
        ? `${pending} change(s) haven't reached the server yet and will be lost if you sign out now. Sign out anyway?`
        : "Sign out? Trips from your account will be removed from this device (they stay safe online).";
      if (!confirm(warning)) return;
      const trips = await repo.listTrips({ includeDeleted: true });
      await repo.purgeTrips(trips.filter(t => t.ownerId).map(t => t.id)); // account data; guest trips stay
      await sync.resetCursors();
      await auth.signOut();
    },
    signIn: async () => signIn.open(ctx),
  };

  function renderAccount() {
    const el = document.getElementById("account");
    if (!auth.available) { el.innerHTML = ""; return; }
    el.innerHTML = ctx.user
      ? `<span class="account-email" title="Signed in">${esc(ctx.user.email)}</span>
         <button type="button" class="link-btn" data-action="app:signOut">Sign out</button>`
      : `<button type="button" class="small-btn" data-action="app:signIn">Sign in to sync</button>`;
  }

  // After signing in, offer to move trips made on this device into the account
  async function offerToClaimGuestTrips() {
    const guest = (await repo.listTrips()).filter(t => !t.ownerId);
    const askedKey = `claimAsked:${ctx.user.id}`;
    if (!guest.length || (await repo.getMeta(askedKey))) return;
    await repo.setMeta(askedKey, true);
    const names = guest.map(t => `• ${t.name}`).join("\n");
    if (confirm(`Upload ${guest.length} trip(s) from this device to your account (${ctx.user.email})?\n\n${names}\n\nYou can also do this later from the trip list.`)) {
      for (const t of guest) await repo.update("trips", t.id, { ownerId: ctx.user.id });
    }
  }

  auth.onChange(async user => {
    const changed = (user?.id ?? null) !== (ctx.user?.id ?? null);
    ctx.user = user;
    renderAccount();
    if (!changed) return;
    if (user) {
      signIn.close();
      await offerToClaimGuestTrips();
    }
    sync.schedule(0);
    queueRender();
  });

  repo.onChange(() => queueRender());

  // ---- offline app updates (service worker) -----------------------------------
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    const { registerSW } = await import("virtual:pwa-register");
    const updateSW = registerSW({
      onNeedRefresh() {
        setBanner("updateBanner", `A new version is available. <button type="button" class="small-btn" id="reloadApp">Update now</button>`, "info");
        document.getElementById("reloadApp").addEventListener("click", () => updateSW(true));
      },
      onOfflineReady() { toast("Ready to work offline.", "info"); },
    });
  }

  renderAccount();
  watch();
  await render();
  if (ctx.user) await offerToClaimGuestTrips();
  sync.start();
}

start();
