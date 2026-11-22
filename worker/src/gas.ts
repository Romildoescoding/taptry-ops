import type { Env } from "./env";
import { getConfig } from "./env";
import { sign } from "./hmac";

// Calls an inbox's Apps Script web app (deployed "Execute as: me"), which reads
// and sends Gmail as that inbox. Its link is pasted once on the System tab
// (Apps Script's own getUrl() reports a link that doesn't work for new deployments).
// Requests are signed with INGEST_SECRET; the script refuses anything unsigned or stale.

export const INBOXES = ["connect", "reachout", "hello"] as const;
export type Inbox = (typeof INBOXES)[number];
export const isInbox = (v: string): v is Inbox => (INBOXES as readonly string[]).includes(v);

export async function gasCall<T = any>(env: Env, inbox: Inbox, action: string, args: Record<string, unknown> = {}, timeoutMs = 25000): Promise<T> {
  if (!env.INGEST_SECRET) throw new Error("INGEST_SECRET not set");
  const url = await getConfig<string | null>(env.DB, `gas_url_${inbox}`, null);
  if (!url) throw new Error(`Paste the ${inbox}@ web app link on the System tab`);
  const ts = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({ action, ...args });
  const sig = await sign(env.INGEST_SECRET, ts, payload);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ ts, sig, payload }),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let out: any;
  try {
    out = JSON.parse(text);
  } catch {
    throw new Error(
      res.status === 404
        ? `${inbox}@ web app link not found (HTTP 404). Paste the link from Deploy > Manage deployments on the System tab`
        : `${inbox}@ web app returned HTTP ${res.status}, not JSON. Check it's deployed with access "Anyone"`,
    );
  }
  if (!out.ok) throw new Error(`${inbox}@ script: ${out.error ?? "failed"}`);
  return out as T;
}

/** Accepts the web app link exactly as Apps Script shows it under Deploy > Manage deployments. */
export function validWebappUrl(url?: string): string | null {
  const u = (url ?? "").trim();
  return /^https:\/\/script\.google\.com\/(?:a\/(?:macros\/)?[\w.*-]+\/)?(?:macros\/)?s\/[\w-]{20,}\/exec\/?$/.test(u) ? u.replace(/\/$/, "") : null;
}

/** Saves an inbox's web app link and checks that the script answers a signed request. */
export async function saveWebapp(env: Env, inbox: Inbox, url: string): Promise<{ ok: boolean; error?: string }> {
  const clean = validWebappUrl(url);
  if (!clean) return { ok: false, error: "That doesn't look like a web app link. It starts with https://script.google.com/ and ends with /exec" };
  await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(`gas_url_${inbox}`, JSON.stringify(clean)).run();
  try {
    await gasCall(env, inbox, "ping");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Scripts deployed before "ping" existed answer "unknown action": that still proves the link and secret work.
    if (/unknown action/.test(msg)) return { ok: true };
    return { ok: false, error: msg };
  }
}

export interface ThreadMsg { id: string; from: string; to: string; date: number; subject: string; body: string; mine: boolean }
