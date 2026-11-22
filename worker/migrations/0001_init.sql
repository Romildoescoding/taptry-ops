-- Phase 1 tables: costs, product, system. Outreach tables arrive in 0002 (Phase 2).

CREATE TABLE collector_runs (
  collector   TEXT NOT NULL,
  started_at  TEXT NOT NULL,          -- ISO UTC
  finished_at TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  rows        INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  PRIMARY KEY (collector, started_at)
);

CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                 -- JSON
);

-- Cost Explorer daily costs (UTC days, like the AWS bill). Tax shows as service "Tax".
CREATE TABLE aws_cost_daily (
  day     TEXT NOT NULL,              -- YYYY-MM-DD
  service TEXT NOT NULL,
  region  TEXT NOT NULL,
  usd     REAL NOT NULL,
  PRIMARY KEY (day, service, region)
);

-- Latest fleet snapshot only: replaced on every hourly run.
CREATE TABLE aws_fleet (
  region      TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- instance | ip | volume
  resource_id TEXT NOT NULL,
  detail      TEXT,                   -- instance type, or "attached"/"unattached"
  state       TEXT,
  size_gb     REAL,
  launched_at TEXT,
  taken_at    TEXT NOT NULL,
  PRIMARY KEY (region, kind, resource_id)
);

CREATE TABLE ph_insights (
  short_id     TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  kind         TEXT,                  -- TrendsQuery, FunnelsQuery, RetentionQuery, ...
  result       TEXT,                  -- JSON, PostHog's cached result
  computed_at  TEXT,                  -- PostHog's last_refresh
  fetched_at   TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('aws_budget_usd', 'null'),
  -- On-demand $/hour by "region:type". Fill in from the EC2 pricing page; unknown types show "price not set".
  ('ec2_prices', '{}'),
  ('ipv4_usd_per_hour', '0.005');
