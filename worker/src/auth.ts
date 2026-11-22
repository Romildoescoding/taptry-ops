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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a"><title>TapTry Ops</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&family=JetBrains+Mono&display=swap" rel="stylesheet">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#f4f4f4;font-family:Outfit,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
form{background:#141414;padding:30px 26px;border-radius:26px;width:min(360px,88vw)}
h1{margin:0 0 6px;font-size:34px;font-weight:400;letter-spacing:-.02em}h1 b{font-weight:600}h1 span{color:#8d8d8d;font-weight:300}
p{margin:0 0 22px;color:#8d8d8d;font:12px/1.4 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}
input{width:100%;box-sizing:border-box;padding:15px 20px;border:0;border-radius:999px;font-size:16px;background:#1f1f1f;color:#f4f4f4;outline:none}
input:focus{box-shadow:0 0 0 2px #ff4d24}
button{margin-top:12px;width:100%;padding:15px;border:0;border-radius:999px;background:#f4f4f4;color:#0a0a0a;font-size:16px;font-weight:600;cursor:pointer;font-family:inherit}
.err{color:#ff8a8a;font-size:14px;margin-top:14px}
</style></head><body>
<form method="post" action="/auth/login">
<h1><b>TapTry</b><span>ops</span></h1><p>Dashboard password</p>
<input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password">
<button type="submit">Log in</button>
${error ? `<div class="err">${error}</div>` : ""}
</form></body></html>`;
