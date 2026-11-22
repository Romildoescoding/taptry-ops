import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "./env";
import { getConfig, nowIso, recordRun } from "./env";
import { LOGIN_PAGE, SESSION_COOKIE, SESSION_DAYS, clearFails, cookieHeader, lockedFor, makeSession, passwordMatches, recordFail, sessionValid } from "./auth";
import { verifyIngest } from "./hmac";
import { collectCosts, collectFleet, type CostRow, type FleetItem } from "./aws";
import { collectPosthog, liveInsights, type RangeInput } from "./posthog";
import { summarize } from "./costs";
import { ingestMail, ingestSheet, SHEET_TABS } from "./ingest";
import { collectAppDb } from "./appdb";
import { outreachSummary, parseRange, TASK_MAX_GAP } from "./outreach";
import { listLeads, leadDetail, setLeadStatus } from "./leads";
import { aiDraft, buildInbox, buildQueue, getThread, keepThread, sendReply, setQueueState } from "./inbox";
import { gasCall, INBOXES, isInbox, saveWebapp } from "./gas";
import { buildDigest } from "./digest";

type Ctx = { Bindings: Env; Variables: { body: string } };
const app = new Hono<Ctx>();

// ---------- Login ----------
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

// ---------- helpers ----------
type C = Context<Ctx, any, any>;
const rangeQ = (c: C) => ({ preset: c.req.query("preset"), from: c.req.query("from"), to: c.req.query("to") });
const phQ = (c: C): RangeInput => ({ ...rangeQ(c), interval: c.req.query("interval") || undefined, compare: c.req.query("compare") !== "0" });
const errJson = (c: C, e: unknown, status: 400 | 404 | 500 | 502 = 500) => c.json({ error: e instanceof Error ? e.message : String(e) }, status);

async function costSummary(env: Env) {
  const db = env.DB;
  const [rows, fleet, budget, prices, ipv4, taken] = await Promise.all([
    db.prepare("SELECT day, service, region, usd FROM aws_cost_daily").all<CostRow>(),
    db.prepare("SELECT region, kind, resource_id, detail, state, size_gb, launched_at FROM aws_fleet").all<FleetItem>(),
    getConfig<number | null>(db, "aws_budget_usd", null),
    getConfig<Record<string, number>>(db, "ec2_prices", {}),
    getConfig<number>(db, "ipv4_usd_per_hour", 0.005),
    db.prepare("SELECT max(taken_at) t FROM aws_fleet").first<{ t: string | null }>(),
  ]);
  const s = summarize(rows.results, new Date(), { budget, fleet: fleet.results, prices, ipv4PerHour: ipv4 });
  return {
    month: s.month, through: s.through, mtd: s.mtd, changePct: s.changePct, forecast: s.forecast, avg7: s.avg7,
    lastMonthSameDay: s.lastMonthSameDay, daily: s.daily, runRatePerDay: s.fleet.runRatePerDay,
    instancesRunning: s.fleet.instancesRunning, unpricedTypes: s.fleet.unpricedTypes, fleetTakenAt: taken?.t ?? null,
  };
}

// ---------- API ----------
app.get("/api/overview", async (c) => {
  const r = parseRange(rangeQ(c));
  const [outreach, queue, costs, product] = await Promise.all([
    outreachSummary(c.env, r),
    buildQueue(c.env),
    costSummary(c.env),
    // Product numbers on the overview use each insight's own PostHog range, so they match PostHog exactly.
    liveInsights(c.env, { compare: true }, 300, (row) =>
      row.display === "BoldNumber" || (row.kind === "TrendsQuery" && /daily active|weekly active|\bDAU|\bWAU/i.test(row.name)),
    ).catch(() => []),
  ]);
  const needs = queue.filter((q) => q.priority <= 1);
  return c.json({ outreach, queue: { count: needs.length, urgent: queue.filter((q) => q.priority === 0).length, low: queue.length - needs.length, top: queue.slice(0, 5) }, costs, product, host: c.env.POSTHOG_HOST });
});

app.get("/api/outreach", async (c) => c.json(await outreachSummary(c.env, parseRange(rangeQ(c)))));
app.get("/api/costs", async (c) => c.json(await costSummary(c.env)));
app.get("/api/product", async (c) => c.json({ insights: await liveInsights(c.env, phQ(c)), host: c.env.POSTHOG_HOST }));

app.get("/api/leads", async (c) => c.json(await listLeads(c.env, c.req.query())));
app.get("/api/leads/:email", async (c) => {
  const d = await leadDetail(c.env, decodeURIComponent(c.req.param("email")));
  return d ? c.json(d) : c.json({ error: "not found" }, 404);
});
app.post("/api/leads/:email/status", async (c) => {
  try {
    const { status } = await c.req.json<{ status: string }>();
    await setLeadStatus(c.env, decodeURIComponent(c.req.param("email")), status);
    return c.json({ ok: true });
  } catch (e) { return errJson(c, e, 400); }
});

app.get("/api/inbox", async (c) => c.json(await buildInbox(c.env)));
app.post("/api/inbox/keep", async (c) => {
  const { key, messageId } = await c.req.json<{ key?: string; messageId?: string }>();
  if (!key || !messageId) return c.json({ error: "bad request" }, 400);
  await keepThread(c.env, key, messageId);
  return c.json({ ok: true });
});
app.post("/api/inbox/state", async (c) => {
  const { key, state, hours } = await c.req.json<{ key: string; state: "handled" | "snoozed" | "dead" | "open"; hours?: number }>();
  if (!key || !["handled", "snoozed", "dead", "open"].includes(state)) return c.json({ error: "bad request" }, 400);
  await setQueueState(c.env, key, state, hours ?? 24);
  return c.json({ ok: true });
});

app.get("/api/thread/:inbox/:id", async (c) => {
  try { return c.json(await getThread(c.env, c.req.param("inbox"), c.req.param("id"))); } catch (e) { return errJson(c, e, 400); }
});
app.post("/api/thread/:inbox/:id/reply", async (c) => {
  try {
    const { body, escalationId } = await c.req.json<{ body: string; escalationId?: string }>();
    return c.json(await sendReply(c.env, c.req.param("inbox"), c.req.param("id"), body, escalationId));
  } catch (e) { return errJson(c, e, 502); }
});
app.post("/api/thread/:inbox/:id/draft", async (c) => {
  try {
    const { note } = await c.req.json<{ note?: string }>().catch(() => ({ note: undefined }));
    return c.json(await aiDraft(c.env, c.req.param("inbox"), c.req.param("id"), note));
  } catch (e) { return errJson(c, e, 502); }
});

app.get("/api/system", async (c) => {
  const db = c.env.DB;
  const [runs, pushes, tasks] = await db.batch([
    db.prepare(
      `SELECT r.collector, r.started_at, r.finished_at, r.ok, r.rows, r.error,
              (SELECT max(started_at) FROM collector_runs WHERE collector = r.collector AND ok = 1) AS last_ok
       FROM collector_runs r WHERE r.started_at = (SELECT max(started_at) FROM collector_runs WHERE collector = r.collector)`,
    ),
    db.prepare("SELECT key, value FROM config WHERE key LIKE 'last_push_%' OR key LIKE 'gas_url_%'"),
    db.prepare("SELECT family, max(run_at) last FROM run_log GROUP BY family"),
  ]);
  const cfg = Object.fromEntries((pushes.results as { key: string; value: string }[]).map((r) => [r.key, JSON.parse(r.value)]));
  const lastTask = new Map((tasks.results as { family: string; last: string }[]).map((t) => [t.family, t.last]));
  return c.json({
    collectors: runs.results,
    scripts: [
      { name: "Tracker sheet", last: ["Leads", "Escalations", "Nudges", "Log"].map((t) => cfg[`last_push_sheet_${t}`]).filter(Boolean).sort().pop() ?? null, maxMinutes: 20 },
      ...INBOXES.map((i) => ({ name: `${i}@ inbox`, inbox: i, last: cfg[`last_push_mail_${i}`] ?? null, maxMinutes: 20, webapp: !!cfg[`gas_url_${i}`], webappUrl: cfg[`gas_url_${i}`] ?? null })),
    ],
    tasks: Object.entries(TASK_MAX_GAP).map(([k, v]) => ({ family: k, label: v.label, last: lastTask.get(k) ?? null, maxHours: v.hours })),
    secrets: {
      aws: !!(c.env.AWS_ACCESS_KEY_ID && c.env.AWS_SECRET_ACCESS_KEY),
      posthog: !!c.env.POSTHOG_API_KEY,
      appdb: !!c.env.APPDB_URL,
      ingest: !!c.env.INGEST_SECRET,
      ai: !!c.env.ANTHROPIC_API_KEY,
    },
  });
});

// Which collectors are stale, so the app can refresh them right after you open it.
const STALE_AFTER_MIN: Record<string, number> = { aws_fleet: 60, aws_cost: 20 * 60, posthog: 60, appdb: 15, mail_sync: 10 };
app.get("/api/stale", async (c) => {
  const rows = (await c.env.DB.prepare("SELECT collector, max(started_at) last FROM collector_runs GROUP BY collector").all<{ collector: string; last: string }>()).results;
  const last = new Map(rows.map((r) => [r.collector, r.last]));
  const stale = Object.entries(STALE_AFTER_MIN)
    .filter(([k]) => JOBS[k] && ENABLED[k](c.env))
    .filter(([k, min]) => !last.get(k) || Date.now() - Date.parse(last.get(k)!) > min * 60000)
    .map(([k]) => k);
  // Insights saved before live queries existed have no query yet: refresh them now.
  if (!stale.includes("posthog") && ENABLED.posthog(c.env)) {
    const old = await c.env.DB.prepare("SELECT count(*) n FROM ph_insights WHERE query IS NULL").first<{ n: number }>();
    if (old?.n) stale.push("posthog");
  }
  return c.json({ stale });
});

app.put("/api/webapp/:inbox", async (c) => {
  const inbox = c.req.param("inbox");
  if (!isInbox(inbox)) return c.json({ ok: false, error: "unknown inbox" }, 400);
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }));
  return c.json(await saveWebapp(c.env, inbox, url ?? ""));
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
  await c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(key, JSON.stringify(await c.req.json())).run();
  return c.json({ ok: true });
});

app.post("/api/run/:collector", async (c) => {
  const name = c.req.param("collector");
  const job = JOBS[name];
  if (!job) return c.json({ error: "unknown collector" }, 404);
  await recordRun(c.env.DB, name, () => job(c.env));
  const row = await c.env.DB.prepare("SELECT ok, rows, error FROM collector_runs WHERE collector = ? ORDER BY started_at DESC LIMIT 1").bind(name).first();
  return c.json(row ?? { ok: 0 });
});

// ---------- Ingest (Apps Scripts, HMAC-signed) ----------
app.use("/ingest/*", async (c, next) => {
  const body = await c.req.text();
  const ok = await verifyIngest(c.env.INGEST_SECRET, c.req.header("X-TT-Timestamp") ?? null, c.req.header("X-TT-Signature") ?? null, body);
  if (!ok) return c.json({ error: "bad signature" }, 401);
  c.set("body", body);
  return next();
});
const bodyJson = <T>(c: C): T => JSON.parse(c.get("body") || "{}");

app.post("/ingest/v1/sheet/:tab", async (c) => {
  const tab = c.req.param("tab");
  if (!SHEET_TABS[tab]) return c.json({ error: "unknown tab" }, 404);
  try { return c.json({ ok: true, ...(await ingestSheet(c.env, tab, bodyJson(c))) }); } catch (e) { return errJson(c, e, 400); }
});
app.post("/ingest/v1/mail/:inbox", async (c) => {
  const inbox = c.req.param("inbox");
  if (!isInbox(inbox)) return c.json({ error: "unknown inbox" }, 404);
  try { return c.json({ ok: true, written: await ingestMail(c.env, inbox, bodyJson(c)) }); } catch (e) { return errJson(c, e, 400); }
});
app.post("/ingest/v1/sheet-updates", async (c) => {
  const { ack } = bodyJson<{ ack?: number[] }>(c);
  if (ack?.length) {
    await c.env.DB.prepare(`UPDATE sheet_updates SET applied_at = ? WHERE id IN (${ack.map(() => "?").join(",")})`).bind(nowIso(), ...ack).run();
  }
  const pending = await c.env.DB.prepare("SELECT id, tab, key, col, value FROM sheet_updates WHERE applied_at IS NULL ORDER BY id LIMIT 200").all();
  return c.json({ ok: true, updates: pending.results });
});
app.post("/ingest/v1/digest", async (c) => c.json({ ok: true, ...(await buildDigest(c.env)) }));

app.all("/ingest/*", (c) => c.json({ error: "not found" }, 404));
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// Logged in: serve the UI.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ---------- Jobs and schedules (UTC) ----------
const JOBS: Record<string, (env: Env) => Promise<number>> = {
  aws_cost: (env) => collectCosts(env),
  aws_fleet: collectFleet,
  posthog: collectPosthog,
  appdb: collectAppDb,
  mail_sync: async (env) => {
    // Asks each inbox script to push new mail now, instead of waiting for its 5-minute timer.
    const results = await Promise.allSettled(INBOXES.map((i) => gasCall(env, i, "sync", {}, 25000)));
    const failed = results.map((r, i) => (r.status === "rejected" ? `${INBOXES[i]}: ${(r.reason as Error)?.message ?? r.reason}` : "")).filter(Boolean);
    if (failed.length === INBOXES.length) throw new Error(failed.join(" | "));
    return INBOXES.length - failed.length;
  },
};
const ENABLED: Record<string, (env: Env) => boolean> = {
  aws_cost: (e) => !!e.AWS_ACCESS_KEY_ID,
  aws_fleet: (e) => !!e.AWS_ACCESS_KEY_ID,
  posthog: (e) => !!e.POSTHOG_API_KEY,
  appdb: (e) => !!e.APPDB_URL,
  mail_sync: (e) => !!e.INGEST_SECRET,
};

const SCHEDULE: Record<string, string[]> = {
  "*/15 * * * *": [],
  "5 * * * *": ["posthog", "aws_fleet", "appdb"],
  "0 3 * * *": ["aws_cost", "cleanup"],
};

async function cleanup(env: Env): Promise<void> {
  const day = new Date(Date.now() - 86400000).toISOString();
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ph_cache WHERE fetched_at < ?").bind(day),
    env.DB.prepare("DELETE FROM sheet_updates WHERE applied_at IS NOT NULL AND applied_at < ?").bind(week),
    env.DB.prepare("DELETE FROM collector_runs WHERE started_at < ?").bind(new Date(Date.now() - 30 * 86400000).toISOString()),
    env.DB.prepare("DELETE FROM login_attempts WHERE window_start < ?").bind(Math.floor(Date.now() / 1000) - 86400),
  ]);
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    for (const name of SCHEDULE[event.cron] ?? []) {
      if (name === "cleanup") ctx.waitUntil(cleanup(env));
      else if (ENABLED[name](env)) ctx.waitUntil(recordRun(env.DB, name, () => JOBS[name](env)));
    }
  },
} satisfies ExportedHandler<Env>;
