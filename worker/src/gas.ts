import type { Env } from "./env";
import { getConfig } from "./env";
import { sign } from "./hmac";

// Calls an inbox's Apps Script web app (deployed "Execute as: me"), which reads
// and sends Gmail as that inbox. The script reports its own URL with every push.
// Requests are signed with INGEST_SECRET; the script refuses anything unsigned or stale.

export const INBOXES = ["connect", "reachout", "hello"] as const;
export type Inbox = (typeof INBOXES)[number];
export const isInbox = (v: string): v is Inbox => (INBOXES as readonly string[]).includes(v);

export async function gasCall<T = any>(env: Env, inbox: Inbox, action: string, args: Record<string, unknown> = {}, timeoutMs = 25000): Promise<T> {
  if (!env.INGEST_SECRET) throw new Error("INGEST_SECRET not set");
  const url = await getConfig<string | null>(env.DB, `gas_url_${inbox}`, null);
  if (!url) throw new Error(`The ${inbox}@ script hasn't checked in yet (install it and run setup())`);
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
    throw new Error(`${inbox}@ script returned HTTP ${res.status}, not JSON (is the web app deployed for "Anyone"?)`);
  }
  if (!out.ok) throw new Error(`${inbox}@ script: ${out.error ?? "failed"}`);
  return out as T;
}

export interface ThreadMsg { id: string; from: string; to: string; date: number; subject: string; body: string; mine: boolean }
