// Verifies the JWT Cloudflare Access puts on every request it lets through
// (Cf-Access-Jwt-Assertion). Access already blocks strangers at the edge; this
// second check means the API refuses anything that somehow skipped Access.

type Jwk = JsonWebKey & { kid: string };
let cachedKeys: { at: number; keys: Jwk[] } | null = null;

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

export async function fetchKeys(teamDomain: string, fetcher: typeof fetch = fetch): Promise<Jwk[]> {
  if (cachedKeys && Date.now() - cachedKeys.at < 3600_000) return cachedKeys.keys;
  const res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  cachedKeys = { at: Date.now(), keys: body.keys };
  return body.keys;
}

export function resetKeyCache() {
  cachedKeys = null;
}

export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; aud: string; now?: number; fetcher?: typeof fetch },
): Promise<{ email: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (header.alg !== "RS256") throw new Error("unexpected alg");

  const keys = await fetchKeys(opts.teamDomain, opts.fetcher);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown key id");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new Error("bad signature");

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(opts.aud)) throw new Error("wrong audience");
  if (payload.iss !== `https://${opts.teamDomain}`) throw new Error("wrong issuer");
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("expired");
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) throw new Error("not yet valid");
  return { email: String(payload.email ?? "") };
}
