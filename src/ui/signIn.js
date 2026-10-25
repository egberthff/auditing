// Sign-in panel: email → one-time code (the same email also has a magic link).
import { esc, toast } from "./dom.js";

const panel = () => document.getElementById("signIn");
let pendingEmail = null;
let sentAt = 0;
let cooldownTimer = null;
const RESEND_AFTER_MS = 60000; // Supabase refuses a new code for the same address within 60 s

const secondsLeft = () => Math.max(0, Math.ceil((sentAt + RESEND_AFTER_MS - Date.now()) / 1000));

// Keep the "Resend code" button label counting down without redrawing the form
function tickCooldown() {
  clearInterval(cooldownTimer);
  const update = () => {
    const btn = panel().querySelector("[data-resend]");
    if (!btn) return clearInterval(cooldownTimer);
    const left = secondsLeft();
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Resend code (${left}s)` : "Resend code";
    if (!left) clearInterval(cooldownTimer);
  };
  update();
  cooldownTimer = setInterval(update, 1000);
}

function draw() {
  const offline = !navigator.onLine;
  panel().innerHTML = `
    <div class="card signin-card">
      <div class="card-head">
        <h3>🔐 Sign in to sync</h3>
        <button type="button" class="link-btn" data-action="signin:close">Close</button>
      </div>
      <p class="hint">Back up your trips and share them read-only with your group. You only need a connection to sign in;
        after that the app works offline.</p>
      ${offline ? '<p class="hint warning-text">You are offline. Connect to the internet to sign in — your trips stay saved on this device meanwhile.</p>' : ""}
      ${pendingEmail
        ? `<form data-form="signin:verify" class="inline-form">
             <p>We emailed a code to <strong>${esc(pendingEmail)}</strong>. Enter it below, or open the link in the email on this device.
               It can take a minute to arrive; check your spam folder too.</p>
             <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" required maxlength="10" data-no-preserve>
             <button type="submit">Verify code</button>
             <button type="button" class="link-btn" data-action="signin:resend" data-resend>Resend code</button>
             <button type="button" class="link-btn" data-action="signin:restart">Use a different email</button>
           </form>`
        : `<form data-form="signin:send" class="inline-form">
             <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required maxlength="254" value="">
             <button type="submit">Email me a sign-in code</button>
           </form>`}
    </div>`;
  panel().hidden = false;
  panel().querySelector("input")?.focus();
  if (pendingEmail) tickCooldown();
}

export function open(ctx) {
  if (!ctx.auth.available) return;
  draw();
}

export function close() {
  pendingEmail = null;
  clearInterval(cooldownTimer);
  panel().hidden = true;
  panel().innerHTML = "";
}

export const actions = {
  close: () => close(),
  restart: () => { pendingEmail = null; draw(); },
  async resend(ctx) {
    if (secondsLeft() > 0) return;
    try {
      await ctx.auth.sendCode(pendingEmail);
      sentAt = Date.now();
      toast("A new code is on its way. Use the code from the newest email.", "success");
    } catch (error) {
      toast(error.message, "error");
    }
    tickCooldown();
  },
};

export const forms = {
  async send(ctx, form) {
    if (!navigator.onLine) { toast("You're offline. Connect to the internet to sign in.", "error"); return false; }
    try {
      pendingEmail = await ctx.auth.sendCode(form.email.value);
      sentAt = Date.now();
    } catch (error) {
      toast(error.message, "error");
      return false;
    }
    draw();
    return false;
  },
  async verify(ctx, form) {
    try {
      await ctx.auth.verifyCode(pendingEmail, form.code.value);
      toast("Signed in. Your trips will now sync.", "success");
      close();
    } catch (error) {
      toast(error.message, "error");
    }
    return false;
  },
};
