import type { Env } from "./env";

// Outreach numbers. Days are IST. First emails come from the Leads tab (exact),
// follow-ups from the tasks' Log tab, replies from Leads (status + last reply).

export const IST = "'+330 minutes'";
const istDay = (col: string) => `substr(datetime(${col}, ${IST}), 1, 10)`;

export interface Range { from: string; to: string; fromUtc: string; toUtc: string; days: string[] }

export function istToday(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}

export function parseRange(q: { from?: string; to?: string; preset?: string }, now = new Date()): Range {
  const today = istToday(now);
  const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  let from = today, to = today;
  const valid = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (valid(q.from)) {
    from = q.from!;
    to = valid(q.to) ? q.to! : today;
  } else {
    const p = q.preset ?? "30d";
    if (p === "today") from = today;
    else if (p === "yesterday") from = to = addDays(today, -1);
    else if (p === "mtd") from = today.slice(0, 8) + "01";
    else {
      const n = Number(p.replace(/\D/g, "")) || 30;
      from = addDays(today, -(n - 1));
    }
  }
  if (from > to) [from, to] = [to, from];
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) days.push(d);
  return {
    from,
    to,
    fromUtc: new Date(from + "T00:00:00+05:30").toISOString(),
    toUtc: new Date(Date.parse(to + "T00:00:00+05:30") + 86400000).toISOString(),
    days,
  };
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function outreachSummary(env: Env, r: Range) {
  const db = env.DB;
  const b = [r.fromUtc, r.toUtc];
  const [firstByDay, fuByDay, repliesByDay, cohort, bySource, byVariant, byStep, pipeline, byHour, inboxToday, bounce3d, active, lastRuns] = await db.batch([
    db.prepare(`SELECT ${istDay("first_sent_at")} d, inbox, count(*) n FROM leads WHERE first_sent_at >= ?1 AND first_sent_at < ?2 GROUP BY d, inbox`).bind(...b),
    db.prepare(`SELECT ${istDay("run_at")} d, sum(coalesce(followups,0)) n FROM run_log WHERE run_at >= ?1 AND run_at < ?2 GROUP BY d`).bind(...b),
    db.prepare(`SELECT ${istDay("last_reply_at")} d, sum(status = 'replied') pos, sum(status = 'opted_out') neg FROM leads WHERE last_reply_at >= ?1 AND last_reply_at < ?2 GROUP BY d`).bind(...b),
    db.prepare(
      `SELECT count(*) sent, sum(status='replied') replied, sum(status='opted_out') opted_out, sum(status='bounced') bounced, sum(auto_reply) auto
       FROM leads WHERE first_sent_at >= ?1 AND first_sent_at < ?2`,
    ).bind(...b),
    db.prepare(
      `SELECT source_kind k, count(*) sent, sum(status='replied') replied, sum(status='opted_out') opted_out, sum(status='bounced') bounced
       FROM leads WHERE first_sent_at >= ?1 AND first_sent_at < ?2 GROUP BY k ORDER BY sent DESC`,
    ).bind(...b),
    db.prepare(
      `SELECT coalesce(variant,'?') k, count(*) sent, sum(status='replied') replied, sum(status='opted_out') opted_out
       FROM leads WHERE first_sent_at >= ?1 AND first_sent_at < ?2 GROUP BY k ORDER BY k`,
    ).bind(...b),
    db.prepare(
      `SELECT fu_count k, count(*) leads, sum(status='replied') replied, sum(status='opted_out') opted_out
       FROM leads WHERE first_sent_at >= ?1 AND first_sent_at < ?2 GROUP BY k ORDER BY k`,
    ).bind(...b),
    db.prepare(`SELECT status k, count(*) n FROM leads GROUP BY status ORDER BY n DESC`),
    db.prepare(
      `SELECT cast(substr(datetime(sent_at, ${IST}), 12, 2) AS INTEGER) h, count(*) n FROM mail_msgs
       WHERE kind = 'human' AND sent_at >= ?1 AND sent_at < ?2 GROUP BY h`,
    ).bind(...b),
    db.prepare(`SELECT inbox k, count(*) n FROM leads WHERE first_sent_at >= ?1 GROUP BY inbox`).bind(new Date(istToday() + "T00:00:00+05:30").toISOString()),
    db.prepare(
      `SELECT inbox k, count(*) sent, sum(status='bounced') bounced FROM leads WHERE first_sent_at >= ?1 GROUP BY inbox`,
    ).bind(new Date(Date.now() - 3 * 86400000).toISOString()),
    db.prepare(
      `SELECT count(*) active,
              sum(coalesce(fu_sent_at, first_sent_at) <= ?2) due
       FROM leads WHERE status IN ('sent','followed_up') AND fu_count < 3 AND auto_reply = 0
         AND coalesce(fu_sent_at, first_sent_at) >= ?1`,
    ).bind(new Date(Date.now() - 8 * 86400000).toISOString(), new Date(Date.now() - 2 * 86400000).toISOString()),
    db.prepare(`SELECT family, max(run_at) last FROM run_log GROUP BY family`),
  ]);

  const firstMap = new Map<string, Record<string, number>>();
  for (const row of firstByDay.results as { d: string; inbox: string; n: number }[]) {
    const m = firstMap.get(row.d) ?? {};
    m[row.inbox || "?"] = (m[row.inbox || "?"] ?? 0) + row.n;
    firstMap.set(row.d, m);
  }
  const fuMap = new Map((fuByDay.results as { d: string; n: number }[]).map((x) => [x.d, x.n]));
  const repMap = new Map((repliesByDay.results as { d: string; pos: number; neg: number }[]).map((x) => [x.d, x]));
  const daily = r.days.map((d) => {
    const f = firstMap.get(d) ?? {};
    const first = Object.values(f).reduce((s, n) => s + n, 0);
    return { day: d, first, byInbox: f, followups: fuMap.get(d) ?? 0, positive: repMap.get(d)?.pos ?? 0, optOuts: repMap.get(d)?.neg ?? 0 };
  });
  const c = (cohort.results[0] ?? {}) as Record<string, number>;
  const sent = c.sent ?? 0;
  const firstTotal = daily.reduce((s, d) => s + d.first, 0);
  const fuTotal = daily.reduce((s, d) => s + d.followups, 0);
  const rate = (rows: Record<string, number | string>[]) =>
    rows.map((x) => ({ ...x, replyRate: pct(Number(x.replied) + Number(x.opted_out ?? 0), Number(x.sent ?? x.leads)), positiveRate: pct(Number(x.replied), Number(x.sent ?? x.leads)) }));

  const caps = { new: 100, total: 170 };
  const b3 = new Map((bounce3d.results as { k: string; sent: number; bounced: number }[]).map((x) => [x.k, x]));
  const today = new Map((inboxToday.results as { k: string; n: number }[]).map((x) => [x.k, x.n]));
  const inboxes = ["connect", "reachout", "hello"].map((k) => ({
    inbox: k,
    newToday: today.get(k) ?? 0,
    newCap: caps.new,
    bounce3d: pct(b3.get(k)?.bounced ?? 0, b3.get(k)?.sent ?? 0),
    sent3d: b3.get(k)?.sent ?? 0,
  }));
  const a = (active.results[0] ?? {}) as Record<string, number>;
  return {
    range: { from: r.from, to: r.to },
    totals: {
      emailsSent: firstTotal + fuTotal,
      firstEmails: firstTotal,
      followups: fuTotal,
      replied: c.replied ?? 0,
      optedOut: c.opted_out ?? 0,
      bounced: c.bounced ?? 0,
      replyRate: pct((c.replied ?? 0) + (c.opted_out ?? 0), sent),
      positiveRate: pct(c.replied ?? 0, sent),
      bounceRate: pct(c.bounced ?? 0, sent),
      activeThreads: a.active ?? 0,
      dueToday: a.due ?? 0,
    },
    daily,
    bySource: rate(bySource.results as Record<string, number | string>[]),
    byVariant: rate(byVariant.results as Record<string, number | string>[]),
    byStep: rate(byStep.results as Record<string, number | string>[]),
    pipeline: pipeline.results,
    repliesByHour: Array.from({ length: 24 }, (_, h) => (byHour.results as { h: number; n: number }[]).find((x) => x.h === h)?.n ?? 0),
    inboxes,
    taskLastRun: Object.fromEntries((lastRuns.results as { family: string; last: string }[]).map((x) => [x.family, x.last])),
  };
}

// How long each task family may go quiet before it counts as down (hours).
export const TASK_MAX_GAP: Record<string, { label: string; hours: number }> = {
  daily: { label: "Daily outreach", hours: 14 },
  warm: { label: "Warm leads", hours: 16 },
  ownapp: { label: "Own-app demos", hours: 19 },
  reply: { label: "Reply check", hours: 9 },
  nudges: { label: "Onboarding nudges", hours: 25 },
  weekly: { label: "Weekly LinkedIn + X list", hours: 24 * 8 },
};
