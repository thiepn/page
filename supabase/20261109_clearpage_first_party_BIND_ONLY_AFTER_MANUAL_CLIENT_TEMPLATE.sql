-- OPERATOR-ONLY TEMPLATE. Do not apply before one public OAuth client has
-- been created in THIEPN Account using the approved manual onboarding.
-- Copy into a REVIEWED thiepn/account migration after replacing the sentinel.
-- This file is NOT used by Clearpage CI, Vercel, or application runtime.
do $$
declare
  v_client constant uuid := 'REPLACE_WITH_MANUALLY_ISSUED_CLIENT_UUID'::uuid;
  v_origin constant text := 'https://page.thiepn.dev/';
  v_redirect constant text := 'https://page.thiepn.dev/auth/callback/';
begin
  -- Fail before modifying anything if the client is unknown, confidential,
  -- has extra redirects or an unexpected OAuth contract.
  if not exists (
    select 1 from auth.oauth_clients c
    where c.id=v_client
      and c.client_name='THIEPN Clearpage'
      and c.client_type::text='public'
      and c.redirect_uris=v_redirect
      and c.token_endpoint_auth_method='none'
      and c.grant_types='authorization_code,refresh_token'
      and c.deleted_at is null
      and (c.client_uri=v_origin or c.client_uri is null)
  ) then raise exception 'clearpage_public_oauth_client_mismatch'; end if;

  if not exists (
    select 1 from public.account_apps a
    join public.account_app_manifests m on m.app_slug=a.slug
    join public.account_app_permissions p on p.app_slug=a.slug
    where a.slug='page' and a.product_url=v_origin
      and m.capabilities @> '{"account":true,"guestFirst":true}'::jsonb
      and p.permission_id='identity.basic'
      and p.required and p.active
      and p.mutable_by_user=false and p.sensitivity='basic'
  ) then raise exception 'clearpage_registry_contract_missing'; end if;

  if exists (
    select 1 from public.account_first_party_oauth_clients c
    where (c.app_slug='page' or c.oauth_client_id=v_client)
      and (c.app_slug<>'page' or c.oauth_client_id<>v_client
        or c.redirect_uri<>v_redirect or c.client_uri<>v_origin)
  ) then raise exception 'clearpage_oauth_binding_conflict'; end if;

  update auth.oauth_clients set client_uri=v_origin,updated_at=now()
  where id=v_client and client_uri is null;

  insert into public.account_first_party_oauth_clients
     (oauth_client_id,app_slug,client_name,client_uri,redirect_uri,automatic_identity_consent,active)
  values (v_client,'page','THIEPN Clearpage',v_origin,v_redirect,true,true)
  on conflict(app_slug,redirect_uri) do update set
    oauth_client_id=excluded.oauth_client_id,
    client_name=excluded.client_name,
    client_uri=excluded.client_uri,
    automatic_identity_consent=excluded.automatic_identity_consent,
    active=excluded.active,
    updated_at=now();

  -- Activate only as the last step of this reviewed binding transaction.
  update public.account_apps set active=true,updated_at=now()
  where slug='page' and product_url=v_origin;
  if not found then raise exception 'clearpage_activation_failed'; end if;
end
$$;
