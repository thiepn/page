\set ON_ERROR_STOP on
-- Disposable PostgreSQL only. Reproduce production's staged inactive-binding
-- state before exercising the *separate*, reviewed activation template.
-- No real OAuth client is registered or modified.
do $$
begin
  if (select active from public.account_apps where slug='page') is distinct from false
    then raise exception 'Clearpage app must remain inactive before staging'; end if;
  if not exists (select 1 from auth.oauth_clients
    where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid
      and client_type='public' and token_endpoint_auth_method='none')
    then raise exception 'Disposable public-client fixture not found'; end if;
end $$;
insert into public.account_first_party_oauth_clients
  (oauth_client_id,app_slug,client_name,client_uri,redirect_uri,automatic_identity_consent,active)
values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','page','THIEPN Clearpage',
   'https://page.thiepn.dev/','https://page.thiepn.dev/auth/callback/',false,false);
do $$
declare r record;
begin
  select c.*,a.active as app_active into r
  from public.account_first_party_oauth_clients c
  join public.account_apps a on a.slug=c.app_slug
  where c.app_slug='page';
  if not found or r.active is distinct from false
     or r.automatic_identity_consent is distinct from false
     or r.app_active is distinct from false
     or r.redirect_uri <> 'https://page.thiepn.dev/auth/callback/'
     or r.client_uri <> 'https://page.thiepn.dev/'
    then raise exception 'Staged inactive binding contract failed'; end if;
  if public.clearpage_client_allowed()
    then raise exception 'Inactive client unexpectedly authorized'; end if;
end $$;
\echo 'CLEARPAGE_STAGED_INACTIVE_BINDING=PASS'
