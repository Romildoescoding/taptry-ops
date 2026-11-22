-- Phase 2/3: PostHog live queries, outreach, inbox, app DB snapshots.

-- PostHog: keep each insight's query so it can be re-run with any date range.
ALTER TABLE ph_insights ADD COLUMN query TEXT;       -- JSON source query (TrendsQuery, FunnelsQuery, ...)
ALTER TABLE ph_insights ADD COLUMN display TEXT;     -- BoldNumber, ActionsLineGraph, ...
CREATE TABLE ph_cache (
  key        TEXT PRIMARY KEY,                       -- short_id|from|to|interval
  result     TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Outreach Tracker sheet mirrors (keyed the way the sheet script sends them).
CREATE TABLE leads (
  email         TEXT PRIMARY KEY,                    -- lowercased
  row_num       INTEGER,
  developer     TEXT,
  greeting      TEXT,
  app           TEXT,
  platform      TEXT,
  source        TEXT,
  source_kind   TEXT,                                -- play, reddit, github, ownapp, x, producthunt, devto, indiehackers, other
  installs      TEXT,
  status        TEXT,
  inbox         TEXT,                                -- connect, reachout, hello
  first_sent_at TEXT,
  thread_id     TEXT,
  fu_sent_at    TEXT,
  last_reply_at TEXT,
  notes         TEXT,
  fu_count      INTEGER NOT NULL DEFAULT 0,
  variant       TEXT,
  auto_reply    INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);
CREATE INDEX leads_first_sent ON leads(first_sent_at);
CREATE INDEX leads_status ON leads(status);
CREATE INDEX leads_thread ON leads(thread_id);

CREATE TABLE escalations (
  id             TEXT PRIMARY KEY,                   -- R7
  created_at     TEXT,
  inbox          TEXT,
  lead_email     TEXT,
  thread_id      TEXT,
  summary        TEXT,
  suggested      TEXT,
  status         TEXT,
  romil_answer   TEXT,
  sent_at        TEXT,
  updated_at     TEXT NOT NULL
);

CREATE TABLE nudges (
  key        TEXT PRIMARY KEY,                       -- sent_at|email
  sent_at    TEXT,
  nudge      TEXT,
  user_id    TEXT,
  email      TEXT,
  name       TEXT,
  app        TEXT,
  subject    TEXT,
  thread_id  TEXT,
  status     TEXT,
  last_reply_at TEXT,
  notes      TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE run_log (
  key       TEXT PRIMARY KEY,                        -- run_at|type
  run_at    TEXT,
  type      TEXT,
  family    TEXT,                                    -- daily, warm, ownapp, reply, nudges, weekly, other
  new_sent  INTEGER,
  followups INTEGER,
  replies   INTEGER,
  escalated INTEGER,
  bounces   INTEGER,
  raw       TEXT
);
CREATE INDEX run_log_at ON run_log(run_at);

-- Gmail, pushed by the inbox scripts.
CREATE TABLE mail_msgs (
  id         TEXT PRIMARY KEY,                       -- Gmail message id
  inbox      TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  direction  TEXT NOT NULL,                          -- in | out
  kind       TEXT NOT NULL,                          -- out, human, auto, bounce, romil, internal
  from_addr  TEXT,
  from_name  TEXT,
  to_addr    TEXT,
  subject    TEXT,
  snippet    TEXT,
  body       TEXT,                                   -- inbound only, plain text, capped
  sent_at    TEXT NOT NULL
);
CREATE INDEX mail_thread ON mail_msgs(inbox, thread_id, sent_at);
CREATE INDEX mail_kind_at ON mail_msgs(kind, sent_at);

-- Your decisions on queue items (handled / snoozed / dead) and replies sent from here.
CREATE TABLE queue_state (
  key          TEXT PRIMARY KEY,                     -- thread:<inbox>:<id>, esc:<id>, app:<slug>, ...
  state        TEXT NOT NULL,                        -- handled, snoozed, dead
  snooze_until TEXT,
  updated_at   TEXT NOT NULL
);
CREATE TABLE replies_sent (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox      TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  to_addr    TEXT,
  body       TEXT NOT NULL,
  escalation TEXT,
  sent_at    TEXT NOT NULL
);

-- Changes made here that the sheet script writes back into the tracker.
CREATE TABLE sheet_updates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tab        TEXT NOT NULL,                          -- Leads | Escalations
  key        TEXT NOT NULL,                          -- lead email or escalation id
  col        TEXT NOT NULL,                          -- header name
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT
);

-- App DB snapshots (replaced on each sync).
CREATE TABLE app_daily (
  day TEXT PRIMARY KEY, signups INTEGER, signups_onboarded INTEGER, user_uploads INTEGER, demo_uploads INTEGER,
  runs INTEGER, apps_run INTEGER, run_minutes REAL, active_minutes REAL, launch_failed INTEGER, crashed INTEGER,
  video_gb REAL, app_page_visits INTEGER, play_store_clicks INTEGER, trial_requests INTEGER
);
CREATE TABLE app_items (
  kind TEXT NOT NULL,                                -- flagged, demo, subscription, payment, abandoned, report, enterprise, fleet, signup, category
  id   TEXT NOT NULL,
  data TEXT NOT NULL,                                -- JSON row from the ops view
  PRIMARY KEY (kind, id)
);
