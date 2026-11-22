import type { Env } from "./env";
import { getConfig, nowIso } from "./env";

// Pulls every insight tile on the configured dashboards, using PostHog's cached
// results (no forced recompute). New tiles added in PostHog show up on their own.

interface Tile {
  insight?: {
    short_id: string;
    name?: string | null;
    derived_name?: string | null;
    result?: unknown;
    last_refresh?: string | null;
    query?: { kind?: string; source?: { kind?: string } } | null;
  } | null;
  layouts?: { sm?: { y?: number; x?: number } };
}

export interface InsightRow { short_id: string; dashboard_id: string; name: string; position: number; kind: string | null; result: string; computed_at: string | null }

export function tilesToRows(dashboardId: string, tiles: Tile[]): InsightRow[] {
  return tiles
    .filter((t) => t.insight?.short_id)
    .map((t, i) => {
      const ins = t.insight!;
      const pos = (t.layouts?.sm?.y ?? i) * 100 + (t.layouts?.sm?.x ?? 0);
      return {
        short_id: ins.short_id,
        dashboard_id: dashboardId,
        name: ins.name || ins.derived_name || ins.short_id,
        position: pos,
        kind: ins.query?.source?.kind ?? ins.query?.kind ?? null,
        result: JSON.stringify(ins.result ?? null),
        computed_at: ins.last_refresh ?? null,
      };
    });
}

async function projectId(env: Env, get: (p: string) => Promise<any>): Promise<string> {
  if (env.POSTHOG_PROJECT_ID) return env.POSTHOG_PROJECT_ID;
  const cached = await getConfig<string | null>(env.DB, "posthog_project_id", null);
  if (cached) return cached;
  // A key limited to one project can read "@current" but often not the project list.
  let id = "";
  try {
    id = String((await get("/api/projects/@current/")).id ?? "");
  } catch {
    const body = await get("/api/projects/");
    id = String(body.results?.[0]?.id ?? "");
  }
  if (!id) throw new Error("PostHog: the API key sees no project");
  await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('posthog_project_id', ?)").bind(JSON.stringify(id)).run();
  return id;
}

export async function collectPosthog(env: Env): Promise<number> {
  if (!env.POSTHOG_API_KEY) throw new Error("POSTHOG_API_KEY not set");
  const get = async (path: string) => {
    const res = await fetch(env.POSTHOG_HOST + path, { headers: { Authorization: `Bearer ${env.POSTHOG_API_KEY}` } });
    if (res.status === 401 || res.status === 403)
      throw new Error(`PostHog ${path}: HTTP ${res.status}. The key needs Read on Project, Dashboard, Insight and Query, and access to this project`);
    if (!res.ok) throw new Error(`PostHog ${path}: HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };
  const pid = await projectId(env, get);
  const fetched = nowIso();
  let n = 0;
  for (const dash of env.POSTHOG_DASHBOARDS.split(",").map((d) => d.trim()).filter(Boolean)) {
    const body = await get(`/api/projects/${pid}/dashboards/${dash}/`);
    const rows = tilesToRows(dash, body.tiles ?? []);
    const stmts = [env.DB.prepare("DELETE FROM ph_insights WHERE dashboard_id = ?").bind(dash)];
    for (const r of rows) {
      stmts.push(
        env.DB.prepare("INSERT OR REPLACE INTO ph_insights (short_id, dashboard_id, name, position, kind, result, computed_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(r.short_id, r.dashboard_id, r.name, r.position, r.kind, r.result, r.computed_at, fetched),
      );
    }
    await env.DB.batch(stmts);
    n += rows.length;
  }
  return n;
}
