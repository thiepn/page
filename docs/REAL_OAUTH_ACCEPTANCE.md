# Clearpage v1.2 — controlled real OAuth acceptance (PREPARED / NOT AUTHORIZED)

This document is a proposed **future operator-run test contract**, not permission to activate Account, create users, connect to real OAuth, merge or deploy. Start from Clearpage PR #1 HEAD 72d7d09e20bf333e64acd8b6cc12a4535a9a231f, Account draft PR #90 HEAD 5269d71825f86859f5073bb54ceb88d287f5f80e and the already-passing offline exact-origin Playwright test. The parent PR commits may advance through this documentation change; reverify the new exact head.

## 1. Network boundary: two controls, not one

- The built Clearpage frontend must be served **only from reviewed local dist bytes** to a fresh Playwright context whose page URL remains https://page.thiepn.dev/. Only fixed local assets and the exact /auth/callback/ shell are fulfilled. Do not permit fallback to the real v1.1 site. Set serviceWorkers='block'. The v1.2 Vercel callback rewrite is source-configured but **not deployed or qualified**.
- Real Account issuer and Account UI traffic, if later approved, must be **unmodified** (auth cookies, OAuth code + PKCE, token exchange, owner-authenticated PostgREST, RLS and CAS). Never mock issuer OAuth, Account authentication or remote CRUD. App guest data is never uploaded without user consent.
- **Critical caveat:** Playwright routing alone cannot enforce all redirected network requests. Route handlers can cover the initial request without rechecking every follow-on redirect. Do NOT convert candidate-only decisions in tests/real-oauth-network-policy.mjs into route.continue() permissions. Before live use independently enforce egress with a fail-closed outbound proxy or firewall including redirects, DNS, QUIC/WebSocket and direct connection bypass, then prove unknown/redirected hosts are blocked. Passive event listeners, HAR or CDP logging are NOT substitutes for network containment. Never run the future harness with unrestricted public internet access.
- The pure classifier presently returns **local**, **candidate-only**, or **deny** and sets LIVE_EGRESS_ENABLED=false. It deliberately does not execute network calls. Candidate issuer paths are GET /auth/v1/oauth/authorize (exact UUID and S256), POST /auth/v1/oauth/token, GET /auth/v1/user, GET /rest/v1/clearpage_sync_state (exact read), and POST /rest/v1/rpc/clearpage_sync_cas. Candidate Account paths are GET /sso/probe (bound UUID) and GET /oauth/consent (opaque authorization ID).
- Real Account static assets, account login pages, and any upstream Google identity-provider redirects are **not qualified**. Capture only host/path/method/status in a separate human-operated, credential-free discovery procedure, then review and add narrowly required paths if justified. Never blanket-allow Account /assets/**, Supabase /rest/v1/** or *.google.com, nor copy credentials into GitHub Actions.
- No direct Node HTTP clients, Playwright APIRequestContext, hidden additional browser contexts or Chrome extensions may evade the independently enforced egress gate. Stop on unknown path, non-allowlisted redirect, wrong callback, certificate errors, unexpected client/owner or attempted production Clearpage fallback.

## 2. Disposable people and devices

The operator must first establish **two new, authorized and genuinely disposable Account identities A and B** with distinct verified Auth UUIDs, no personal credentials, notes, unrelated app connections or real-user data. No direct database Auth-user insertion, forged JWT, token replay or silent impersonation. These identities do not exist yet for this test; creation/cleanup is subject to separate approval.

Prepare fresh ephemeral browser contexts A1 and A2 for Account A and B1 for Account B, and a controlled A-to-B switch in one reusable context. Keep profile storage exclusively in temporary memory, use fictional unique notes, and close/delete contexts at end. Human operators sign in with their own disposable account credentials in the authorized flow, never their personal account. No saved storageState, HAR, video, screenshots showing personal data, trace, token, password, cookie, OAuth code/state, PKCE verifier or refresh token. No logging of request bodies, complete URL queries or headers.

## 3. Go/no-go and controlled global activation

**Global production exposure:** activation is a change to the existing public THIEPN Account control plane, not a true isolated staging environment. The public Clearpage OAuth UUID already exists. Although v1.1 has no Account sign-in UI, another client could deliberately initiate an OAuth request while the binding is active. The operator must explicitly accept this residual risk or use a separately authorized staging issuer/client instead.

Before any activation, obtain a separate explicit approval naming the window owner, emergency stop, hard cutoff time, test accounts and allowed changes. Verify healthy project, exact PR SHA and compiled build, one registered public UUID 088b34ff-84ad-4746-a030-cc517159a17a and callback https://page.thiepn.dev/auth/callback/, fixed ACL (authenticated SELECT only, RLS on), guarded CAS callable, app/binding inactive, auto consent false, zero synced rows, counts of preexisting authorizations, sessions, grants/connections, and working independent egress controls. Require a separately reviewed and instantly executable guarded rollback transaction **before** starting.

Only after that distinct approval: activate the matching 'page' app and binding, with identity-only automatic consent enabled only if reviewed for the Account flow. Do not modify OAuth client registration, other apps, Account frontend or production Clearpage. Test the actual SSO probe. First mismatch, route escape, unauthorized access, stale private UI, unknown session, or unverified rollback => immediately stop and disable the binding/app.

## 4. Minimal real acceptance order

| Gate | Required independent evidence |
| --- | --- |
| Real PKCE + callback | A1 explicit sign-in, exact client and callback, code exchanged once, correct verified Account UUID, invalid state/code rejected |
| Refresh and expiration | Real issuer refresh, code replay rejected, expired/revoked credentials fail |
| Guest + cloud opt-in | Guest note remains local, A1 explicitly enables sync, first CAS revision and A2 same-owner download verified |
| RLS | A cannot read/write B; B cannot read/write A; other OAuth client and direct table DML denied; no wrong-client CAS |
| A-to-B | A content hidden immediately after verified B, no copy or unintended upload |
| Offline/concurrency | A1/A2 edits offline, reconnect, conflict copy retained once, deterministic revision advancement |
| Permanent deletion | Concurrent remote edit versus permanent delete fails closed; no silent resurrection |
| Revocation | Disconnect A in Account; held A access token denied by owner/connection guard; refresh/reconnect follows Account policy |
| Rollback | App/binding inactive even with prior tokens, CAS/SELECT denied, test rows/sessions cleaned, no global Account regressions |

Simulated CI, anonymous SQL tests, and the offline exact-origin harness do NOT prove these results. Actual deployed Vercel callback routing and physical Android/two-device acceptance remain separate gates after the controlled browser-local experiment.

## 5. Rollback and cleanup (proposed, not executed)

Before activation, pre-review a **transactional, exact-ID, idempotent rollback** that first disables only the binding with oauth_client_id 088b34ff-84ad-4746-a030-cc517159a17a and app_slug 'page', sets automatic_identity_consent=false, then disables only account_apps.slug='page'. Assert exactly the expected rows and inactive result before commit. Do not delete the registered OAuth client or change global keys, other apps, Core, user data or database ACL.

Then use the Account-supported disconnect/revocation route on **disposable A/B only**. Verify held tokens are denied even if their JWT has not expired; revoke only their app sessions and cleanup their identified test notes. Do not delete preexisting authorization rows en masse (the current baseline includes an OAuth authorization record without a client session). Delete disposable Auth identities only after confirming no unrelated app usage, and only with separate operator approval. Verify zero test rows, no test sessions, original client retained, restored app/binding/consent flags, repaired table privileges and unaffected v1.1 site. If rollback tooling or operator access cannot be demonstrated, **NO-GO**.

## 6. Privacy-preserving evidence

Report UTC start/end, build SHA, Account migration/binding version, pseudonyms A1/A2/B1, policy rule IDs, HTTP status **classes**, CAS revision transitions, and PASS/FAIL/NOT RUN for every gate. Keep real UUIDs/identities, raw URLs with code/state, tokens, credentials, notes and private response bodies out of logs and PR comments. Record baseline and post-test aggregate counts. A separate reviewer must sign off both activation containment and rollback. Do not automatically elevate a green browser test into deployment or release authorization.

**Decision now: NO-GO for real credentials, activation and release.** This PR contains only a bounded plan and inert offline classifier. Future network-enabling implementation requires an explicit approval and independent security review.
