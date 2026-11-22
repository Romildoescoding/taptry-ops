import type { Env } from "./env";
import { getConfig, nowIso } from "./env";

// PostHog in two steps:
//  1. Hourly: read the tiles of the configured dashboards and keep each insight's
//     query (so tiles you add in PostHog appear here on their own).
//  2. On every page view: re-run those queries through PostHog's query API with the
//     date range you picked, cached for 5 minutes. That's what keeps numbers in sync.

interface Tile {
  insight?: {
    short_id: string;
    name?: string | null;
    derived_name?: string | null;
    result?: unknown;
    last_refresh?: string | null;
    query?: { kind?: string; source?: Record<string, any> } | null;
  } | null;
  layouts?: { sm?: { y?: number; x?: number } };
}

export interface InsightRow {
  short_id: string;
  dashboard_id: string;
  name: string;
  position: number;
  kind: string | null;
  display: string | null;
  query: string | null;
  result: string;
  computed_at: string | null;
}

export function tilesToRows(dashboardId: string, tiles: Tile[]): InsightRow[] {
  return tiles
    .filter((t) => t.insight?.short_id)
    .map((t, i) => {
      const ins = t.insight!;
      const source = ins.query?.kind === "InsightVizNode" ? ins.query.source ?? null : (ins.query as Record<string, any> | null) ?? null;
      const display = source?.trendsFilter?.display ?? source?.display ?? null;
      return {
        short_id: ins.short_id,
        dashboard_id: dashboardId,
        name: ins.name || ins.derived_name || ins.short_id,
        position: (t.layouts?.sm?.y ?? i) * 100 + (t.layouts?.sm?.x ?? 0),
        kind: source?.kind ?? null,
        display,
        query: source ? JSON.stringify(source) : null,
        result: JSON.stringify(ins.result ?? null),
        computed_at: ins.last_refresh ?? null,
      };
    });
}

type Get = (path: string, init?: RequestInit) => Promise<any>;

function client(env: Env): Get {
  if (!env.POSTHOG_API_KEY) throw new Error("POSTHOG_API_KEY not set");
  return async (path, init) => {
    const res = await fetch(env.POSTHOG_HOST + path, {
      ...init,
      headers: { Authorization: `Bearer ${env.POSTHOG_API_KEY}`, "Content-Type": "application/json" },
    });
    if (res.status === 401 || res.status === 403)
      throw new Error(`PostHog ${path}: HTTP ${res.status}. The key needs Read on Project, Dashboard, Insight and Query, and access to this project`);
    if (!res.ok) throw new Error(`PostHog ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json();
  };
}

async function projectId(env: Env, get: Get): Promise<string> {
  if (env.POSTHOG_PROJECT_ID) return env.POSTHOG_PROJECT_ID;
  const cached = await getConfig<string | null>(env.DB, "posthog_project_id", null);
  if (cached) return cached;
  let id = "";
  try {
    id = String((await get("/api/projects/@current/")).id ?? "");
  } catch {
    id = String((await get("/api/projects/")).results?.[0]?.id ?? "");
  }
  if (!id) throw new Error("PostHog: the API key sees no project");
  await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('posthog_project_id', ?)").bind(JSON.stringify(id)).run();
  return id;
}

/** Hourly: refresh the list of insights and their queries. */
export async function collectPosthog(env: Env): Promise<number> {
  const get = client(env);
  const pid = await projectId(env, get);
  const fetched = nowIso();
  let n = 0;
  for (const dash of env.POSTHOG_DASHBOARDS.split(",").map((d) => d.trim()).filter(Boolean)) {
    const body = await get(`/api/projects/${pid}/dashboards/${dash}/`);
    const rows = tilesToRows(dash, body.tiles ?? []);
    const stmts = [env.DB.prepare("DELETE FROM ph_insights WHERE dashboard_id = ?").bind(dash)];
    for (const r of rows) {
      stmts.push(
        env.DB.prepare(
          "INSERT OR REPLACE INTO ph_insights (short_id, dashboard_id, name, position, kind, display, query, result, computed_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(r.short_id, r.dashboard_id, r.name, r.position, r.kind, r.display, r.query, r.result, r.computed_at, fetched),
      );
    }
    await env.DB.batch(stmts);
    n += rows.length;
  }
  return n;
}

// ---------- live queries with a date range ----------

export interface RangeInput { preset?: string; from?: string; to?: string; interval?: string; compare?: boolean }

const PRESETS: Record<string, { date_from: string; date_to?: string }> = {
  today: { date_from: "dStart" },
  yesterday: { date_from: "-1dStart", date_to: "-1dEnd" },
  "7d": { date_from: "-7d" },
  "14d": { date_from: "-14d" },
  "30d": { date_from: "-30d" },
  "90d": { date_from: "-90d" },
  "180d": { date_from: "-180d" },
  "365d": { date_from: "-365d" },
  mtd: { date_from: "mStart" },
};

export function dateRangeFor(r: RangeInput): { date_from: string; date_to?: string } | null {
  if (r.from && /^\d{4}-\d{2}-\d{2}$/.test(r.from)) {
    const to = r.to && /^\d{4}-\d{2}-\d{2}$/.test(r.to) ? r.to : undefined;
    return { date_from: r.from, ...(to ? { date_to: to } : {}) };
  }
  if (r.preset && PRESETS[r.preset]) return PRESETS[r.preset];
  return null; // keep the insight's own range
}

/** Strips "(last 30 days)" style suffixes, since the range now comes from the picker. */
export const cleanName = (name: string) => name.replace(/\s*\((last|past)\s+\d+\s+\w+\)\s*$/i, "").trim();

export function buildQuery(source: Record<string, any>, r: RangeInput): Record<string, any> {
  const q = structuredClone(source);
  const range = dateRangeFor(r);
  if (range) q.dateRange = { ...(q.dateRange ?? {}), date_from: range.date_from, date_to: range.date_to ?? null };
  if (q.kind === "TrendsQuery") {
    const weeklyOrMonthly = (q.series ?? []).some((s: any) => s.math === "weekly_active" || s.math === "monthly_active");
    if (r.interval && ["hour", "day", "week", "month"].includes(r.interval) && !weeklyOrMonthly) q.interval = r.interval;
    if (r.compare && q.trendsFilter?.display === "BoldNumber") q.compareFilter = { compare: true };
  }
  return q;
}

export interface LiveInsight {
  short_id: string;
  dashboard_id: string;
  name: string;
  kind: string | null;
  display: string | null;
  result: unknown;
  fetched_at: string | null;
  error?: string;
}

export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

type StoredInsight = { short_id: string; dashboard_id: string; name: string; kind: string | null; display: string | null; query: string | null; result: string; fetched_at: string };

/**
 * Re-runs each stored insight's query with the chosen range (cached 5 min).
 * D1 work is kept to 3 calls whatever the number of insights (free plan: 50 queries per request).
 */
export async function liveInsights(env: Env, r: RangeInput, maxAgeSec = 300, only?: (row: StoredInsight) => boolean): Promise<LiveInsight[]> {
  let rows = (
    await env.DB.prepare("SELECT short_id, dashboard_id, name, kind, display, query, result, fetched_at FROM ph_insights ORDER BY dashboard_id, position").all<StoredInsight>()
  ).results;
  if (only) rows = rows.filter(only);
  if (!rows.length) return [];
  let get: Get | null = null;
  let pid = "";
  try {
    get = client(env);
    pid = await projectId(env, get);
  } catch {
    get = null;
  }
  const range = dateRangeFor(r);
  const keyFor = (id: string) => [id, range?.date_from ?? "", range?.date_to ?? "", r.interval ?? "", r.compare ? 1 : 0].join("|");
  const cutoff = new Date(Date.now() - maxAgeSec * 1000).toISOString();
  const keys = rows.map((row) => keyFor(row.short_id));
  const cached = new Map(
    (
      await env.DB.prepare("SELECT key, result, fetched_at FROM ph_cache WHERE fetched_at > ?1 AND key IN (SELECT value FROM json_each(?2))")
        .bind(cutoff, JSON.stringify(keys))
        .all<{ key: string; result: string; fetched_at: string }>()
    ).results.map((x) => [x.key, x]),
  );
  const fresh: { key: string; result: string; at: string }[] = [];

  const out = await pool(rows, 4, async (row): Promise<LiveInsight> => {
    const base = { short_id: row.short_id, dashboard_id: row.dashboard_id, name: range ? cleanName(row.name) : row.name, kind: row.kind, display: row.display };
    const key = keyFor(row.short_id);
    const hit = cached.get(key);
    if (hit) return { ...base, result: JSON.parse(hit.result), fetched_at: hit.fetched_at };
    if (!get || !row.query) {
      return { ...base, result: JSON.parse(row.result), fetched_at: row.fetched_at, ...(row.query ? { error: "PostHog unreachable, showing the last hourly copy" } : {}) };
    }
    try {
      const body = await get(`/api/projects/${pid}/query/`, { method: "POST", body: JSON.stringify({ query: buildQuery(JSON.parse(row.query), r), refresh: "blocking" }) });
      const result = body.results ?? body.result ?? null;
      const at = nowIso();
      fresh.push({ key, result: JSON.stringify(result), at });
      return { ...base, result, fetched_at: at };
    } catch (e) {
      return { ...base, result: JSON.parse(row.result), fetched_at: row.fetched_at, error: e instanceof Error ? e.message : String(e) };
    }
  });
  if (fresh.length) {
    await env.DB.prepare("INSERT OR REPLACE INTO ph_cache (key, result, fetched_at) SELECT json_extract(value,'$.key'), json_extract(value,'$.result'), json_extract(value,'$.at') FROM json_each(?1)")
      .bind(JSON.stringify(fresh))
      .run();
  }
  return out;
}
