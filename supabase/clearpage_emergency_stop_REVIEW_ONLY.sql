-- REVIEW ONLY: prepared emergency DEACTIVATION, NOT an activation/release.
-- DO NOT run against live THIEPN Account without separate operator approval.
-- The exact public OAuth UUID is pinned. CI substitutes a SYNTHETIC client ID,
-- runs only against disposable postgres:17 and never calls the Account project.
-- Disable the first-party binding before disabling the app. Leave the OAuth
-- client, users, sessions, connections, grants, cloud rows and ACL untouched.
-- Safe to repeat, including after a real test has created synced cloud rows.
begin;
set local lock_timeout='2s';
set local statement_timeout='10s';

do $clearpage_emergency_stop$
declare
  v_id constant uuid := '088b34ff-84ad-4746-a030-cc517159a17a';
  v_n integer;
begin
  -- Lock only the scoped registry rows, in activation order, to serialize
  -- concurrent operations. Do NOT predicate on the current active state:
  -- emergency deactivation must work from either active or inactive.
  perform 1 from public.account_first_party_oauth_clients
    where app_slug='page' and oauth_client_id=v_id for update;
  if not found then raise exception 'clearpage_exact_binding_missing'; end if;

  if exists (select 1 from public.account_first_party_oauth_clients
     where app_slug='page' and oauth_client_id<>v_id)
    then raise exception 'unexpected_clearpage_binding'; end if;

  perform 1 from public.account_apps
    where slug='page' for update;
  if not found then raise exception 'clearpage_app_missing'; end if;

  update public.account_first_party_oauth_clients
    set active=false, automatic_identity_consent=false, updated_at=now()
    where app_slug='page' and oauth_client_id=v_id;
  get diagnostics v_n = row_count;
  if v_n<>1 then raise exception 'clearpage_binding_row_count_mismatch'; end if;

  update public.account_apps
    set active=false, updated_at=now()
    where slug='page';
  get diagnostics v_n = row_count;
  if v_n<>1 then raise exception 'clearpage_app_row_count_mismatch'; end if;

  if exists (
    select 1 from public.account_first_party_oauth_clients
    where app_slug='page' and (active or automatic_identity_consent)
  ) or exists (
    select 1 from public.account_apps where slug='page' and active
  ) then raise exception 'clearpage_emergency_stop_incomplete'; end if;

  -- The operation must NOT broaden table privileges or weaken RLS/CAS.
  if (select relrowsecurity from pg_class
       where oid='public.clearpage_sync_state'::regclass) is distinct from true
     then raise exception 'clearpage_rls_missing'; end if;
  if not has_table_privilege('authenticated',
        'public.clearpage_sync_state','SELECT')
     or has_table_privilege('authenticated',
        'public.clearpage_sync_state','TRUNCATE')
     or has_table_privilege('authenticated',
        'public.clearpage_sync_state','UPDATE')
     then raise exception 'clearpage_acl_changed'; end if;
  if not has_function_privilege('authenticated',
        'public.clearpage_sync_cas(bigint,jsonb,uuid)','EXECUTE')
     or has_function_privilege('anon',
        'public.clearpage_sync_cas(bigint,jsonb,uuid)','EXECUTE')
     then raise exception 'clearpage_cas_acl_changed'; end if;
end $clearpage_emergency_stop$;
commit;
