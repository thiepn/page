\set ON_ERROR_STOP on
-- Disposable PostgreSQL acceptance: after two owners have CAS-created
-- separate cloud rows, emergency rollback must deny HELD OAuth claims.
do $precheck$
begin
  if (select count(*) from public.clearpage_sync_state)<>2
    then raise exception 'Expected existing cloud rows before rollback'; end if;
  if (select active from public.account_apps where slug='page') is distinct from false
    then raise exception 'Rollback did not deactivate app'; end if;
  if (select active from public.account_first_party_oauth_clients where app_slug='page') is distinct from false
    then raise exception 'Rollback did not deactivate client'; end if;
  if (select automatic_identity_consent from public.account_first_party_oauth_clients where app_slug='page') is distinct from false
    then raise exception 'Rollback did not disable automatic consent'; end if;
end $precheck$;

set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","client_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}',false);
do $held_token$
begin
  if public.clearpage_client_allowed()
    then raise exception 'HELD valid user + client should be denied after emergency stop'; end if;
  if (select count(*) from public.clearpage_sync_state)<>0
    then raise exception 'Held client token can still read owner notes'; end if;
  begin
    perform public.clearpage_sync_cas(1,'{"schema":1,"notes":[],"trash":[]}'::jsonb,
      '99999999-9999-4999-8999-999999999999'::uuid);
    raise exception 'Held client token wrote after emergency stop';
  exception when insufficient_privilege then null;
  end;
end $held_token$;
reset role;
do $verify$
begin
  if (select count(*) from public.clearpage_sync_state)<>2
    then raise exception 'Emergency stop deleted cloud data'; end if;
  if (select revision from public.clearpage_sync_state where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')<>2
    then raise exception 'Emergency stop changed owner A'; end if;
  if (select revision from public.clearpage_sync_state where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')<>1
    then raise exception 'Emergency stop changed owner B'; end if;
  if (select count(*) from public.account_first_party_oauth_clients where app_slug='page')<>1
    then raise exception 'Emergency stop removed binding'; end if;
  if (select count(*) from auth.oauth_clients where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc')<>1
    then raise exception 'Emergency stop removed registered client'; end if;
end $verify$;
\echo 'CLEARPAGE_EMERGENCY_ROLLBACK_HELD_TOKEN_DENIED=PASS'
