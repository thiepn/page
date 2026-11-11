\set ON_ERROR_STOP on
-- Run ONLY after disposable PostgreSQL reactivates the synthetic app/client
-- and grants synthetic TRUNCATE. No production users or tables are touched.
do $proof$
begin
  if (select active from public.account_apps where slug='page') is distinct from false
    then raise exception 'EMERGENCY STOP FAILED: app still active despite ACL drift'; end if;
  if exists (select 1 from public.account_first_party_oauth_clients
      where app_slug='page' and (active or automatic_identity_consent))
    then raise exception 'EMERGENCY STOP FAILED: binding still active despite ACL drift'; end if;
  if not has_table_privilege('authenticated','public.clearpage_sync_state','TRUNCATE')
    then raise exception 'Adversarial ACL drift was absent; test invalid'; end if;
  if (select count(*) from public.clearpage_sync_state)<>2
    then raise exception 'Emergency stop unexpectedly removed two owners data'; end if;
end $proof$;
\echo 'CLEARPAGE_EMERGENCY_STOP_COMMITS_DESPITE_ACL_DRIFT=PASS'
