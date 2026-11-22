# taptry-ops

Private ops dashboard for TapTry at `ops.taptry.in`: outreach, leads, product analytics, AWS costs.
Plan: the "TapTry Ops Dashboard: build plan" doc.

- `worker/` Cloudflare Worker: API (behind Cloudflare Access), collectors (cron), D1 migrations.
- `web/` UI (static assets served by the same Worker).
- `sql/appdb/ops_views.sql` read-only views for the app's Neon DB (Phase 2).

## Local
    cd worker && npm i
    echo LOCAL_DEV=1 > .dev.vars          # lets /api run without Access, local only
    npx wrangler d1 migrations apply taptry-ops --local
    npx wrangler dev
    npx vitest run && npx tsc -p .

## Secrets (never in the repo)
Worker: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, POSTHOG_API_KEY (Cloudflare dashboard > Worker > Settings > Variables and secrets).
GitHub Actions: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
