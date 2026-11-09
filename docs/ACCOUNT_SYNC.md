# Clearpage optional THIEPN Account sync — v1.2 integration handoff

Status: **DRAFT / NOT ACTIVATED**. Guest app at https://page.thiepn.dev stays unchanged.
This branch is a candidate implementation, not a live Account/Sync launch.

## Architecture

Guest mode is unchanged: local IndexedDB, recovery snapshots, JSON backup, no login.
Account mode uses the *existing* THIEPN Account OAuth 2.1 / PKCE shared session SDK
(pinned from thiepn/account on 2026-11-09). It does NOT implement Google authentication,
new passwords, cross-origin cookies or a new THIEPN user database.

The Account is intentionally a separate local IndexedDB workspace keyed by the
verified canonical `auth.uid()` UUID. Guest pages are never uploaded or imported
without the user's explicit choice. Account mode is itself optional, and cloud
sync requires a further explicit click. Account logout switches back to guest
and leaves local Account and guest drafts intact.

Cloud transport: the canonical THIEPN Account Supabase project's own
`public.clearpage_sync_state` document snapshot, plus a single narrowly
scoped owner-derived, mutation-ID/CAS API. No general Core Sync Protocol v1
rollout is claimed. Each cloud snapshot contains active/trash page data and
no authentication credentials. The app never invokes the service_role key.
The public RLS read policy is bound to both verified UUID and the *exact*
registered Clearpage OAuth client; disconnect and denied basic grants fail closed.
Every write is a server CAS and direct client table updates are revoked.

Cloud payload limit is 10 MiB, separate from local limits. Failed/offline sync
never overwrites local drafts or claims cloud success. A disappearing server
snapshot after an existing synced baseline is a hard conflict, not a blank
account to upload over. Concurrent cross-device edits retain both versions in
clearly named conflict pages; trash and permanent deletion are not silently
reversed by an older device. The latest clean merged state is locally
committed before cloud CAS. No realtime editing, E2EE or background sync guarantee.

## Required operator-only activation

1. Review and apply the **pending SQL** in
   `supabase/20261109_clearpage_optional_sync_PENDING.sql` against the
   **existing THIEPN Account** project only, as a reviewed Account migration.
   This registers the Clearpage app **inactive** and stages private owner
   storage/RLS/CAS. Do not use another Supabase project.
2. Inspect production `auth.oauth_clients` and
   `account_first_party_oauth_clients` for an existing exact
   `THIEPN Clearpage` registration, product origin
   `https://page.thiepn.dev/`, callback
   `https://page.thiepn.dev/auth/callback/`. As of this implementation,
   no matching client was found. If one appears, reconcile it; do not
   create a duplicate.
3. Use thiepn/account's **manual-only** first-party OAuth client onboarding:
   register **one** public Authorization Code+refresh client with
   `token_endpoint_auth_method=none`, S256 PKCE, exact callback, then pin the
   UUID to app slug `page` in an idempotent reviewed **Account migration**.
   Set automatic basic identity consent only after review. Never run DCR in
   a push/PR/schedule workflow. Do not edit Account's sign-in frontend.
4. Only then mark the Account app registry `page` active. Verify
   `resolve_thiepn_first_party_sso_probe` returns exact verified origin,
   eligibility and connection handling.
5. Copy the verified **public** client UUID and Supabase **publishable** key
   into `src/config.js` (the default empty values fail closed). Never
   store service_role, client secrets or refresh tokens in repository config.
6. Build with `npm install --ignore-scripts && npm run check`; set the Vercel
   `page` project root build output `dist`, deploy only reviewed green
   code. Confirm `/auth/callback/` routes to the app shell, never an
   unrelated route or service-worker cache.
7. Run manual **disposable-account** end-to-end tests in Chromium, Firefox,
   WebKit and Android. Include login from Account, callback and refresh;
   account switch A→B; cross-account RLS denial; revoke app in Account;
   browser offline/online and full local storage; two-device concurrent
   editing and deletion; crash/timeout during CAS; guest import consent;
   sign out without deleting notes; restore backup; account deletion cascade.
   Do not claim release-ready sync until these gates pass.

## User behavior after activation

Choose `More → THIEPN Account`. Guest writing stays entirely local unless
the user chooses Account. Sign-in uses account.thiepn.dev; after sign-in,
`Enable cloud sync` opts the **current Account workspace** into sync. It
does not copy old guest writing. Use `Copy guest pages` to create new copies
and preserve the originals, then `Sync now` if desired.

Account data is not encrypted end-to-end; THIEPN's server can technically
access unencrypted note text. Never advertise E2EE. Cloud data is tied to the
canonical Account identity and may be deleted through Account lifecycle.

## Known limitations / release blockers

- No Clearpage OAuth public client is registered yet; SDK must remain gated.
- Pending SQL is not applied to production or independently pgTAP tested.
- Browser real-credential and real-CAS two-device acceptance is outstanding.
- TypeScript build and deterministic merge tests are automated; this does not
  substitute for live OAuth, RLS and multi-device verification.
- Only the THIEPN Account project should be touched by future operator
  migration; THIEPN Core remains unchanged and its Sync Protocol v1 is
  still a specification rather than a universal service.
