import { describe, expect, it, beforeEach } from "vitest";
import { verifyAccessJwt, resetKeyCache } from "../src/access";
import { sign, verifyIngest } from "../src/hmac";
import { costWindow, parseCe, parseInstances, parseAddresses, parseVolumes } from "../src/aws";
import { summarize } from "../src/costs";
import { tilesToRows } from "../src/posthog";

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? b : b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("Access JWT", () => {
  const team = "taptry.cloudflareaccess.com";
  const aud = "aud123";
  let priv: CryptoKey, jwk: JsonWebKey;
  beforeEach(async () => {
    resetKeyCache();
    const kp = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    )) as CryptoKeyPair;
    priv = kp.privateKey;
    jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  });
  const make = async (payload: object, kid = "k1") => {
    const h = b64url(JSON.stringify({ alg: "RS256", kid }));
    const p = b64url(JSON.stringify(payload));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(`${h}.${p}`)));
    return `${h}.${p}.${b64url(sig)}`;
  };
  const fetcher = (async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1" }] }))) as unknown as typeof fetch;
  const good = { aud: [aud], iss: `https://${team}`, exp: Math.floor(Date.now() / 1000) + 600, email: "romilrajrana1@gmail.com" };

  it("accepts a valid token", async () => {
    expect(await verifyAccessJwt(await make(good), { teamDomain: team, aud, fetcher })).toEqual({ email: "romilrajrana1@gmail.com" });
  });
  it("rejects wrong audience, issuer, expiry, key and tampering", async () => {
    const o = { teamDomain: team, aud, fetcher };
    await expect(verifyAccessJwt(await make({ ...good, aud: ["other"] }), o)).rejects.toThrow("audience");
    await expect(verifyAccessJwt(await make({ ...good, iss: "https://evil.com" }), o)).rejects.toThrow("issuer");
    await expect(verifyAccessJwt(await make({ ...good, exp: 1 }), o)).rejects.toThrow("expired");
    await expect(verifyAccessJwt(await make(good, "k2"), o)).rejects.toThrow("key id");
    const t = (await make(good)).split(".");
    t[1] = b64url(JSON.stringify({ ...good, email: "attacker@x.com" }));
    await expect(verifyAccessJwt(t.join("."), o)).rejects.toThrow("signature");
  });
});

describe("ingest HMAC", () => {
  it("accepts a fresh correct signature and rejects the rest", async () => {
    const now = 1_800_000_000, ts = String(now), body = '{"rows":[]}';
    const sig = await sign("s3cret", ts, body);
    expect(await verifyIngest("s3cret", ts, sig, body, now)).toBe(true);
    expect(await verifyIngest("s3cret", ts, sig, body + " ", now)).toBe(false);
    expect(await verifyIngest("other", ts, sig, body, now)).toBe(false);
    expect(await verifyIngest("s3cret", ts, sig, body, now + 301)).toBe(false); // replay
    expect(await verifyIngest(undefined, ts, sig, body, now)).toBe(false);
  });
});

describe("AWS parsing", () => {
  it("cost window runs from the 1st of last month to today (exclusive)", () => {
    expect(costWindow(new Date("2026-11-22T10:00:00Z"))).toEqual({ start: "2026-10-01", end: "2026-11-22" });
    expect(costWindow(new Date("2026-01-05T00:00:00Z"))).toEqual({ start: "2025-12-01", end: "2026-01-05" });
  });
  it("parses Cost Explorer groups and drops zero rows", () => {
    const rows = parseCe({
      ResultsByTime: [{ TimePeriod: { Start: "2026-11-01" }, Groups: [
        { Keys: ["Amazon Elastic Compute Cloud - Compute", "ap-south-1"], Metrics: { UnblendedCost: { Amount: "2.5" } } },
        { Keys: ["Tax", ""], Metrics: { UnblendedCost: { Amount: "0.45" } } },
        { Keys: ["AWS Cost Explorer", "us-east-1"], Metrics: { UnblendedCost: { Amount: "0" } } },
      ] }],
    });
    expect(rows).toEqual([
      { day: "2026-11-01", service: "Amazon Elastic Compute Cloud - Compute", region: "ap-south-1", usd: 2.5 },
      { day: "2026-11-01", service: "Tax", region: "global", usd: 0.45 },
    ]);
  });
  it("parses DescribeInstances, DescribeAddresses and DescribeVolumes XML", () => {
    const inst = `<DescribeInstancesResponse><reservationSet><item><instancesSet>
      <item><instanceId>i-aaa</instanceId><instanceState><code>16</code><name>running</name></instanceState><instanceType>c7i.xlarge</instanceType><launchTime>2026-11-01T00:00:00.000Z</launchTime><networkInterfaceSet><item><attachment><status>attached</status></attachment></item></networkInterfaceSet></item>
      <item><instanceId>i-bbb</instanceId><instanceState><code>80</code><name>stopped</name></instanceState><instanceType>t3.micro</instanceType><launchTime>2026-09-01T00:00:00.000Z</launchTime></item>
      </instancesSet></item></reservationSet></DescribeInstancesResponse>`;
    expect(parseInstances(inst, "ap-south-1").map((i) => [i.resource_id, i.state, i.detail])).toEqual([
      ["i-aaa", "running", "c7i.xlarge"], ["i-bbb", "stopped", "t3.micro"],
    ]);
    const addr = `<addressesSet><item><publicIp>1.2.3.4</publicIp><allocationId>a1</allocationId><associationId>as1</associationId></item><item><publicIp>5.6.7.8</publicIp><allocationId>a2</allocationId></item></addressesSet>`;
    expect(parseAddresses(addr, "eu-north-1").map((a) => [a.resource_id, a.detail])).toEqual([["1.2.3.4", "attached"], ["5.6.7.8", "unattached"]]);
    const vol = `<volumeSet>
      <item><volumeId>vol-1</volumeId><size>30</size><status>in-use</status><attachmentSet><item><volumeId>vol-1</volumeId><instanceId>i-aaa</instanceId><status>attached</status></item></attachmentSet><volumeType>gp3</volumeType></item>
      <item><volumeId>vol-2</volumeId><size>8</size><status>available</status><attachmentSet/><volumeType>gp2</volumeType></item>
      </volumeSet>`;
    expect(parseVolumes(vol, "eu-north-1").map((v) => [v.resource_id, v.size_gb, v.state, v.detail])).toEqual([
      ["vol-1", 30, "in-use", "gp3"], ["vol-2", 8, "available", "gp2"],
    ]);
  });
});

describe("cost summary", () => {
  it("computes MTD, forecast, same-day change and fleet run-rate", () => {
    const rows = [] as { day: string; service: string; region: string; usd: number }[];
    for (let d = 1; d <= 31; d++) rows.push({ day: `2026-10-${String(d).padStart(2, "0")}`, service: "EC2", region: "ap-south-1", usd: 2 });
    for (let d = 1; d <= 21; d++) rows.push({ day: `2026-11-${String(d).padStart(2, "0")}`, service: "EC2", region: "ap-south-1", usd: 3 });
    const s = summarize(rows, new Date("2026-11-22T06:00:00Z"), {
      budget: 110,
      prices: { "ap-south-1:c7i.xlarge": 0.2 },
      ipv4PerHour: 0.005,
      fleet: [
        { region: "ap-south-1", kind: "instance", resource_id: "i-1", detail: "c7i.xlarge", state: "running", size_gb: null, launched_at: null },
        { region: "ap-south-1", kind: "instance", resource_id: "i-2", detail: "t9.weird", state: "running", size_gb: null, launched_at: null },
        { region: "eu-north-1", kind: "ip", resource_id: "5.6.7.8", detail: "unattached", state: null, size_gb: null, launched_at: null },
      ],
    });
    expect(s.mtd).toBe(63); // 21 days x 3
    expect(s.lastMonthSameDay).toBe(42); // Oct 1-21 x 2
    expect(s.changePct).toBe(50);
    expect(s.avg7).toBe(3);
    expect(s.forecast).toBe(90); // 63 + 3 x 9 days left (22nd-30th)
    expect(s.fleet.instancesRunning).toBe(2);
    expect(s.fleet.runRatePerDay).toBe(4.92); // 0.2x24 + 0.005x24
    expect(s.fleet.unpricedTypes).toEqual(["ap-south-1:t9.weird"]);
    expect(s.fleet.stockholmLeftovers).toEqual(["ip 5.6.7.8"]);
  });
});

describe("PostHog tiles", () => {
  it("keeps insight tiles in layout order and skips text tiles", () => {
    const rows = tilesToRows("2090168", [
      { insight: { short_id: "b", name: "Sessions", result: [1], query: { kind: "InsightVizNode", source: { kind: "TrendsQuery" } } }, layouts: { sm: { y: 2, x: 0 } } },
      { insight: null },
      { insight: { short_id: "a", name: null, derived_name: "Active users", result: [2], last_refresh: "2026-11-22T00:00:00Z" }, layouts: { sm: { y: 0, x: 6 } } },
    ]);
    expect(rows.map((r) => [r.short_id, r.name, r.kind])).toEqual([["b", "Sessions", "TrendsQuery"], ["a", "Active users", null]]);
    expect(rows.find((r) => r.short_id === "a")!.position).toBeLessThan(rows.find((r) => r.short_id === "b")!.position);
  });
});
