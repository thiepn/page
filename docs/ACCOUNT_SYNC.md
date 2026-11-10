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

## Operator-only activation and release gates

1. **COMPLETE:** Base Account migration `20261110000901_clearpage_optional_sync_inactive_v12`
   installed into the existing THIEPN Account project. The Account app
   `page` remains inactive with isolated RLS/CAS and no synced user rows.
2. **COMPLETE:** One public OAuth client named `THIEPN Clearpage` was registered
   by the operator on 2026-11-10, UUID
   `088b34ff-84ad-4746-a030-cc517159a17a`. Its only redirect is
   `https://page.thiepn.dev/auth/callback/`, client URI
   `https://page.thiepn.dev/`, grants `authorization_code,refresh_token`,
   token authentication `none`. Production inventory confirms exactly one
   matching active client. **Do not register another.**
3. **COMPLETE / INACTIVE:** Account migration
   `20261110154934_clearpage_public_client_staged_inactive_v12` pins the
   approved UUID to app slug `page` with **binding.active=false** and
   **automatic_identity_consent=false**. The Account app remains **inactive**.
   This exact applied migration is mirrored in draft Account PR #90:
   https://github.com/thiepn/account/pull/90. The public SSO eligibility probe
   returned `null`, and the RLS client guard returned `false` with a synthetic
   authenticated token claiming this UUID. Neither client nor user data was modified
   in the test. Do not rerun a second client registration.
4. **COMPLETE / DRAFT ONLY:** `src/config.js` pins only the public UUID and
   existing public Supabase publishable key. Never store OAuth client secrets,
   service-role keys or refresh tokens in this repository. Guest mode remains
   local-first with opt-in Account sign-in and separately opt-in cloud sync.
5. **PENDING:** A separately reviewed activation transaction, based on
   `supabase/20261109_clearpage_first_party_BIND_ONLY_AFTER_MANUAL_CLIENT_TEMPLATE.sql`,
   may switch the verified client binding, automatic basic identity consent
   and Account app to active **only after authorization to conduct live acceptance**.
   The original template has NOT been applied. Never automatically register
   another OAuth client, merge either draft, deploy Clearpage or release before
   all gates pass.
6. **PENDING:** Run real disposable-account login/callback/refresh, Account
   A→B switching, denied cross-user RLS, app disconnect/revocation and
   reconnect, offline/online plus full local storage, two-device concurrent
   editing and permanent deletion, CAS timeout/recovery, guest import consent,
   backup/restore, and account deletion cascade in Chromium, Firefox, WebKit,
   Android and remote devices. Verify `/auth/callback/` routes to the app
   shell and is not mis-cached by the service worker. The existing Chromium
   two-device HTTP simulation and PostgreSQL CI are NOT live OAuth certification.
7. **NO-GO:** Keep Clearpage PR #1 and Account PR #90 draft/open/unmerged,
   THIEPN Core unchanged, and the public Clearpage v1.1 deployment untouched
   until the evidence and explicit release approvals are complete.

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

- The one public OAuth client exists and is pinned in the draft, but the
  Account app and first-party binding remain deliberately inactive. The
  **staged binding** was applied and verified; the **activation template**
  was NOT applied. Account SSO eligibility and live RLS still deny use,
  so OAuth callback/refresh and real cross-user or two-device acceptance
  have not been certified.
- The **inactive** base migration is installed and verified in production:
  shared identity, isolated user data, RLS enabled, anon SELECT and
  authenticated direct writes denied, zero synced rows. Anonymous,
  unregistered-client and newly registered-but-inactive-client negative
  authorization tests passed; these do not prove live authenticated flows.
- Supabase advisors identify the deliberate authenticated-callable
  `SECURITY DEFINER` guard and CAS functions. These are explicitly guarded
  by owner UUID + exact OAuth client + connected app + required grant;
  review their privilege contract again before activating the client.
- Browser real-credential and real-CAS two-device acceptance is outstanding.
  A separate **simulated-HTTP** Chromium scenario now exercises the complete
  compiled sync client over mocked authenticated API requests: two isolated
  browser profiles, first cloud bootstrap, offline pending edits, cross-device
  simultaneous edits, conflict-copy preservation, third-device convergence,
  Account A→B switching, and independent Account B cloud data. This does NOT
  connect to actual users, the OAuth server or production PostgREST.
- Verified CI: deterministic JS merge tests (17), static TypeScript build,
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
- Only the THIEPN Account project was modified for the inactive schema and binding;
  THIEPN Core remains unchanged and its Sync Protocol v1 is still a
  specification rather than a universal service. The Clearpage PR remains
  draft/unmerged and public Clearpage production remains v1.1.
