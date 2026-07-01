create table if not exists honcho_sessions (
  telegram_id bigint primary key,
  messages jsonb default '[]',
  updated_at timestamptz default now()
);

alter table honcho_sessions enable row level security;

create policy "allow all access"
on honcho_sessions
for all
using (true)
with check (true);
