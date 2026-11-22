import type { Env } from "./env";
import { nowIso } from "./env";

const SORTS: Record<string, string> = {
  first_sent: "first_sent_at",
  last_reply: "last_reply_at",
  last_touch: "coalesce(last_reply_at, fu_sent_at, first_sent_at)",
  developer: "lower(developer)",
  app: "lower(app)",
  installs: "cast(replace(replace(replace(installs, ',', ''), '+', ''), ' ', '') AS INTEGER)",
  status: "status",
  followups: "fu_count",
};

export interface LeadQuery { status?: string; source?: string; inbox?: string; q?: string; sort?: string; dir?: string; page?: string; size?: string; from?: string; to?: string }

export async function listLeads(env: Env, p: LeadQuery) {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => { where.push(sql); args.push(...v); };
  if (p.status) {
    const list = p.status.split(",").filter(Boolean);
    add(`status IN (${list.map(() => "?").join(",")})`, ...list);
  } else add("status NOT IN ('skip','queued')");
  if (p.source) add("source_kind = ?", p.source);
  if (p.inbox) add("inbox = ?", p.inbox);
  if (p.from) add("first_sent_at >= ?", new Date(p.from + "T00:00:00+05:30").toISOString());
  if (p.to) add("first_sent_at < ?", new Date(Date.parse(p.to + "T00:00:00+05:30") + 86400000).toISOString());
  if (p.q) {
    const like = `%${p.q.toLowerCase()}%`;
    add("(lower(email) LIKE ? OR lower(developer) LIKE ? OR lower(app) LIKE ? OR lower(greeting) LIKE ?)", like, like, like, like);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sortCol = SORTS[p.sort ?? ""] ?? SORTS.last_touch;
  const dir = p.dir === "asc" ? "ASC" : "DESC";
  const size = Math.min(100, Math.max(10, Number(p.size) || 30));
  const page = Math.max(1, Number(p.page) || 1);
  const [rows, total, facets] = await env.DB.batch([
    env.DB.prepare(
      `SELECT email, developer, greeting, app, source_kind, installs, status, inbox, first_sent_at, fu_sent_at, last_reply_at, fu_count, variant, thread_id
       FROM leads ${w} ORDER BY ${sortCol} ${dir} NULLS LAST, email LIMIT ? OFFSET ?`,
    ).bind(...args, size, (page - 1) * size),
    env.DB.prepare(`SELECT count(*) n FROM leads ${w}`).bind(...args),
    env.DB.prepare(`SELECT 'status' f, status v, count(*) n FROM leads GROUP BY status UNION ALL SELECT 'source', source_kind, count(*) FROM leads GROUP BY source_kind`),
  ]);
  const n = (total.results[0] as { n: number }).n;
  return { rows: rows.results, total: n, page, size, pages: Math.max(1, Math.ceil(n / size)), facets: facets.results };
}

export async function leadDetail(env: Env, email: string) {
  const e = email.toLowerCase();
  const lead = await env.DB.prepare("SELECT * FROM leads WHERE email = ?").bind(e).first<any>();
  if (!lead) return null;
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const [msgs, escs, demo, signup, sent] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id, inbox, thread_id, direction, kind, from_addr, subject, coalesce(body, snippet) text, sent_at FROM mail_msgs WHERE (thread_id = ? AND ? <> '') OR from_addr = ? ORDER BY sent_at",
    ).bind(lead.thread_id ?? "", lead.thread_id ?? "", e),
    env.DB.prepare("SELECT * FROM escalations WHERE lead_email = ? ORDER BY created_at").bind(e),
    env.DB.prepare("SELECT data FROM app_items WHERE kind = 'demo' AND json_extract(data, '$.pending_owner_email') = ?").bind(e),
    env.DB.prepare("SELECT data FROM app_items WHERE kind = 'signup' AND id = ?").bind(hash),
    env.DB.prepare("SELECT body, sent_at FROM replies_sent WHERE thread_id = ? ORDER BY sent_at").bind(lead.thread_id ?? ""),
  ]);
  return {
    lead,
    messages: msgs.results,
    escalations: escs.results,
    demo: (demo.results as { data: string }[]).map((d) => JSON.parse(d.data)),
    signup: (signup.results as { data: string }[]).map((d) => JSON.parse(d.data))[0] ?? null,
    repliesFromHere: sent.results,
  };
}

const ALLOWED_STATUS = ["do_not_contact", "skip", "replied", "opted_out"];

/** Changes a lead's Status here and queues the same change for the tracker sheet. */
export async function setLeadStatus(env: Env, email: string, status: string) {
  if (!ALLOWED_STATUS.includes(status)) throw new Error("status not allowed");
  const e = email.toLowerCase();
  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE leads SET status = ?, updated_at = ? WHERE email = ?").bind(status, at, e),
    env.DB.prepare("INSERT INTO sheet_updates (tab, key, col, value, created_at) VALUES ('Leads', ?, 'Status', ?, ?)").bind(e, status, at),
  ]);
}
