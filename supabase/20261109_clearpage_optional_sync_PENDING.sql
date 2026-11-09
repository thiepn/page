-- Clearpage v1.2: REVIEW-ONLY migration for existing THIEPN Account Supabase.
-- Prerequisite: manual-only OAuth client onboarding; do not activate here or create a client by SQL.
-- No executable production migration has been applied by this PR.
insert into public.account_apps(slug,name,description,path,product_url,sort_order,active,updated_at)
values ('page','Clearpage','Minimal private local-first writing, with optional THIEPN Account cloud sync.','/page/','https://page.thiepn.dev/',90,false,now())
on conflict(slug) do update set
 name=excluded.name,description=excluded.description,path=excluded.path,
 product_url=excluded.product_url,active=false,updated_at=now();

insert into public.account_app_manifests
 (app_slug,manifest_version,identity_scope,data_scope,export_scope,capabilities,core_app_id,updated_at)
values ('page',1,'private','isolated','app-owned',
 '{"account":true,"guestFirst":true,"isolatedData":true,"sync":true,"cloud_saves":true,"export_data":true}'::jsonb,
 null,now())
on conflict(app_slug) do update set
 manifest_version=excluded.manifest_version,identity_scope=excluded.identity_scope,
 data_scope=excluded.data_scope,export_scope=excluded.export_scope,
 capabilities=excluded.capabilities,core_app_id=excluded.core_app_id,updated_at=now();

insert into public.account_app_permissions
 (app_slug,permission_id,name,description,required,mutable_by_user,sensitivity,sort_order,active,updated_at)
values ('page','identity.basic','Basic Account identity',
 'Used only when the user chooses THIEPN Account. Anonymous writing remains available.',
 true,false,'basic',10,true,now())
on conflict(app_slug,permission_id) do update set
 name=excluded.name,description=excluded.description,required=excluded.required,
 mutable_by_user=excluded.mutable_by_user,sensitivity=excluded.sensitivity,
 sort_order=excluded.sort_order,active=excluded.active,updated_at=now();

create table if not exists public.clearpage_sync_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision >= 1),
  payload jsonb not null,
  last_mutation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clearpage_payload_format check (
    jsonb_typeof(payload)='object' and
    payload->>'schema'='1' and
    jsonb_typeof(payload->'notes')='array' and
    jsonb_typeof(payload->'trash')='array' and
    octet_length(payload::text) <= 10485760
  )
);
alter table public.clearpage_sync_state enable row level security;
revoke all on public.clearpage_sync_state from PUBLIC,anon;
grant select,insert,update on public.clearpage_sync_state to authenticated;

-- This guard is the ONLY privileged routine. It returns a boolean, never data.
-- Denies before Account registration, after disconnect or app suspension,
-- and for every other OAuth client, even another THIEPN first-party app.
create or replace function private.clearpage_client_allowed()
returns boolean language sql stable security definer set search_path=''
as $$
  select (select auth.uid()) is not null
     and exists (
       select 1 from public.account_first_party_oauth_clients r
       join public.account_apps a on a.slug = r.app_slug
       join public.account_app_connections c on c.app_slug=r.app_slug and c.user_id=(select auth.uid())
       join public.account_app_grants g on g.app_slug=r.app_slug
         and g.user_id=(select auth.uid()) and g.permission_id='identity.basic'
       where r.app_slug='page'
         and r.active=true and a.active=true
         and r.client_uri='https://page.thiepn.dev/'
         and r.redirect_uri='https://page.thiepn.dev/auth/callback/'
         and r.oauth_client_id::text=(auth.jwt()->>'client_id')
         and c.status='connected' and g.status='granted'
     );
$$;
revoke all on function private.clearpage_client_allowed() from PUBLIC,anon;
grant usage on schema private to authenticated;
grant execute on function private.clearpage_client_allowed() to authenticated;

drop policy if exists clearpage_sync_select on public.clearpage_sync_state;
create policy clearpage_sync_select on public.clearpage_sync_state
 for select to authenticated using (
   user_id=(select auth.uid()) and (select private.clearpage_client_allowed())
 );
drop policy if exists clearpage_sync_insert on public.clearpage_sync_state;
create policy clearpage_sync_insert on public.clearpage_sync_state
 for insert to authenticated with check (
   user_id=(select auth.uid()) and (select private.clearpage_client_allowed())
 );
drop policy if exists clearpage_sync_update on public.clearpage_sync_state;
create policy clearpage_sync_update on public.clearpage_sync_state
 for update to authenticated using (
   user_id=(select auth.uid()) and (select private.clearpage_client_allowed())
 ) with check (
   user_id=(select auth.uid()) and (select private.clearpage_client_allowed())
 );

-- SECURITY INVOKER: RLS still applies. No owner parameter is accepted.
-- Revises a whole snapshot only against the caller's expected server revision.
-- Identical mutation IDs can be replayed without advancing the revision.
create or replace function public.clearpage_sync_cas(
 p_expected_revision bigint, p_payload jsonb, p_mutation_id uuid
) returns table(revision bigint,payload jsonb,last_mutation_id uuid)
language plpgsql security invoker set search_path=''
as $$
declare v_owner uuid := auth.uid();
begin
 if v_owner is null or not private.clearpage_client_allowed() then
   raise exception 'clearpage_access_denied' using errcode='42501';
 end if;
 if p_expected_revision is null or p_expected_revision < 0
    or p_mutation_id is null or p_payload is null
    or jsonb_typeof(p_payload)<>'object'
    or p_payload->>'schema'<>'1'
    or jsonb_typeof(p_payload->'notes')<>'array'
    or jsonb_typeof(p_payload->'trash')<>'array'
    or octet_length(p_payload::text)>10485760 then
   raise exception 'clearpage_payload_invalid' using errcode='22023';
 end if;
 if p_expected_revision=0 then
   return query
   insert into public.clearpage_sync_state as s (user_id,revision,payload,last_mutation_id)
   values(v_owner,1,p_payload,p_mutation_id)
   on conflict(user_id) do update set
     revision=s.revision,
     payload=s.payload,
     last_mutation_id=s.last_mutation_id
   where s.last_mutation_id=p_mutation_id and s.payload=p_payload
   returning s.revision,s.payload,s.last_mutation_id;
 else
   return query
   update public.clearpage_sync_state as s set
     revision=case when s.last_mutation_id=p_mutation_id and s.payload=p_payload
                   then s.revision else s.revision+1 end,
     payload=p_payload,
     last_mutation_id=p_mutation_id,
     updated_at=case when s.last_mutation_id=p_mutation_id and s.payload=p_payload
                     then s.updated_at else now() end
   where s.user_id=v_owner
     and (s.revision=p_expected_revision
       or (s.last_mutation_id=p_mutation_id and s.payload=p_payload))
   returning s.revision,s.payload,s.last_mutation_id;
 end if;
end;
$$;
revoke all on function public.clearpage_sync_cas(bigint,jsonb,uuid) from public,anon;
grant execute on function public.clearpage_sync_cas(bigint,jsonb,uuid) to authenticated;

-- Missing OAuth client means activation must remain FALSE.
-- A separate reviewed, operator-initiated Account migration must bind the
-- single manually issued public OAuth client UUID to exact page/callback.
