# Clearpage optional THIEPN Account sync — v1.2 integration handoff

Status: **DRAFT / NOT ACTIVATED**. Guest app at https://page.thiepn.dev stays unchanged.
This branch is a candidate implementation, not a live Account/Sync launch.

## Architecture

Guest mode is unchanged: local IndexedDB, recovery snapshots, JSON backup, no login.
Account mode uses the *existing* THIEPN Account OAuth 2.1 / PKCE shared session SDK
(byte-for-byte equivalent to thiepn/account commit `746f4ffe747dfea615c8b3c871a65305ef003b73`, except NodeNext relative import extensions). It does NOT implement Google authentication,
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

**Permanent-deletion conflict handling:** when a page was permanently removed
on one device but simultaneously edited on another, sync now **stops without
writing a merge** and displays an explicit "Permanent deletion conflicts"
message. It neither resurrects a locally purged page nor discards the remote
edit. The remote server may still contain the edited content: permanent
deletion is not complete everywhere until every device has resolved this
conflict. Keep a JSON backup. To honor deletion, delete the updated page
on the other device, sync that device, then retry the original device.
To keep the edited page instead, restore/recreate a new copy after exporting
both device backups; do not assume the conflict automatically resolves.
A future release may offer a dedicated conflict-resolution UI, but no
unreviewed auto-resolution is implemented here.

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
3. In an explicit, operator-supervised registration window, follow
   thiepn/account's **manual-only** first-party OAuth onboarding. Account's
   documented procedure requires the app to be active before registering:
   temporarily activate the staged `page` registry entry immediately before
   registration, and restore `active=false` if registration cannot complete.
   In Supabase Dashboard → **THIEPN Account** → Authentication → OAuth Apps,
   create **exactly one** client named `THIEPN Clearpage`, of type **Public**,
   with client URI `https://page.thiepn.dev/` and one redirect URI
   `https://page.thiepn.dev/auth/callback/`. Configure Authorization Code+refresh with
   `token_endpoint_auth_method=none`, S256 PKCE, exact callback, then pin the
   UUID to app slug `page` in an idempotent reviewed **Account migration**.
   Set automatic basic identity consent only after review. Never run DCR in
   a push/PR/schedule workflow. Do not edit Account's sign-in frontend.
4. Once the UUID has been issued, use the guarded binding template
   `supabase/20261109_clearpage_first_party_BIND_ONLY_AFTER_MANUAL_CLIENT_TEMPLATE.sql`
   as a **reviewed thiepn/account migration** after replacing its deliberately
   invalid UUID sentinel. It validates the public client, exact URI and app
   manifest, pins one binding, and leaves the app active. Do not run it from
   Clearpage CI or on every push. Verify the production SSO probe from the
   exact origin, eligibility, disconnect/reconnect and credential-free browser.
5. Set **only the verified public client UUID** in `src/config.js`.
   The existing THIEPN Account `sb_publishable_` key has already been pinned;
   it is an intentionally public browser key, not a service credential.
   The empty client UUID currently fails closed. Never add service-role keys,
   OAuth client secrets, or refresh tokens to the repository.
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
- Pending SQL and operator binding are **not applied to production**. Both are
  exercised in disposable PostgreSQL 17 CI with synthetic authenticated/anon
  roles, owner RLS, client-ID binding, disconnect/grant revocation, CAS stale
  revisions, idempotency and direct-write denial. This is not live Supabase
  REST or real user/issuer certification.
- Browser real-credential and real-CAS two-device acceptance is outstanding.
  A separate **simulated-HTTP** Chromium scenario now exercises the complete
  compiled sync client over mocked authenticated API requests: two isolated
  browser profiles, first cloud bootstrap, offline pending edits, cross-device
  simultaneous edits, conflict-copy preservation, third-device convergence,
  Account A→B switching, and independent Account B cloud data. This does NOT
  connect to actual users, the OAuth server or production PostgREST.
- Verified CI: deterministic JS merge tests (14), static TypeScript build,
  real Chromium offline/local IndexedDB and A/B local workspace isolation,
  simulated two-device browser network tests, disposable PostgreSQL RLS/CAS
  and operator-binding template, and actual public OAuth discovery/Account
  release reachability. These do **not** prove authenticated OAuth callbacks,
  cross-user live RLS, or real two-device sync.
- Offline editing works after an Account workspace has been opened through
  a verified session. If the browser is fully reloaded offline, the SDK cannot
  reverify identity and currently opens guest mode rather than exposing
  unverified cached Account notes. This is a deliberate privacy/availability
  trade-off and must be made clear to users before activation.
- Only the THIEPN Account project should be touched by future operator
  migration; THIEPN Core remains unchanged and its Sync Protocol v1 is
  still a specification rather than a universal service.
