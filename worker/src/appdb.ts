import { neon } from "@neondatabase/serverless";
import type { Env } from "./env";
import { jsonUpsert } from "./ingest";

// Reads the ops.* views in the app's Neon DB (sql/appdb/ops_views.sql) with the
// read-only ops_ro role, and keeps a snapshot here for the dashboard.

const ITEM_VIEWS: { kind: string; view: string; id: string; limit?: number }[] = [
  { kind: "flagged", view: "ops.flagged_apps", id: "slug" },
  { kind: "demo", view: "ops.demo_apps", id: "slug" },
  { kind: "subscription", view: "ops.subscriptions", id: "id" },
  { kind: "payment", view: "ops.payments", id: "id" },
  { kind: "abandoned", view: "ops.abandoned_checkouts", id: "id" },
  { kind: "report", view: "ops.open_reports", id: "id" },
  { kind: "enterprise", view: "ops.enterprise_inquiries", id: "id" },
  { kind: "fleet", view: "ops.fleet", id: "ec2_instance_id" },
  { kind: "category", view: "ops.uploads_by_category", id: "category" },
  { kind: "signup", view: "ops.signups", id: "email_sha256" },
];

const plain = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v]));

export async function collectAppDb(env: Env): Promise<number> {
  if (!env.APPDB_URL) throw new Error("APPDB_URL not set");
  const sql = neon(env.APPDB_URL);
  const daily = (await sql.query("SELECT * FROM ops.daily WHERE day > current_date - 90 ORDER BY day")) as Record<string, unknown>[];
  const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM app_daily")];
  if (daily.length) {
    const rows = daily.map((r) => {
      const p = plain(r);
      return { ...p, day: String(p.day).slice(0, 10) };
    });
    stmts.push(jsonUpsert(env.DB, "app_daily", Object.keys(rows[0]), rows));
  }
  let n = daily.length;
  for (const v of ITEM_VIEWS) {
    const rows = (await sql.query(`SELECT * FROM ${v.view}`)) as Record<string, unknown>[];
    stmts.push(env.DB.prepare("DELETE FROM app_items WHERE kind = ?").bind(v.kind));
    const items = rows.map((r) => {
      const p = plain(r);
      return { kind: v.kind, id: String(p[v.id] ?? ""), data: JSON.stringify(p) };
    });
    for (let i = 0; i < items.length; i += 200) stmts.push(jsonUpsert(env.DB, "app_items", ["kind", "id", "data"], items.slice(i, i + 200)));
    n += rows.length;
  }
  await env.DB.batch(stmts);
  return n;
}
