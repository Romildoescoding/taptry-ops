import type { CostRow, FleetItem } from "./aws";

// Pure maths for the Costs tab, kept apart so it's unit-tested.
// AWS bills in UTC days, so these are UTC days too.

const iso = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number) => Math.round(n * 100) / 100;

export interface CostSummary {
  month: string;
  through: string | null; // last day with data
  mtd: number;
  lastMonthSameDay: number;
  changePct: number | null;
  avg7: number;
  forecast: number;
  budget: number | null;
  byService: { name: string; usd: number }[];
  byRegion: { name: string; usd: number }[];
  daily: { day: string; usd: number }[];
  fleet: {
    instancesRunning: number;
    byRegion: Record<string, { running: number; stopped: number; ips: number; volumesGb: number }>;
    runRatePerDay: number;
    unpricedTypes: string[];
    stockholmLeftovers: string[];
  };
}

export function summarize(
  rows: CostRow[],
  today: Date,
  opts: { budget: number | null; fleet: FleetItem[]; prices: Record<string, number>; ipv4PerHour: number },
): CostSummary {
  const y = today.getUTCFullYear(), m = today.getUTCMonth(), dom = today.getUTCDate();
  const monthStart = iso(new Date(Date.UTC(y, m, 1)));
  const lastStart = iso(new Date(Date.UTC(y, m - 1, 1)));
  const lastSame = iso(new Date(Date.UTC(y, m - 1, Math.min(dom, new Date(Date.UTC(y, m, 0)).getUTCDate()))));
  const todayIso = iso(today);
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  const perDay = new Map<string, number>();
  const svc = new Map<string, number>();
  const reg = new Map<string, number>();
  let mtd = 0, lastMtd = 0;
  for (const r of rows) {
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.usd);
    if (r.day >= monthStart && r.day < todayIso) {
      mtd += r.usd;
      svc.set(r.service, (svc.get(r.service) ?? 0) + r.usd);
      reg.set(r.region, (reg.get(r.region) ?? 0) + r.usd);
    }
    if (r.day >= lastStart && r.day < lastSame) lastMtd += r.usd;
  }
  let last7 = 0;
  for (let i = 1; i <= 7; i++) last7 += perDay.get(iso(new Date(Date.UTC(y, m, dom - i)))) ?? 0;
  const avg7 = last7 / 7;
  const daysLeft = daysInMonth - (dom - 1); // today has no Cost Explorer data yet, so it counts as left
  const days = [...perDay.keys()].sort();

  const byRegion: CostSummary["fleet"]["byRegion"] = {};
  let runRate = 0;
  const unpriced = new Set<string>();
  const stockholm: string[] = [];
  for (const f of opts.fleet) {
    const b = (byRegion[f.region] ??= { running: 0, stopped: 0, ips: 0, volumesGb: 0 });
    if (f.kind === "instance") {
      if (f.state === "running" || f.state === "pending") {
        b.running++;
        const price = opts.prices[`${f.region}:${f.detail}`];
        if (price == null) unpriced.add(`${f.region}:${f.detail}`);
        else runRate += price * 24;
      } else b.stopped++;
    } else if (f.kind === "ip") {
      b.ips++;
      runRate += opts.ipv4PerHour * 24;
    } else if (f.kind === "volume") b.volumesGb += f.size_gb ?? 0;
    if (f.region === "eu-north-1") stockholm.push(`${f.kind} ${f.resource_id}${f.state ? ` (${f.state})` : ""}`);
  }

  const sorted = (mp: Map<string, number>) => [...mp].map(([name, usd]) => ({ name, usd: round(usd) })).sort((a, b) => b.usd - a.usd);
  return {
    month: monthStart.slice(0, 7),
    through: days.length ? days[days.length - 1] : null,
    mtd: round(mtd),
    lastMonthSameDay: round(lastMtd),
    changePct: lastMtd > 0 ? Math.round(((mtd - lastMtd) / lastMtd) * 1000) / 10 : null,
    avg7: round(avg7),
    forecast: round(mtd + avg7 * daysLeft),
    budget: opts.budget,
    byService: sorted(svc),
    byRegion: sorted(reg),
    daily: days.filter((d) => d >= lastStart).map((day) => ({ day, usd: round(perDay.get(day)!) })),
    fleet: {
      instancesRunning: Object.values(byRegion).reduce((s, b) => s + b.running, 0),
      byRegion,
      runRatePerDay: round(runRate),
      unpricedTypes: [...unpriced],
      stockholmLeftovers: stockholm,
    },
  };
}
