// Signature check for /ingest (the Apps Scripts, Phase 2).
// Sender: X-TT-Timestamp = unix seconds, X-TT-Signature = hex HMAC-SHA256(secret, `${timestamp}.${body}`).
// Apps Script side: Utilities.computeHmacSha256Signature(ts + "." + body, secret).

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
}

export async function verifyIngest(
  secret: string | undefined,
  timestamp: string | null,
  signature: string | null,
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return false; // 5-minute replay window
  const expected = await sign(secret, timestamp, body);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
