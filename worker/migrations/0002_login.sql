-- Wrong-password counter per IP for the dashboard login (see src/auth.ts).
CREATE TABLE login_attempts (
  ip           TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,  -- unix seconds
  fails        INTEGER NOT NULL
);
