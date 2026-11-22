import type { Env } from "./env";
import { getConfig } from "./env";
import { outreachSummary, parseRange } from "./outreach";
import { buildQueue } from "./inbox";
import { summarize } from "./costs";
import type { CostRow, FleetItem } from "./aws";
import { liveInsights } from "./posthog";

// The 9:00 AM email. Built here; the tracker's Apps Script fetches it and sends it
// from connect@ to OWNER_EMAIL. Table layout and inline styles, so Gmail renders it.

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const n = (v: number | null | undefined) => (v == null ? "–" : Number(v).toLocaleString("en-IN"));
const usd = (v: number | null | undefined) => (v == null ? "–" : "$" + Number(v).toFixed(2));
const DASH = "https://ops.taptry.in";

const label = (t: string) => `<div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#64748b;font-weight:600;margin-top:28px">${t}</div>`;
const btn = (href: string, text: string, dark = true) =>
  `<a href="${href}" style="display:inline-block;${dark ? "background:#141414;color:#fff;" : "border:1px solid #cbd5e1;color:#141414;"}text-decoration:none;font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px;margin:4px 4px 0 0">${esc(text)}</a>`;
const tile = (v: string, l: string, color = "#141414") =>
  `<td width="25%" align="center" style="padding:12px 4px;background:#f5f5f5;border-radius:10px"><div style="font-size:26px;font-weight:800;color:${color}">${v}</div><div style="font-size:11px;color:#64748b">${l}</div></td>`;
const bar = (pct: number, color: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="${Math.max(1, Math.round(pct))}%" height="10" style="background:${color};font-size:0;line-height:0;border-radius:3px">&nbsp;</td><td style="font-size:0;line-height:0">&nbsp;</td></tr></table>`;

export async function buildDigest(env: Env): Promise<{ to: string; subject: string; html: string }> {
  const yday = parseRange({ preset: "yesterday" });
  const week = parseRange({ preset: "7d" });
  const [o, w, queue] = await Promise.all([outreachSummary(env, yday), outreachSummary(env, week), buildQueue(env)]);
  const [rows, fleet, budget, prices, ipv4] = await Promise.all([
    env.DB.prepare("SELECT day, service, region, usd FROM aws_cost_daily").all<CostRow>(),
    env.DB.prepare("SELECT region, kind, resource_id, detail, state, size_gb, launched_at FROM aws_fleet").all<FleetItem>(),
    getConfig<number | null>(env.DB, "aws_budget_usd", null),
    getConfig<Record<string, number>>(env.DB, "ec2_prices", {}),
    getConfig<number>(env.DB, "ipv4_usd_per_hour", 0.005),
  ]);
  const cost = summarize(rows.results, new Date(), { budget, fleet: fleet.results, prices, ipv4PerHour: ipv4 });
  let product: { name: string; value: number }[] = [];
  try {
    const live = await liveInsights(env, { preset: "7d" }, 3600);
    product = live
      .filter((i) => i.display === "BoldNumber" && Array.isArray(i.result) && (i.result as any[])[0])
      .slice(0, 3)
      .map((i) => ({ name: i.name, value: Number((i.result as any[])[0].aggregated_value ?? (i.result as any[])[0].count ?? 0) }));
  } catch { /* PostHog optional in the digest */ }

  const t = o.totals;
  const p0 = queue.filter((q) => q.priority === 0).length;
  const maxDay = Math.max(1, ...w.daily.map((d) => d.first + d.followups));
  const dateLabel = new Date(yday.from + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  const queueHtml = queue.length
    ? queue.slice(0, 4).map((q) => `
      <tr><td style="padding:12px 14px;border-bottom:1px solid #e9e9e9">
        <span style="display:inline-block;background:${q.priority === 0 ? "#fee2e2;color:#b91c1c" : q.priority === 1 ? "#fef3c7;color:#92400e" : "#e9e9e9;color:#475569"};font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px">P${q.priority}</span>
        <div style="font-size:15px;font-weight:700;margin-top:6px">${esc(q.title)}</div>
        <div style="font-size:13px;color:#475569;margin-top:2px">${esc(q.detail.slice(0, 180))}</div>
        <div>${btn(`${DASH}/#inbox/${encodeURIComponent(q.key)}`, q.kind === "reply" || q.kind === "escalation" ? "Reply" : "Open")}</div>
      </td></tr>`).join("")
    : `<tr><td style="padding:14px;color:#64748b;font-size:14px">Nothing waiting. Nice.</td></tr>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef0f4">
<div style="display:none;max-height:0;overflow:hidden">${queue.length} need you · ${n(t.emailsSent)} sent · ${n(t.replied)} replies · AWS ${usd(cost.mtd)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f4"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141414">
<tr><td style="background:#141414;padding:20px 22px;border-radius:12px 12px 0 0">
  <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#a3a3a3">TapTry daily</div>
  <div style="font-size:22px;font-weight:700;color:#fff;margin-top:4px">${esc(dateLabel)}${p0 ? ` · <span style="color:#ff8a4c">${p0} urgent</span>` : ""}</div>
</td></tr>
<tr><td style="background:#fff;padding:6px 22px 24px">
  ${label("Needs you")}
  <div style="font-size:52px;font-weight:800;line-height:58px">${queue.length}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border:1px solid #e9e9e9;border-radius:10px">${queueHtml}</table>
  ${queue.length > 4 ? `<div style="font-size:12px;color:#64748b;margin-top:6px">+${queue.length - 4} more</div>` : ""}
  <div>${btn(`${DASH}/#inbox`, "Open inbox")}</div>

  ${label("Outreach yesterday")}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="4" style="margin-top:8px"><tr>
    ${tile(n(t.emailsSent), "sent")}${tile(n(t.followups), "follow-ups")}${tile(n(t.replied), "positive replies", "#047857")}${tile(t.bounceRate == null ? "–" : t.bounceRate + "%", "bounce")}
  </tr></table>
  <div style="font-size:13px;font-weight:700;margin-top:16px">Emails sent, last 7 days</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;font-size:12px;color:#475569">
  ${w.daily.map((d) => `<tr><td width="62" style="padding:2px 0">${esc(d.day.slice(5))}</td><td style="padding:2px 8px">${bar(((d.first + d.followups) / maxDay) * 100, "#141414")}</td><td width="40" align="right">${n(d.first + d.followups)}</td></tr>`).join("")}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;font-size:13px">
  ${o.inboxes.map((i) => `<tr><td style="padding:5px 0;border-bottom:1px solid #f1f5f9">${i.inbox}@</td><td align="right" style="border-bottom:1px solid #f1f5f9">${i.newToday}/${i.newCap} new today</td><td align="right" style="border-bottom:1px solid #f1f5f9;color:${(i.bounce3d ?? 0) > 4 ? "#b45309" : "#475569"}">${i.bounce3d ?? 0}% bounce 3d</td></tr>`).join("")}
  </table>

  ${product.length ? `${label("Product, last 7 days")}<table role="presentation" width="100%" cellpadding="0" cellspacing="4" style="margin-top:8px"><tr>${product.map((p) => tile(n(p.value), esc(p.name))).join("")}</tr></table>` : ""}

  ${label("AWS this month")}
  <div style="margin-top:6px"><span style="font-size:36px;font-weight:800">${usd(cost.mtd)}</span><span style="font-size:13px;color:#64748b"> to ${esc(cost.through ?? "–")} · forecast <b>${usd(cost.forecast)}</b></span></div>
  ${cost.fleet.stockholmLeftovers.length ? `<div style="font-size:13px;color:#b45309;margin-top:4px">Still in Stockholm: ${esc(cost.fleet.stockholmLeftovers.join(", "))}</div>` : ""}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:26px;border-top:1px solid #e9e9e9"><tr><td align="center" style="padding-top:16px">
    ${btn(DASH, "Open dashboard")}${btn(`${DASH}/#outreach`, "Outreach", false)}${btn(`${DASH}/#leads`, "Leads", false)}${btn(`${DASH}/#product`, "Product", false)}
  </td></tr></table>
</td></tr>
<tr><td align="center" style="padding:12px;font-size:11px;color:#94a3b8">TapTry Ops · every day at 9:00 AM IST</td></tr>
</table></td></tr></table></body></html>`;
  return { to: env.OWNER_EMAIL, subject: `TapTry daily · ${dateLabel} · ${queue.length} need you`, html };
}
