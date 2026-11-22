import type { Env } from "./env";
import { nowIso } from "./env";
import { gasCall, isInbox, type Inbox, type ThreadMsg } from "./gas";
import { draftReply, type DraftMsg } from "./ai";
import { TASK_MAX_GAP } from "./outreach";

// The "Needs you" queue: lead replies nobody has answered, escalations, and app or
// system problems. Built on request from the mirrored data plus your decisions.

export interface QueueItem {
  key: string;
  kind: "reply" | "escalation" | "flagged" | "enterprise" | "report" | "subscription" | "abandoned" | "system" | "bounce";
  priority: 0 | 1 | 2;
  title: string;
  detail: string;
  at: string; // when it started waiting
  slaHours: number;
  inbox?: string;
  threadId?: string;
  leadEmail?: string;
  escalationId?: string;
  suggested?: string;
  link?: string;
}

const HOT = /pric|cost|enterprise|team|studio|company|call|meeting|demo|contract|legal|gdpr|invoice|discount|partner|invest|angry|scam|spam|stop emailing/i;

export async function buildQueue(env: Env): Promise<QueueItem[]> {
  const db = env.DB;
  const now = nowIso();
  const [replies, escs, apps, states, lastDaily, bounces] = await db.batch([
    // Latest message in each thread is a human inbound message => nobody has answered it.
    db.prepare(
      `WITH last AS (
         SELECT inbox, thread_id, max(sent_at) last_at FROM mail_msgs WHERE kind IN ('human','out') GROUP BY inbox, thread_id
       )
       SELECT m.inbox, m.thread_id, m.from_addr, m.from_name, m.subject, m.snippet, m.body, m.sent_at,
              l2.status lead_status, l2.app, l2.developer, l2.email lead_email
       FROM mail_msgs m
       JOIN last l ON l.inbox = m.inbox AND l.thread_id = m.thread_id AND l.last_at = m.sent_at
       LEFT JOIN leads l2 ON l2.email = m.from_addr OR (l2.thread_id <> '' AND l2.thread_id = m.thread_id)
       WHERE m.kind = 'human' AND m.sent_at > ?1
       GROUP BY m.inbox, m.thread_id`,
    ).bind(new Date(Date.now() - 45 * 86400000).toISOString()),
    db.prepare(`SELECT * FROM escalations WHERE status IN ('waiting', '', 'open', 'pending')`),
    db.prepare(`SELECT kind, id, data FROM app_items WHERE kind IN ('flagged','enterprise','report','subscription','abandoned')`),
    db.prepare(`SELECT key, state, snooze_until, updated_at FROM queue_state`),
    db.prepare(`SELECT max(run_at) last FROM run_log WHERE family = 'daily'`),
    db.prepare(
      `SELECT inbox, count(*) sent, sum(status='bounced') bounced FROM leads WHERE first_sent_at >= ?1 GROUP BY inbox`,
    ).bind(new Date(Date.now() - 3 * 86400000).toISOString()),
  ]);

  const items: QueueItem[] = [];
  const escByThread = new Map<string, any>();
  for (const e of escs.results as any[]) if (e.thread_id) escByThread.set(e.thread_id, e);

  for (const m of replies.results as any[]) {
    if (["opted_out", "bounced", "do_not_contact"].includes(m.lead_status ?? "")) continue;
    const esc = escByThread.get(m.thread_id);
    if (esc) escByThread.delete(m.thread_id);
    const hot = HOT.test(`${m.subject} ${m.body ?? m.snippet} ${esc?.summary ?? ""}`);
    items.push({
      key: `thread:${m.inbox}:${m.thread_id}`,
      kind: esc ? "escalation" : "reply",
      priority: hot ? 0 : 1,
      title: `${m.from_name || m.developer || m.from_addr}${m.app ? ` · ${m.app}` : ""}`,
      detail: esc?.summary || (m.body ?? m.snippet ?? "").replace(/\s+/g, " ").slice(0, 220),
      at: m.sent_at,
      slaHours: hot ? 12 : 24,
      inbox: m.inbox,
      threadId: m.thread_id,
      leadEmail: m.lead_email ?? m.from_addr,
      escalationId: esc?.id,
      suggested: esc?.suggested || undefined,
    });
  }
  // Escalations whose thread isn't in the mail mirror yet (scripts not installed, or older).
  for (const e of escByThread.values()) {
    const hot = HOT.test(e.summary ?? "");
    items.push({
      key: `esc:${e.id}`,
      kind: "escalation",
      priority: hot ? 0 : 1,
      title: `${e.lead_email} · #${e.id}`,
      detail: e.summary ?? "",
      at: e.created_at ?? now,
      slaHours: hot ? 12 : 24,
      inbox: e.inbox,
      threadId: e.thread_id || undefined,
      leadEmail: e.lead_email,
      escalationId: e.id,
      suggested: e.suggested || undefined,
    });
  }
  for (const a of apps.results as { kind: string; id: string; data: string }[]) {
    const d = JSON.parse(a.data);
    if (a.kind === "flagged") items.push({ key: `app:${a.id}`, kind: "flagged", priority: 0, title: `FLAGGED upload · ${d.name}`, detail: `${d.slug} by @${d.owner_usertag}. Nobody can run it until you approve or reject it.`, at: d.updatedAt ?? d.createdAt ?? now, slaHours: 24 });
    if (a.kind === "enterprise") items.push({ key: `ent:${a.id}`, kind: "enterprise", priority: 0, title: `Enterprise request · ${d.company || d.name}`, detail: `${d.name} <${d.email}>, ${d.expected_trials} runs. ${d.use_case}`, at: d.createdAt ?? now, slaHours: 12, leadEmail: d.email });
    if (a.kind === "report") items.push({ key: `rep:${a.id}`, kind: "report", priority: ["COPYRIGHT", "MALWARE"].includes(d.reason) ? 0 : 1, title: `${d.reason} report · ${d.app_name}`, detail: d.note || `On /app/${d.app_slug}${d.reporter_email ? `, from ${d.reporter_email}` : ""}`, at: d.createdAt ?? now, slaHours: 24 });
    if (a.kind === "subscription" && (d.status !== "ACTIVE" || d.cancel_at_period_end))
      items.push({ key: `sub:${a.id}:${d.status}:${d.cancel_at_period_end ? 1 : 0}`, kind: "subscription", priority: 0, title: `${d.plan} subscription ${d.cancel_at_period_end ? "set to cancel" : d.status.toLowerCase().replace("_", " ")}`, detail: `Period ends ${String(d.current_period_end).slice(0, 10)}`, at: d.status_event_at ?? d.updatedAt ?? now, slaHours: 24 });
    if (a.kind === "abandoned") items.push({ key: `ab:${a.id}`, kind: "abandoned", priority: 2, title: `Checkout not finished · @${d.usertag}`, detail: `${d.quantity} runs, ${(d.amount_cents / 100).toFixed(2)} ${d.currency}. The 11 AM nudge covers this.`, at: d.createdAt ?? now, slaHours: 72 });
  }
  const last = (lastDaily.results[0] as { last: string | null } | undefined)?.last;
  if (last && Date.now() - Date.parse(last) > TASK_MAX_GAP.daily.hours * 3600000) {
    items.push({ key: `sys:daily-down:${last}`, kind: "system", priority: 0, title: "Outreach looks stopped", detail: `No daily outreach run logged since ${last.slice(0, 16).replace("T", " ")} UTC. Check the scheduled tasks.`, at: last, slaHours: 2 });
  }
  for (const b of bounces.results as { inbox: string; sent: number; bounced: number }[]) {
    if (b.sent >= 20 && b.bounced / b.sent > 0.04) {
      items.push({ key: `bounce:${b.inbox}:${istDayKey()}`, kind: "bounce", priority: 0, title: `${b.inbox}@ bounce rate ${((b.bounced / b.sent) * 100).toFixed(1)}%`, detail: "Over 3 days. Sending from this inbox stops at 5%.", at: now, slaHours: 12, inbox: b.inbox });
    }
  }

  const st = new Map((states.results as { key: string; state: string; snooze_until: string | null; updated_at: string }[]).map((s) => [s.key, s]));
  return items
    .filter((it) => {
      const s = st.get(it.key);
      if (!s) return true;
      if (s.state === "snoozed") return !!s.snooze_until && s.snooze_until < now;
      // A reply that arrives after you dealt with a thread reopens it.
      if (it.kind === "reply" || it.kind === "escalation") return it.at > s.updated_at;
      return false;
    })
    .sort((a, b) => a.priority - b.priority || a.at.localeCompare(b.at));
}

const istDayKey = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

export async function setQueueState(env: Env, key: string, state: "handled" | "snoozed" | "dead" | "open", snoozeHours = 24) {
  if (state === "open") return env.DB.prepare("DELETE FROM queue_state WHERE key = ?").bind(key).run();
  const until = state === "snoozed" ? new Date(Date.now() + snoozeHours * 3600000).toISOString() : null;
  return env.DB.prepare("INSERT OR REPLACE INTO queue_state (key, state, snooze_until, updated_at) VALUES (?, ?, ?, ?)").bind(key, state, until, nowIso()).run();
}

// ---------- threads ----------

export async function getThread(env: Env, inbox: string, threadId: string): Promise<{ live: boolean; messages: ThreadMsg[]; error?: string }> {
  if (!isInbox(inbox)) throw new Error("unknown inbox");
  try {
    const out = await gasCall<{ messages: ThreadMsg[] }>(env, inbox, "thread", { threadId });
    return { live: true, messages: out.messages };
  } catch (e) {
    const rows = (
      await env.DB.prepare("SELECT id, from_addr, from_name, to_addr, subject, coalesce(body, snippet, '') body, sent_at, direction FROM mail_msgs WHERE inbox = ? AND thread_id = ? ORDER BY sent_at").bind(inbox, threadId).all<any>()
    ).results;
    return {
      live: false,
      error: e instanceof Error ? e.message : String(e),
      messages: rows.map((r) => ({ id: r.id, from: r.from_name ? `${r.from_name} <${r.from_addr}>` : r.from_addr, to: r.to_addr, date: Date.parse(r.sent_at), subject: r.subject, body: r.body || "(not stored; open in Gmail)", mine: r.direction === "out" })),
    };
  }
}

export async function sendReply(env: Env, inbox: string, threadId: string, body: string, escalationId?: string) {
  if (!isInbox(inbox)) throw new Error("unknown inbox");
  const text = body.trim();
  if (text.length < 2) throw new Error("The reply is empty");
  const out = await gasCall<{ to: string; subject: string }>(env, inbox as Inbox, "reply", { threadId, body: text }, 30000);
  const at = nowIso();
  const stmts = [
    env.DB.prepare("INSERT INTO replies_sent (inbox, thread_id, to_addr, body, escalation, sent_at) VALUES (?, ?, ?, ?, ?, ?)").bind(inbox, threadId, out.to ?? null, text, escalationId ?? null, at),
    env.DB.prepare(
      "INSERT OR REPLACE INTO mail_msgs (id, inbox, thread_id, direction, kind, from_addr, to_addr, subject, sent_at) VALUES (?, ?, ?, 'out', 'out', ?, ?, ?, ?)",
    ).bind(`local-${threadId}-${Date.now()}`, inbox, threadId, `${inbox}@taptry.in`, out.to ?? null, out.subject ?? null, at),
    env.DB.prepare("INSERT OR REPLACE INTO queue_state (key, state, snooze_until, updated_at) VALUES (?, 'handled', NULL, ?)").bind(`thread:${inbox}:${threadId}`, at),
  ];
  if (escalationId) {
    for (const [col, value] of [["Status", "sent"], ["Romil's answer", text], ["Sent (UTC)", at]]) {
      stmts.push(env.DB.prepare("INSERT INTO sheet_updates (tab, key, col, value, created_at) VALUES ('Escalations', ?, ?, ?, ?)").bind(escalationId, col, value, at));
    }
    stmts.push(env.DB.prepare("UPDATE escalations SET status = 'sent', romil_answer = ?, sent_at = ? WHERE id = ?").bind(text, at, escalationId));
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO queue_state (key, state, snooze_until, updated_at) VALUES (?, 'handled', NULL, ?)").bind(`esc:${escalationId}`, at));
  }
  await env.DB.batch(stmts);
  return { ok: true, to: out.to, at };
}

export async function aiDraft(env: Env, inbox: string, threadId: string, note?: string) {
  const t = await getThread(env, inbox, threadId);
  const msgs: DraftMsg[] = t.messages.map((m) => ({ from: m.from, mine: m.mine, date: new Date(m.date).toISOString().slice(0, 16), body: m.body }));
  if (!msgs.some((m) => !m.mine)) throw new Error("No message from the lead in this thread to reply to");
  return { draft: await draftReply(env, msgs, note) };
}
