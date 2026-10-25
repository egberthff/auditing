// Sign-in panel: email → one-time code (the same email also has a magic link).
import { esc, toast } from "./dom.js";

const panel = () => document.getElementById("signIn");
let pendingEmail = null;

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
             <p>We emailed a code to <strong>${esc(pendingEmail)}</strong>. Enter it below, or open the link in the email on this device.</p>
             <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" required maxlength="10" data-no-preserve>
             <button type="submit">Verify code</button>
             <button type="button" class="link-btn" data-action="signin:restart">Use a different email</button>
           </form>`
        : `<form data-form="signin:send" class="inline-form">
             <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required maxlength="254" value="">
             <button type="submit">Email me a sign-in code</button>
           </form>`}
    </div>`;
  panel().hidden = false;
  panel().querySelector("input")?.focus();
}

export function open(ctx) {
  if (!ctx.auth.available) return;
  draw();
}

export function close() {
  pendingEmail = null;
  panel().hidden = true;
  panel().innerHTML = "";
}

export const actions = {
  close: () => close(),
  restart: () => { pendingEmail = null; draw(); },
};

export const forms = {
  async send(ctx, form) {
    if (!navigator.onLine) { toast("You're offline. Connect to the internet to sign in.", "error"); return false; }
    try {
      pendingEmail = await ctx.auth.sendCode(form.email.value);
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
