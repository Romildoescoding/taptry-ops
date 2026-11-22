import { Hono } from "hono";
import type { Env } from "./env";
import { getConfig, recordRun } from "./env";
import { LOGIN_PAGE, SESSION_COOKIE, SESSION_DAYS, clearFails, cookieHeader, lockedFor, makeSession, passwordMatches, recordFail, sessionValid } from "./auth";
import { getCookie } from "hono/cookie";
import { collectCosts, collectFleet, type CostRow, type FleetItem } from "./aws";
import { collectPosthog } from "./posthog";
import { summarize } from "./costs";

type Ctx = { Bindings: Env };
const app = new Hono<Ctx>();

// ---------- Login ----------
// Everything except /login, /auth/* and /ingest/* needs a valid session cookie.
app.get("/login", (c) => c.html(LOGIN_PAGE()));

app.post("/auth/login", async (c) => {
  const pw = c.env.DASH_PASSWORD;
  if (!pw) return c.html(LOGIN_PAGE("DASH_PASSWORD is not set on the Worker yet."), 500);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const wait = await lockedFor(c.env.DB, ip);
  if (wait > 0) return c.html(LOGIN_PAGE(`Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} min.`), 429);
  const form = await c.req.parseBody();
  if (!(await passwordMatches(String(form.password ?? ""), pw))) {
    await recordFail(c.env.DB, ip);
    return c.html(LOGIN_PAGE("Wrong password."), 401);
  }
  await clearFails(c.env.DB, ip);
  c.header("Set-Cookie", cookieHeader(await makeSession(pw), SESSION_DAYS * 86400));
  return c.redirect("/", 303);
});

app.post("/auth/logout", (c) => {
  c.header("Set-Cookie", cookieHeader("", 0));
  return c.redirect("/login", 303);
});

app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/login" || path.startsWith("/auth/") || path.startsWith("/ingest/")) return next();
  if (c.env.LOCAL_DEV === "1" && !c.env.DASH_PASSWORD) return next(); // wrangler dev only (.dev.vars)
  const ok = c.env.DASH_PASSWORD && (await sessionValid(getCookie(c, SESSION_COOKIE), c.env.DASH_PASSWORD));
  if (ok) return next();
  return path.startsWith("/api/") ? c.json({ error: "unauthorized" }, 401) : c.redirect("/login", 302);
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

app.get("/api/config", async (c) => {
  const db = c.env.DB;
  return c.json({
    aws_budget_usd: await getConfig<number | null>(db, "aws_budget_usd", null),
    ec2_prices: await getConfig<Record<string, number>>(db, "ec2_prices", {}),
    ipv4_usd_per_hour: await getConfig<number>(db, "ipv4_usd_per_hour", 0.005),
  });
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

// Logged in: serve the UI.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

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
