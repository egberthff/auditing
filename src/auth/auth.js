// Email sign-in with a one-time code (or the magic link in the same email).
// The session is kept on the device, so the app keeps working offline after signing in once.
// Supabase's raw auth errors are terse; explain the common ones.
export function friendlyAuthError(error) {
  const code = error?.code ?? "";
  const message = error?.message ?? String(error);
  const wait = /after (\d+) seconds?/i.exec(message)?.[1];
  if (wait) return `Please wait ${wait} seconds before requesting another code.`;
  if (error?.status === 429 || /rate.?limit/i.test(code) || /rate limit/i.test(message)) {
    return "Too many sign-in emails have been sent recently, so the server is pausing them. Please try again later. "
      + "(Administrators: the built-in Supabase email service only allows a few emails per hour; set up custom SMTP.)";
  }
  if (code === "otp_expired" || /expired|invalid/i.test(message)) return "That code is wrong or has expired. Request a new code and use the newest email.";
  if (/fetch|network/i.test(message)) return "Couldn't reach the server. Check your connection and try again.";
  return message;
}

export function createAuth(supabase) {
  return {
    available: Boolean(supabase),

    async currentUser() {
      if (!supabase) return null;
      const { data } = await supabase.auth.getSession(); // reads local storage, works offline
      return data?.session?.user ?? null;
    },

    onChange(fn) {
      if (!supabase) return () => {};
      const { data } = supabase.auth.onAuthStateChange((_event, session) => fn(session?.user ?? null));
      return () => data.subscription.unsubscribe();
    },

    async sendCode(rawEmail) {
      const email = String(rawEmail ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("Please enter a valid email address.");
      // No emailRedirectTo: the link in the email goes to the Site URL set in Supabase Auth settings
      const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if (error) throw new Error(friendlyAuthError(error));
      return email;
    },

    async verifyCode(email, rawCode) {
      const token = String(rawCode ?? "").replace(/\s/g, "");
      if (!/^\d{6,10}$/.test(token)) throw new Error("Enter the code from the email.");
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
      if (error) throw new Error(friendlyAuthError(error));
      return data.user;
    },

    // "local" scope signs this device out without needing the network
    async signOut() {
      if (supabase) await supabase.auth.signOut({ scope: "local" });
    },
  };
}
