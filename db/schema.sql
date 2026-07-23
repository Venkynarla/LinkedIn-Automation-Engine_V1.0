-- ============================================================
-- LinkedIn Outreach CRM — Core Schema (Supabase / Postgres)
-- ============================================================

-- One row per LinkedIn profile you've collected, ever.
create table prospects (
  id uuid primary key default gen_random_uuid(),
  linkedin_url text unique not null,
  full_name text,
  headline text,
  designation text,
  company text,
  about text,
  skills text[],
  experience jsonb,           -- raw structured scrape: [{title, company, duration, description}, ...]
  location text,
  source_search text,         -- the boolean query that found them, if any
  scraped_at timestamptz default now(),
  created_at timestamptz default now()
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  daily_connection_cap int default 20,   -- LinkedIn soft limit is ~100-200/week; stay conservative
  daily_message_cap int default 30,
  active_hours_start time default '09:00',
  active_hours_end time default '18:00',
  timezone text default 'Asia/Kolkata',
  created_at timestamptz default now()
);

-- Every send-worthy interaction lives in one sequence per prospect.
-- state machine values (enforced in app logic, kept as text for flexibility):
--   NEW -> CONNECTION_QUEUED -> CONNECTION_SENT -> CONNECTED
--       -> MESSAGE_1_QUEUED -> MESSAGE_1_SENT
--       -> FOLLOWUP_N_QUEUED -> FOLLOWUP_N_SENT  (repeats)
--       -> REPLIED (terminal, stops automation)
--       -> STOPPED (manual pause / opted out)
--       -> BOUNCED (connection rejected / withdrawn / account restricted)
create table sequences (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references prospects(id) on delete cascade,
  campaign_id uuid references campaigns(id),
  state text not null default 'NEW',
  connection_note text,
  last_message_sent_at timestamptz,
  followup_count int default 0,
  max_followups int default 3,
  followup_gap_days int default 4,
  replied boolean default false,
  paused boolean default false,   -- manual override, automation skips paused rows
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Every individual action (planned, sent, failed) — this is what the
-- extension polls and what the dashboard renders as "pending actions".
create table action_queue (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid references sequences(id) on delete cascade,
  prospect_id uuid references prospects(id) on delete cascade,
  action_type text not null,     -- 'connect' | 'message' | 'followup'
  payload text,                  -- AI-drafted message/note text, editable before send
  status text not null default 'pending',  -- pending | sent | failed | skipped | cancelled
  scheduled_for timestamptz not null default now(),
  attempted_at timestamptz,
  error text,
  created_at timestamptz default now()
);

-- Full audit log of everything actually sent, for "you already messaged this
-- person" checks and for the dashboard's activity history.
create table message_log (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references prospects(id) on delete cascade,
  sequence_id uuid references sequences(id) on delete cascade,
  direction text not null,       -- 'outbound' | 'inbound'
  message_type text not null,    -- 'connection_note' | 'first_message' | 'followup'
  content text,
  sent_at timestamptz default now()
);

-- Daily counters, one row per campaign per day, so the scheduler can
-- enforce caps without scanning message_log every time.
create table send_counters (
  campaign_id uuid references campaigns(id),
  day date not null,
  connections_sent int default 0,
  messages_sent int default 0,
  primary key (campaign_id, day)
);

create index idx_action_queue_status_scheduled on action_queue (status, scheduled_for);
create index idx_sequences_state on sequences (state);
create index idx_prospects_url on prospects (linkedin_url);

-- Added for the background-automation controller (background.js): tracks
-- the last error hit while processing this sequence, and when it was last
-- attempted, so repeatedly-failing leads can be surfaced/skipped instead of
-- silently retried forever.
alter table sequences add column if not exists error text;
alter table sequences add column if not exists last_processed timestamptz;

-- Atomic upsert-and-increment so concurrent requests can't race the daily cap.
create or replace function increment_send_counter(
  p_campaign_id uuid, p_day date, p_col text
) returns void as $$
begin
  if p_col = 'connections_sent' then
    insert into send_counters (campaign_id, day, connections_sent)
    values (p_campaign_id, p_day, 1)
    on conflict (campaign_id, day)
    do update set connections_sent = send_counters.connections_sent + 1;
  else
    insert into send_counters (campaign_id, day, messages_sent)
    values (p_campaign_id, p_day, 1)
    on conflict (campaign_id, day)
    do update set messages_sent = send_counters.messages_sent + 1;
  end if;
end;
$$ language plpgsql;
