import { Hono } from "hono";
import type { Env } from "./env";
import { getConfig, recordRun } from "./env";
import { verifyAccessJwt } from "./access";
import { collectCosts, collectFleet, type CostRow, type FleetItem } from "./aws";
import { collectPosthog } from "./posthog";
import { summarize } from "./costs";

type Ctx = { Bindings: Env; Variables: { email: string } };
const app = new Hono<Ctx>();

// ---------- Access gate for /api ----------
app.use("/api/*", async (c, next) => {
  if (!c.env.ACCESS_AUD || !c.env.ACCESS_TEAM_DOMAIN) {
    // Only `wrangler dev` may run without Access: LOCAL_DEV comes from .dev.vars,
    // which is gitignored and never deployed.
    if (c.env.LOCAL_DEV === "1") {
      c.set("email", "local-dev");
      return next();
    }
    return c.json({ error: "Access is not configured on this Worker" }, 500);
  }
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    const { email } = await verifyAccessJwt(token, { teamDomain: c.env.ACCESS_TEAM_DOMAIN, aud: c.env.ACCESS_AUD });
    c.set("email", email);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

// ---------- API ----------
app.get("/api/costs", async (c) => {
  const db = c.env.DB;
  const [rows, fleet, budget, prices, ipv4] = await Promise.all([
    db.prepare("SELECT day, service, region, usd FROM aws_cost_daily").all<CostRow>(),
    db.prepare("SELECT region, kind, resource_id, detail, state, size_gb, launched_at FROM aws_fleet").all<FleetItem>(),
    getConfig<number | null>(db, "aws_budget_usd", null),
    getConfig<Record<string, number>>(db, "ec2_prices", {}),
    getConfig<number>(db, "ipv4_usd_per_hour", 0.005),
  ]);
  const fleetTaken = await db.prepare("SELECT max(taken_at) t FROM aws_fleet").first<{ t: string | null }>();
  return c.json({
    ...summarize(rows.results, new Date(), { budget, fleet: fleet.results, prices, ipv4PerHour: ipv4 }),
    fleetTakenAt: fleetTaken?.t ?? null,
  });
});

app.get("/api/product", async (c) => {
  const rows = await c.env.DB
    .prepare("SELECT short_id, dashboard_id, name, kind, result, computed_at, fetched_at FROM ph_insights ORDER BY dashboard_id, position")
    .all<{ short_id: string; dashboard_id: string; name: string; kind: string | null; result: string; computed_at: string | null; fetched_at: string }>();
  const dashboards: Record<string, unknown[]> = {};
  for (const r of rows.results) {
    (dashboards[r.dashboard_id] ??= []).push({ ...r, result: JSON.parse(r.result) });
  }
  return c.json({ dashboards, host: c.env.POSTHOG_HOST });
});

app.get("/api/system", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.collector, r.started_at, r.finished_at, r.ok, r.rows, r.error,
            (SELECT max(started_at) FROM collector_runs WHERE collector = r.collector AND ok = 1) AS last_ok
     FROM collector_runs r
     WHERE r.started_at = (SELECT max(started_at) FROM collector_runs WHERE collector = r.collector)`,
  ).all();
  return c.json({ collectors: rows.results });
});

app.put("/api/config/:key", async (c) => {
  const allowed = ["aws_budget_usd", "ec2_prices", "ipv4_usd_per_hour"];
  const key = c.req.param("key");
  if (!allowed.includes(key)) return c.json({ error: "unknown setting" }, 400);
  const value = await c.req.json();
  await c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(key, JSON.stringify(value)).run();
  return c.json({ ok: true });
});

// Run a collector now from the System tab, instead of waiting for its schedule.
app.post("/api/run/:collector", async (c) => {
  const job = JOBS[c.req.param("collector")];
  if (!job) return c.json({ error: "unknown collector" }, 404);
  await recordRun(c.env.DB, c.req.param("collector"), () => job(c.env));
  return c.json({ ok: true });
});

// Phase 2 adds /ingest/v1/* (HMAC-checked, see hmac.ts).
app.all("/ingest/*", (c) => c.json({ error: "not yet" }, 404));
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// ---------- Schedules (UTC) ----------
const JOBS: Record<string, (env: Env) => Promise<number>> = {
  aws_cost: (env) => collectCosts(env),
  aws_fleet: collectFleet,
  posthog: collectPosthog,
};

const SCHEDULE: Record<string, string[]> = {
  "*/15 * * * *": [], // Phase 2: app DB, queue rebuild, P0 check
  "5 * * * *": ["posthog", "aws_fleet"],
  "0 3 * * *": ["aws_cost"],
};

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    for (const name of SCHEDULE[event.cron] ?? []) {
      ctx.waitUntil(recordRun(env.DB, name, () => JOBS[name](env)));
    }
  },
} satisfies ExportedHandler<Env>;
