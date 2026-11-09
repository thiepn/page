-- Minimal synthetic THIEPN Account schema for disposable PostgreSQL integration tests.
-- Not a production migration; NO actual Account users, credentials or private data.
create role anon nologin;
create role authenticated nologin;

create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt()->>'sub','')::uuid
$$;
grant usage on schema auth to authenticated,anon;

create table auth.users(id uuid primary key);
insert into auth.users(id) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

create table public.account_apps (
 slug text primary key, name text, description text, path text,
 product_url text, sort_order int, active boolean,
 updated_at timestamptz default now()
);
create table public.account_app_manifests (
 app_slug text primary key references public.account_apps(slug),
 manifest_version int, identity_scope text, data_scope text,
 export_scope text, capabilities jsonb, core_app_id text,
 updated_at timestamptz default now()
);
create table public.account_app_permissions (
 app_slug text, permission_id text, name text, description text,
 required boolean, mutable_by_user boolean, sensitivity text,
 sort_order int, active boolean, updated_at timestamptz default now(),
 primary key(app_slug,permission_id)
);
create table public.account_first_party_oauth_clients (
 oauth_client_id uuid primary key, app_slug text, client_name text,
 client_uri text, redirect_uri text, automatic_identity_consent boolean,
 active boolean
);
create table public.account_app_connections (
 user_id uuid references auth.users(id), app_slug text,
 status text, primary key(user_id,app_slug)
);
create table public.account_app_grants (
 user_id uuid references auth.users(id), app_slug text,
 permission_id text, status text,
 primary key(user_id,app_slug,permission_id)
);

-- A synthetic manually-created public OAuth client for operator binding tests.
create table auth.oauth_clients (
 id uuid primary key,
 client_name text not null,
 client_type text not null,
 redirect_uris text not null,
 token_endpoint_auth_method text not null,
 grant_types text not null,
 deleted_at timestamptz,
 client_uri text,
 updated_at timestamptz default now()
);
insert into auth.oauth_clients
 (id,client_name,client_type,redirect_uris,token_endpoint_auth_method,grant_types,deleted_at,client_uri)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','THIEPN Clearpage',
 'public','https://page.thiepn.dev/auth/callback/',
 'none','authorization_code,refresh_token',null,null);
