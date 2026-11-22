export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  POSTHOG_HOST: string;
  POSTHOG_DASHBOARDS: string; // comma-separated dashboard ids
  POSTHOG_PROJECT_ID?: string; // optional; found from the key when empty
  AWS_REGIONS: string; // comma-separated
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  POSTHOG_API_KEY?: string;
  DASH_PASSWORD?: string; // secret
  INGEST_SECRET?: string; // secret, shared with the Apps Scripts
  ANTHROPIC_API_KEY?: string; // secret, optional: AI reply drafts
  APPDB_URL?: string; // secret: ops_ro connection string
  OWNER_EMAIL: string; // where the digest and escalations go
  AI_MODEL?: string;
  LOCAL_DEV?: string; // .dev.vars only
}

export const nowIso = () => new Date().toISOString();

export async function getConfig<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return fallback;
  try {
    const v = JSON.parse(row.value);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** Wraps a collector so every run leaves a row in collector_runs, ok or not. */
export async function recordRun(db: D1Database, collector: string, fn: () => Promise<number>): Promise<void> {
  const started = nowIso();
  await db.prepare("INSERT INTO collector_runs (collector, started_at) VALUES (?, ?)").bind(collector, started).run();
  try {
    const rows = await fn();
    await db
      .prepare("UPDATE collector_runs SET finished_at = ?, ok = 1, rows = ? WHERE collector = ? AND started_at = ?")
      .bind(nowIso(), rows, collector, started)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .prepare("UPDATE collector_runs SET finished_at = ?, ok = 0, error = ? WHERE collector = ? AND started_at = ?")
      .bind(nowIso(), msg.slice(0, 500), collector, started)
      .run();
    console.error(`collector ${collector} failed: ${msg}`);
  }
}
