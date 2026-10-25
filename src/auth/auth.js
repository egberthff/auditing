// Email sign-in with a one-time code (or the magic link in the same email).
// The session is kept on the device, so the app keeps working offline after signing in once.
export function createAuth(supabase) {
  const redirectTo = () => `${location.origin}${location.pathname}`;
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
      const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo(), shouldCreateUser: true } });
      if (error) throw new Error(error.message);
      return email;
    },

    async verifyCode(email, rawCode) {
      const token = String(rawCode ?? "").replace(/\s/g, "");
      if (!/^\d{6,10}$/.test(token)) throw new Error("Enter the code from the email.");
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
      if (error) throw new Error(error.message);
      return data.user;
    },

    // "local" scope signs this device out without needing the network
    async signOut() {
      if (supabase) await supabase.auth.signOut({ scope: "local" });
    },
  };
}
