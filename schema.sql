-- Jalankan di Supabase SQL Editor. Aman di-run ulang.

create table if not exists bot_config (
  id int primary key default 1,
  telegram_token text,
  discord_bot_token text,
  discord_app_id text,
  discord_public_key text,
  admin_password_hash text,
  default_provider_id uuid,
  allow_model_switch boolean default true,
  constraint single_row check (id = 1)
);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  label text not null,
  api_key text not null,
  model_name text not null,
  command text not null unique,
  output_type text default 'text',
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists sessions (
  platform text not null,
  user_id text not null,
  messages jsonb default '[]',
  active_provider_id uuid,
  updated_at timestamptz default now(),
  primary key (platform, user_id)
);

create table if not exists admin_sessions (
  token text primary key,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

alter table bot_config enable row level security;
alter table api_keys enable row level security;
alter table sessions enable row level security;
alter table admin_sessions enable row level security;

drop policy if exists "allow all bot_config" on bot_config;
create policy "allow all bot_config" on bot_config for all using (true) with check (true);

drop policy if exists "allow all api_keys" on api_keys;
create policy "allow all api_keys" on api_keys for all using (true) with check (true);

drop policy if exists "allow all sessions" on sessions;
create policy "allow all sessions" on sessions for all using (true) with check (true);

drop policy if exists "allow all admin_sessions" on admin_sessions;
create policy "allow all admin_sessions" on admin_sessions for all using (true) with check (true);

insert into bot_config (id) values (1) on conflict (id) do nothing;
