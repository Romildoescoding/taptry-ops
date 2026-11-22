import { AwsClient } from "aws4fetch";
import type { Env } from "./env";
import { nowIso } from "./env";

const client = (env: Env) => {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error("AWS keys not set");
  return new AwsClient({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY });
};

// ---------- Cost Explorer (daily, ~1-2 requests at $0.01 each) ----------

export interface CostRow { day: string; service: string; region: string; usd: number }

interface CeResponse {
  ResultsByTime: { TimePeriod: { Start: string }; Groups?: { Keys: string[]; Metrics: { UnblendedCost: { Amount: string } } }[] }[];
  NextPageToken?: string;
}

export function costWindow(today: Date): { start: string; end: string } {
  const y = today.getUTCFullYear(), m = today.getUTCMonth();
  const start = new Date(Date.UTC(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(today) }; // End is exclusive: data through yesterday
}

export function parseCe(body: CeResponse): CostRow[] {
  const rows: CostRow[] = [];
  for (const r of body.ResultsByTime ?? []) {
    for (const g of r.Groups ?? []) {
      const usd = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
      if (!usd) continue;
      rows.push({ day: r.TimePeriod.Start, service: g.Keys[0] ?? "?", region: g.Keys[1] || "global", usd });
    }
  }
  return rows;
}

export async function collectCosts(env: Env, today = new Date()): Promise<number> {
  const aws = client(env);
  const { start, end } = costWindow(today);
  if (start >= end) return 0;
  const rows: CostRow[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const res = await aws.fetch("https://ce.us-east-1.amazonaws.com/", {
      method: "POST",
      headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSInsightsIndexService.GetCostAndUsage" },
      body: JSON.stringify({
        TimePeriod: { Start: start, End: end },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }, { Type: "DIMENSION", Key: "REGION" }],
        ...(token ? { NextPageToken: token } : {}),
      }),
      aws: { service: "ce", region: "us-east-1" },
    });
    if (!res.ok) throw new Error(`Cost Explorer: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as CeResponse;
    rows.push(...parseCe(body));
    token = body.NextPageToken;
  } while (token && ++pages < 5);

  const stmts = [env.DB.prepare("DELETE FROM aws_cost_daily WHERE day >= ?").bind(start)];
  for (const r of rows) {
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO aws_cost_daily (day, service, region, usd) VALUES (?, ?, ?, ?)").bind(r.day, r.service, r.region, r.usd));
  }
  await env.DB.batch(stmts); // one transaction: the window is never half-written
  return rows.length;
}

// ---------- EC2 fleet snapshot (hourly, free) ----------

export interface FleetItem { region: string; kind: "instance" | "ip" | "volume"; resource_id: string; detail: string | null; state: string | null; size_gb: number | null; launched_at: string | null }

const first = (s: string, tag: string) => s.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;

/** Workers have no XML parser; each item starts with its id tag, so split on that. */
export function parseInstances(xml: string, region: string): FleetItem[] {
  return xml.split("<instanceId>").slice(1).map((seg) => ({
    region,
    kind: "instance" as const,
    resource_id: seg.slice(0, seg.indexOf("<")),
    detail: first(seg, "instanceType"),
    state: seg.match(/<instanceState>[\s\S]*?<name>([^<]*)<\/name>/)?.[1] ?? null,
    size_gb: null,
    launched_at: first(seg, "launchTime"),
  }));
}

export function parseAddresses(xml: string, region: string): FleetItem[] {
  return xml.split("<publicIp>").slice(1).map((seg) => ({
    region,
    kind: "ip" as const,
    resource_id: seg.slice(0, seg.indexOf("<")),
    detail: /<associationId>[^<]+<\/associationId>/.test(seg.split("</item>")[0]) ? "attached" : "unattached",
    state: null,
    size_gb: null,
    launched_at: null,
  }));
}

/** A volume's attachmentSet repeats <volumeId>, so a segment without <size> is the
 *  tail of the volume before it (which is where its <volumeType> sits). */
export function parseVolumes(xml: string, region: string): FleetItem[] {
  const segs = xml.split("<volumeId>").slice(1);
  const out: FleetItem[] = [];
  segs.forEach((seg, i) => {
    if (!seg.includes("<size>")) return;
    const tail = segs[i + 1] && !segs[i + 1].includes("<size>") ? segs[i + 1] : "";
    out.push({
      region,
      kind: "volume",
      resource_id: seg.slice(0, seg.indexOf("<")),
      detail: first(seg + tail, "volumeType"),
      state: first(seg, "status"),
      size_gb: Number(first(seg, "size") ?? 0),
      launched_at: null,
    });
  });
  return out;
}

export async function collectFleet(env: Env): Promise<number> {
  const aws = client(env);
  const regions = env.AWS_REGIONS.split(",").map((r) => r.trim()).filter(Boolean);
  const items: FleetItem[] = [];
  for (const region of regions) {
    const call = async (q: string) => {
      const res = await aws.fetch(`https://ec2.${region}.amazonaws.com/?${q}&Version=2016-11-15`, { aws: { service: "ec2", region } });
      if (!res.ok) throw new Error(`EC2 ${region}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.text();
    };
    items.push(...parseInstances(await call("Action=DescribeInstances&Filter.1.Name=instance-state-name&Filter.1.Value.1=pending&Filter.1.Value.2=running&Filter.1.Value.3=stopping&Filter.1.Value.4=stopped"), region));
    items.push(...parseAddresses(await call("Action=DescribeAddresses"), region));
    items.push(...parseVolumes(await call("Action=DescribeVolumes"), region));
  }
  const taken = nowIso();
  const stmts = [env.DB.prepare("DELETE FROM aws_fleet")];
  for (const i of items) {
    stmts.push(
      env.DB.prepare("INSERT OR REPLACE INTO aws_fleet (region, kind, resource_id, detail, state, size_gb, launched_at, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(i.region, i.kind, i.resource_id, i.detail, i.state, i.size_gb, i.launched_at, taken),
    );
  }
  await env.DB.batch(stmts);
  return items.length;
}
