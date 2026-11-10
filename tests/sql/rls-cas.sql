\set ON_ERROR_STOP on
-- Check the entire table ACL; RLS does not govern TRUNCATE or REFERENCES.
-- The fixture deliberately grants all privileges by default to authenticated.
do $
declare v_priv text;
begin
  if not has_table_privilege('authenticated','public.clearpage_sync_state','SELECT')
     then raise exception 'owner-scoped authenticated SELECT must remain available'; end if;
  foreach v_priv in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']
  loop
    if has_table_privilege('authenticated','public.clearpage_sync_state',v_priv)
      then raise exception 'Unexpected authenticated table privilege: %',v_priv; end if;
  end loop;
  if has_table_privilege('anon','public.clearpage_sync_state','SELECT')
     or has_table_privilege('anon','public.clearpage_sync_state','TRUNCATE')
     then raise exception 'Anonymous table access unexpectedly granted'; end if;
end $;
\echo 'CLEARPAGE_TABLE_ACL_LEAST_PRIVILEGE=PASS'
-- This file is executed ONLY against the ephemeral PostgreSQL CI service.
-- Load fixtures.sql, then staged Clearpage migration, before this test.
-- Operator binding template already ran against a synthetic manual client.
do $$
begin
 if not exists (
   select 1 from public.account_first_party_oauth_clients r
   join public.account_apps a on a.slug=r.app_slug
   where a.slug='page' and a.active
   and r.oauth_client_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
   and r.client_uri='https://page.thiepn.dev/'
   and r.redirect_uri='https://page.thiepn.dev/auth/callback/'
   and r.active and r.automatic_identity_consent
 ) then raise exception 'manual operator binding was not installed'; end if;
end $$;
insert into public.account_app_connections(user_id,app_slug,status) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','page','connected'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','page','connected');
insert into public.account_app_grants(user_id,app_slug,permission_id,status) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','page','identity.basic','granted'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','page','identity.basic','granted');

-- Account A, exactly bound registered client, owner-local CAS.
set role authenticated;
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","client_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}',false);
do $$
declare v bigint; n int;
begin
 if not public.clearpage_client_allowed() then
   raise exception 'valid owner-scoped Account client incorrectly rejected';
 end if;
 select revision into v from public.clearpage_sync_cas(
   0,'{"schema":1,"notes":[{"id":"one","title":"Alice","text":"version one"}],"trash":[]}'::jsonb,
   '11111111-1111-4111-8111-111111111111'::uuid
 );
 if v<>1 then raise exception 'initial CAS failed: %',v; end if;
 select revision into v from public.clearpage_sync_cas(
   1,'{"schema":1,"notes":[{"id":"one","title":"Alice","text":"version two"}],"trash":[]}'::jsonb,
   '22222222-2222-4222-8222-222222222222'::uuid
 );
 if v<>2 then raise exception 'CAS revision did not advance'; end if;
 select revision into v from public.clearpage_sync_cas(
   1,'{"schema":1,"notes":[{"id":"one","title":"Alice","text":"version two"}],"trash":[]}'::jsonb,
   '22222222-2222-4222-8222-222222222222'::uuid
 );
 if v<>2 then raise exception 'idempotent retry advanced revision'; end if;
 select count(*) into n from public.clearpage_sync_cas(
   1,'{"schema":1,"notes":[{"id":"one","title":"Stale","text":"older edit"}],"trash":[]}'::jsonb,
   '33333333-3333-4333-8333-333333333333'::uuid
 );
 if n<>0 then raise exception 'stale write unexpectedly accepted'; end if;
 select count(*) into n from public.clearpage_sync_cas(
   2,'{"schema":1,"notes":[{"id":"one","title":"Malicious replay","text":"altered mutation"}],"trash":[]}'::jsonb,
   '22222222-2222-4222-8222-222222222222'::uuid
 );
 if n<>0 then raise exception 'mutation id used with a different payload'; end if;
 begin
   update public.clearpage_sync_state set revision=100 where true;
   raise exception 'authenticated role bypassed CAS via table update';
 exception when insufficient_privilege then null;
 end;
 if (select count(*) from public.clearpage_sync_state)<>1 then
   raise exception 'owner A could not read their own row';
 end if;
end $$;

-- Other OAuth client belonging to same human MUST NOT see or modify Clearpage data.
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","client_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}',false);
do $$
declare n int;
begin
 if public.clearpage_client_allowed() then raise exception 'other OAuth client accepted'; end if;
 select count(*) into n from public.clearpage_sync_state;
 if n<>0 then raise exception 'other OAuth client read user A data'; end if;
 begin
   perform public.clearpage_sync_cas(2,'{"schema":1,"notes":[],"trash":[]}'::jsonb,
    '44444444-4444-4444-8444-444444444444'::uuid);
   raise exception 'other client was allowed to write';
 exception when insufficient_privilege then null;
 end;
end $$;

-- New Account B with same first-party client is completely isolated.
select set_config('request.jwt.claims',
 '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","client_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}',false);
do $$
declare n int; v bigint;
begin
 select count(*) into n from public.clearpage_sync_state;
 if n<>0 then raise exception 'cross-Account read leaked A data'; end if;
 select revision into v from public.clearpage_sync_cas(
   0,'{"schema":1,"notes":[{"id":"two","title":"Bob","text":"private"}],"trash":[]}'::jsonb,
   '55555555-5555-4555-8555-555555555555'::uuid
 );
 if v<>1 then raise exception 'Account B cloud bootstrap failed'; end if;
 select count(*) into n from public.clearpage_sync_state;
 if n<>1 then raise exception 'Account B visible row count must be exactly one'; end if;
end $$;

-- Revoking Account A's connection blocks both reads and writes.
reset role;
update public.account_app_connections set status='disconnected'
 where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and app_slug='page';
set role authenticated;
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","client_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}',false);
do $$
declare n int;
begin
 if public.clearpage_client_allowed() then raise exception 'disconnected Account accepted'; end if;
 select count(*) into n from public.clearpage_sync_state;
 if n<>0 then raise exception 'disconnected Account still read synced notes'; end if;
 begin
   perform public.clearpage_sync_cas(2,'{"schema":1,"notes":[],"trash":[]}'::jsonb,
    '66666666-6666-4666-8666-666666666666'::uuid);
   raise exception 'disconnected Account was allowed to write';
 exception when insufficient_privilege then null;
 end;
end $$;

-- Even after reconnection, a denied basic grant blocks cloud data.
reset role;
update public.account_app_connections set status='connected'
 where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and app_slug='page';
update public.account_app_grants set status='denied'
 where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and app_slug='page';
set role authenticated;
select set_config('request.jwt.claims',
 '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","client_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}',false);
do $$
begin
 if public.clearpage_client_allowed() then raise exception 'denied required grant accepted'; end if;
 if (select count(*) from public.clearpage_sync_state)<>0 then
   raise exception 'denied grant still granted read';
 end if;
end $$;

-- Anon gets neither read nor RPC. Use error-code assertions.
reset role;
set role anon;
select set_config('request.jwt.claims','{}',false);
do $$
begin
 begin
   perform count(*) from public.clearpage_sync_state;
   raise exception 'anonymous SELECT was unexpectedly granted';
 exception when insufficient_privilege then null;
 end;
 begin
   perform public.clearpage_sync_cas(
    0,'{"schema":1,"notes":[],"trash":[]}'::jsonb,
    '77777777-7777-4777-8777-777777777777'::uuid);
   raise exception 'anonymous write was unexpectedly granted';
 exception when insufficient_privilege then null;
 end;
end $$;

reset role;
-- Internal consistency checks, not authentication substitutes.
do $$
declare n int;
begin
 select count(*) into n from public.clearpage_sync_state;
 if n<>2 then raise exception 'expected two independent owner rows, got %',n; end if;
 if (select revision from public.clearpage_sync_state where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')<>2 then
   raise exception 'Account A revision unexpectedly modified';
 end if;
 if (select revision from public.clearpage_sync_state where user_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')<>1 then
   raise exception 'Account B revision unexpectedly modified';
 end if;
end $$;
\echo 'CLEARPAGE_POSTGRES_RLS_CAS=PASS'
