// Password login for the dashboard (instead of Cloudflare Access).
// One secret, DASH_PASSWORD. The session cookie is signed with a key derived from
// it, so changing the password logs every session out.
// Wrong passwords: 5 per IP per 15 minutes, then that IP is refused until the window ends.

const enc = new TextEncoder();
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export const SESSION_COOKIE = "tt_session";
export const SESSION_DAYS = 30;
export const MAX_FAILS = 5;
export const FAIL_WINDOW_SEC = 15 * 60;

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Compares via HMAC so the time taken doesn't depend on where the strings differ. */
export async function passwordMatches(given: string, real: string): Promise<boolean> {
  const salt = "tt-pw-compare";
  return sameString(await hmac(salt, given), await hmac(salt, real));
}

export async function makeSession(password: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const exp = nowSec + SESSION_DAYS * 86400;
  return `${exp}.${await hmac("session:" + password, String(exp))}`;
}

export async function sessionValid(cookie: string | undefined, password: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!cookie) return false;
  const [exp, sig] = cookie.split(".");
  if (!exp || !sig || Number(exp) < nowSec) return false;
  return sameString(sig, await hmac("session:" + password, exp));
}

export function cookieHeader(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

/** Returns seconds to wait if this IP is locked out, else 0. */
export async function lockedFor(db: D1Database, ip: string, nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  const row = await db.prepare("SELECT window_start, fails FROM login_attempts WHERE ip = ?").bind(ip).first<{ window_start: number; fails: number }>();
  if (!row || nowSec - row.window_start >= FAIL_WINDOW_SEC || row.fails < MAX_FAILS) return 0;
  return FAIL_WINDOW_SEC - (nowSec - row.window_start);
}

export async function recordFail(db: D1Database, ip: string, nowSec = Math.floor(Date.now() / 1000)): Promise<void> {
  await db
    .prepare(
      `INSERT INTO login_attempts (ip, window_start, fails) VALUES (?1, ?2, 1)
       ON CONFLICT(ip) DO UPDATE SET
         fails = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE fails + 1 END,
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`,
    )
    .bind(ip, nowSec, FAIL_WINDOW_SEC)
    .run();
}

export async function clearFails(db: D1Database, ip: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
}

export const LOGIN_PAGE = (error = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TapTry Ops</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
form{background:#fff;padding:32px;border-radius:14px;width:min(340px,86vw)}
h1{margin:0 0 4px;font-size:20px;color:#0f172a}p{margin:0 0 20px;color:#64748b;font-size:14px}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:8px;background:#6d28d9;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
.err{color:#b91c1c;font-size:13px;margin-top:10px}
</style></head><body>
<form method="post" action="/auth/login">
<h1>TapTry Ops</h1><p>Enter your dashboard password.</p>
<input type="password" name="password" autocomplete="current-password" autofocus required>
<button type="submit">Log in</button>
${error ? `<div class="err">${error}</div>` : ""}
</form></body></html>`;
