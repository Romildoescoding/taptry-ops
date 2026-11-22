import type { Env } from "./env";
import { nowIso } from "./env";

// Rows pushed by the Apps Scripts. Each request carries at most a few hundred rows and
// is written with ONE statement (json_each), so it stays inside the free plan's limits.

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? "" : String(v)).trim();

/** Sheet cells arrive as ISO strings (the script converts Date cells) or "YYYY-MM-DD HH:MM". UTC either way. */
export function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const d = new Date(`${m[1]}T${m[2]}${m[3] ?? ":00"}${m[4] ?? ""}${m[5] ?? "Z"}`);
    return isNaN(+d) ? null : d.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const d = new Date(s);
  return isNaN(+d) ? null : d.toISOString();
}

export function sourceKind(source: string): string {
  const s = source.toLowerCase();
  const warm = s.match(/^warm:([a-z]+)/);
  if (warm) return warm[1] === "ownapp" ? "ownapp" : warm[1];
  if (s.includes("play.google")) return "play";
  if (s.startsWith("http")) return "play";
  return s ? "other" : "unknown";
}

export const inboxKey = (v: unknown) => str(v).toLowerCase().split("@")[0] || "";

export function firstInt(v: unknown): number | null {
  const m = str(v).match(/\d+/);
  return m ? Number(m[0]) : null;
}

export function logFamily(type: string): string {
  const t = type.toLowerCase();
  if (t.startsWith("daily")) return "daily";
  if (t.includes("warm")) return "warm";
  if (t.includes("own-app") || t.includes("ownapp")) return "ownapp";
  if (t.includes("reply check")) return "reply";
  if (t.includes("nudge")) return "nudges";
  if (t.includes("weekly")) return "weekly";
  return "other";
}

export function leadFromSheet(r: Row) {
  const notes = str(r["Notes"]);
  const fus = [...notes.matchAll(/\[FU(\d)\]/g)].map((m) => Number(m[1]));
  return {
    email: str(r["Email"]).toLowerCase(),
    row_num: Number(r["_row"] ?? 0) || null,
    developer: str(r["Developer"]),
    greeting: str(r["Greeting name"]),
    app: str(r["App"]),
    platform: str(r["Platform"]),
    source: str(r["Source"]),
    source_kind: sourceKind(str(r["Source"])),
    installs: str(r["Installs"]),
    status: str(r["Status"]).toLowerCase(),
    inbox: inboxKey(r["Inbox"]),
    first_sent_at: isoOrNull(r["First sent (UTC)"]),
    thread_id: str(r["Thread ID"]),
    fu_sent_at: isoOrNull(r["Follow-up sent (UTC)"]),
    last_reply_at: isoOrNull(r["Last reply (UTC)"]),
    notes,
    fu_count: fus.length ? Math.max(...fus) : 0,
    variant: notes.match(/\bv=([A-D])\b/)?.[1] ?? null,
    auto_reply: /auto-reply received/i.test(notes) ? 1 : 0,
  };
}

export function escalationFromSheet(r: Row) {
  return {
    id: str(r["ID"]).replace(/^#/, ""),
    created_at: isoOrNull(r["Created (UTC)"]),
    inbox: inboxKey(r["Inbox"]),
    lead_email: str(r["Lead email"]).toLowerCase(),
    thread_id: str(r["Thread ID"]),
    summary: str(r["Their message (summary)"]),
    suggested: str(r["Suggested reply"]),
    status: str(r["Status"]).toLowerCase(),
    romil_answer: str(r["Romil's answer"]),
    sent_at: isoOrNull(r["Sent (UTC)"]),
  };
}

export function nudgeFromSheet(r: Row) {
  const sent = isoOrNull(r["Sent (UTC)"]);
  const email = str(r["Email"]).toLowerCase();
  return {
    key: `${sent ?? ""}|${email}`,
    sent_at: sent,
    nudge: str(r["Nudge"]),
    user_id: str(r["User ID"]),
    email,
    name: str(r["Name"]),
    app: str(r["App"]),
    subject: str(r["Subject"]),
    thread_id: str(r["Thread ID"]),
    status: str(r["Status"]).toLowerCase(),
    last_reply_at: isoOrNull(r["Last reply (UTC)"]),
    notes: str(r["Notes"]),
  };
}

export function logFromSheet(r: Row) {
  const at = isoOrNull(r["Run (UTC)"]);
  const type = str(r["Type"]);
  return {
    key: `${at ?? ""}|${type}`,
    run_at: at,
    type,
    family: logFamily(type),
    new_sent: firstInt(r["New emails sent"]),
    followups: firstInt(r["Follow-ups sent"]),
    replies: firstInt(r["Replies handled"]),
    escalated: firstInt(r["Escalated"]),
    bounces: firstInt(r["Bounces"]),
    raw: JSON.stringify([r["New emails sent"], r["Follow-ups sent"], r["Replies handled"], r["Escalated"], r["Bounces"], r["Notes"]].map(str)),
  };
}

export const SHEET_TABS: Record<string, { required: string[]; table: string; map: (r: Row) => Record<string, unknown>; key: string }> = {
  Leads: { required: ["Email", "Status", "First sent (UTC)", "Thread ID", "Source", "Inbox", "Notes"], table: "leads", map: leadFromSheet, key: "email" },
  Escalations: { required: ["ID", "Lead email", "Thread ID", "Suggested reply", "Status"], table: "escalations", map: escalationFromSheet, key: "id" },
  Nudges: { required: ["Sent (UTC)", "Email", "Status"], table: "nudges", map: nudgeFromSheet, key: "key" },
  Log: { required: ["Run (UTC)", "Type"], table: "run_log", map: logFromSheet, key: "key" },
};

/** One INSERT OR REPLACE ... SELECT FROM json_each(?) for any list of flat objects. */
export function jsonUpsert(db: D1Database, table: string, cols: string[], rows: Record<string, unknown>[]): D1PreparedStatement {
  const sel = cols.map((c) => `json_extract(value, '$.${c}')`).join(", ");
  return db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) SELECT ${sel} FROM json_each(?1)`).bind(JSON.stringify(rows));
}

export async function ingestSheet(env: Env, tab: string, body: { headers?: string[]; rows: Row[] }): Promise<{ written: number; skipped: number }> {
  const spec = SHEET_TABS[tab];
  if (!spec) throw new Error(`unknown tab ${tab}`);
  if (body.headers) {
    const missing = spec.required.filter((h) => !body.headers!.includes(h));
    if (missing.length) throw new Error(`${tab}: header row is missing ${missing.join(", ")}`);
  }
  const now = nowIso();
  const mapped = body.rows.map(spec.map).filter((r) => r[spec.key]);
  const withStamp = mapped.map((r) => (spec.table === "run_log" ? r : { ...r, updated_at: now }));
  if (withStamp.length) {
    const cols = Object.keys(withStamp[0]);
    await jsonUpsert(env.DB, spec.table, cols, withStamp).run();
  }
  await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(`last_push_sheet_${tab}`, JSON.stringify(now)).run();
  return { written: withStamp.length, skipped: body.rows.length - withStamp.length };
}

// ---------- Gmail ----------

export interface MailIn {
  id: string;
  threadId: string;
  labels?: string[];
  from?: string;
  to?: string;
  subject?: string;
  date: number | string; // ms since epoch
  snippet?: string;
  body?: string;
  autoSubmitted?: string;
  precedence?: string;
  autoReplyHeader?: string;
}

export function parseAddr(v: string | undefined): { addr: string; name: string } {
  const s = (v ?? "").trim();
  const m = s.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].replace(/^"|"$/g, "").trim(), addr: m[2].trim().toLowerCase() };
  return { name: "", addr: s.toLowerCase() };
}

export function classifyMail(m: MailIn, owner: string, ownAddrs: string[]): { direction: "in" | "out"; kind: string } {
  const from = parseAddr(m.from).addr;
  const out = (m.labels ?? []).includes("SENT") || ownAddrs.includes(from);
  if (out) return { direction: "out", kind: (m.to ?? "").toLowerCase().includes(owner) ? "internal" : "out" };
  if (/mailer-daemon|postmaster@/i.test(from) || /delivery status notification|undeliverable|mail delivery (failed|subsystem)|address not found/i.test(m.subject ?? "")) {
    return { direction: "in", kind: "bounce" };
  }
  if (from === owner) return { direction: "in", kind: "romil" };
  const auto =
    (m.autoSubmitted && m.autoSubmitted.toLowerCase() !== "no") ||
    /bulk|junk|auto_reply|list/i.test(m.precedence ?? "") ||
    !!m.autoReplyHeader ||
    /^(no-?reply|noreply|notifications?|do-not-reply|support-noreply)@/i.test(from) ||
    /out of (the )?office|automatic reply|auto-?reply|autoreply|on vacation|we('ve| have) received your|thank you for contacting|ticket #?\d+|request received/i.test(m.subject ?? "");
  return { direction: "in", kind: auto ? "auto" : "human" };
}

export async function ingestMail(env: Env, inbox: string, body: { messages: MailIn[]; webapp?: string }): Promise<number> {
  const owner = env.OWNER_EMAIL.toLowerCase();
  const own = ["connect", "reachout", "hello"].map((k) => `${k}@taptry.in`);
  const rows = body.messages.map((m) => {
    const { direction, kind } = classifyMail(m, owner, own);
    const from = parseAddr(m.from);
    const keepBody = direction === "in" && (kind === "human" || kind === "romil");
    return {
      id: m.id,
      inbox,
      thread_id: m.threadId,
      direction,
      kind,
      from_addr: from.addr,
      from_name: from.name,
      to_addr: parseAddr(m.to?.split(",")[0]).addr,
      subject: (m.subject ?? "").slice(0, 300),
      snippet: direction === "in" ? (m.snippet ?? "").slice(0, 300) : null,
      body: keepBody ? (m.body ?? "").slice(0, 6000) : null,
      sent_at: new Date(Number(m.date) || String(m.date)).toISOString(),
    };
  });
  const stmts: D1PreparedStatement[] = [];
  if (rows.length) stmts.push(jsonUpsert(env.DB, "mail_msgs", Object.keys(rows[0]), rows));
  stmts.push(env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(`last_push_mail_${inbox}`, JSON.stringify(nowIso())));
  if (body.webapp && /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(body.webapp)) {
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(`gas_url_${inbox}`, JSON.stringify(body.webapp)));
  }
  await env.DB.batch(stmts);
  return rows.length;
}
