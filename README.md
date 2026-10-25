# Travel Audit

Offline-first expense tracking for group and duo travel. Every expense is split **equally among the
members on the trip when it happened**; the split mode only records who actually paid. Works with no
connection, and syncs to Supabase when one is available.

- **Bookkeeper + viewers.** The trip's owner records everything (from any of their devices). People the
  owner shares the trip with can sign in and see balances, read-only.
- **Multiple trips**, each with its own currency, members, archive and restore.
- **Offline first.** Changes are saved on the device immediately (IndexedDB) and queued; the app itself
  is cached by a service worker, so it opens without signal and can be installed to the home screen.
- **Audited books.** The same accounting rules are checked in the app *and* enforced by the database:
  expenses split equally and adding up, contributions matching the amount, balances netting to zero.

## How the accounting works

| Situation | What happens |
|---|---|
| Everyone paid equally | Each member paid their own share; nobody owes anything for it. |
| One person paid | That person paid the total; everyone (including them) owes an equal share. |
| Custom amounts | Several people paid different amounts that add up to the total; still split equally. |
| New member, "only new expenses" | Billed for expenses added after joining. |
| New member, "since the start" | Added to every existing expense, which is re-split equally. |
| Member removed | Not billed for new expenses; keeps their past share so they can still settle up. |
| Debt / payment | A debt is money owed outside shared expenses; "Mark paid" records a payment. |

Amounts are integers in the currency's smallest unit (cents, yen…), so there is no floating-point
rounding; when an amount can't be split evenly the leftover cents go to different people each time.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit + database tests (Vitest, PGlite)
npm run test:e2e     # end-to-end tests on the production build (Playwright, uses installed Chrome)
npm run build        # production build in dist/
```

Without Supabase settings the app runs in **local-only** mode: fully usable, data stays on the device.

## Connecting Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **Database:** open the SQL editor and run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
   (or `supabase db push` with the Supabase CLI). It creates the tables, accounting checks, Row Level
   Security policies and realtime publication.
3. **Auth → Providers → Email:** keep Email enabled. In **Auth → Email templates → Magic link**, include
   the code so it can be typed into the installed app, e.g. `Your code: {{ .Token }}` (the link also works).
4. **Auth → URL configuration:** set the Site URL to your deployed URL and add it plus
   `http://localhost:5173` to the redirect URLs.
5. Copy `.env.example` to `.env.local` and fill in the project URL and **anon** key
   (Project Settings → API). Never use the `service_role` key in the app.

## Deploying

Any static host works; the build is in `dist/`.

- **Netlify:** `netlify.toml` is included (it runs the tests before building). Add `VITE_SUPABASE_URL`
  and `VITE_SUPABASE_ANON_KEY` as environment variables. Security headers come from `public/_headers`.
- **Other hosts:** copy the headers from `public/_headers` into the host's configuration. If you use a
  custom Supabase domain, add it to `connect-src` in the Content-Security-Policy.

## Project layout

```
src/ledger.js              pure accounting (splits, balances, settlements, audit)
src/money.js               parsing/formatting amounts per currency
src/domain/                trip actions, ledger adapter, import/export
src/store/                 IndexedDB store with an outbox of unsynced changes
src/sync/                  Supabase client and the sync engine (push → pull, retries)
src/auth/, src/ui/         sign-in and screens
supabase/migrations/       database schema, checks and security policies
tests/, e2e/               unit, database and end-to-end tests
```

## Sync behaviour

- Every change is written locally together with an outbox entry, in one transaction.
- When online and signed in, the outbox is pushed in order (idempotent upserts), then changes are pulled
  using the server's `updated_at` as a cursor. Network errors retry with backoff (2 s up to 5 min).
- If the server refuses a change (it breaks an accounting rule), syncing pauses and the status pill says
  which record; deleting or fixing it lets sync continue. Nothing is dropped silently.
- If the owner edits the same record on two devices while both are offline, the edit that reaches the
  server last wins.
- Signing out removes account trips from the device (they stay online); unsynced changes trigger a warning.
- Data from the previous single-page version is moved into a trip called "Imported trip" on first start
  (the old browser data is left untouched as a fallback).
