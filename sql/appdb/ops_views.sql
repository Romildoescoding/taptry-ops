-- TapTry Ops: read-only views over the app database, for the ops dashboard.
--
-- HOW TO RUN (Neon console > SQL Editor, on the app's database, as the owner role):
--   1. Once only: run the "ONE-TIME: ROLE" block at the bottom, with your own password.
--   2. Run everything above it. It's safe to re-run: it drops and rebuilds the ops schema.
--
-- What ops_ro can see: only the views in the ops schema below. It has no grant on any
-- table in public, so it can't read emails, tokens, API key hashes or anything else
-- not listed here. Views run with their owner's rights, which is why this works.
--
-- If a Prisma migration ever fails with "cannot drop/alter column ... because other
-- objects depend on it": run  DROP SCHEMA ops CASCADE;  then migrate, then re-run this file.
--
-- Days are IST calendar days. Prisma stores timestamps as UTC without a zone, hence
-- ("col" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata').

DROP SCHEMA IF EXISTS ops CASCADE;
CREATE SCHEMA ops;

CREATE FUNCTION ops.ist_day(ts timestamp) RETURNS date
  LANGUAGE sql IMMUTABLE AS $$ SELECT (ts AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date $$;

-- 1. One row per IST day for the last 180 days. "Demo" = uploaded by the admin API on a
--    developer's behalf (authorName is set); everything else is a real user's upload.
--    Runs exclude owners running their own app (byOwner), same as the app's own figures.
CREATE VIEW ops.daily AS
WITH days AS (
  SELECT d::date AS day
  FROM generate_series(ops.ist_day(now()::timestamp - interval '179 days'),
                       ops.ist_day(now()::timestamp), interval '1 day') d
),
signups AS (
  SELECT ops.ist_day("createdAt") AS day, count(*) n,
         count(*) FILTER (WHERE "onboardingCompleted") onboarded
  FROM "User" WHERE "deletedAt" IS NULL GROUP BY 1
),
uploads AS (
  SELECT ops.ist_day("createdAt") AS day,
         count(*) FILTER (WHERE "authorName" IS NULL) user_uploads,
         count(*) FILTER (WHERE "authorName" IS NOT NULL) demo_uploads
  FROM "App" GROUP BY 1
),
runs AS (
  SELECT ops.ist_day("startedAt") AS day, count(*) runs,
         count(DISTINCT "appId") apps_run,
         round(coalesce(sum("durationMs"), 0) / 60000.0, 1) run_minutes,
         round(coalesce(sum("activeMs"), 0) / 60000.0, 1) active_minutes,
         count(*) FILTER (WHERE "launchFailed") launch_failed,
         count(*) FILTER (WHERE "crashed") crashed,
         round(coalesce(sum("videoBytes"), 0) / 1e9, 3) video_gb
  FROM "RunSession" WHERE NOT "byOwner" GROUP BY 1
),
visits AS (SELECT "date" AS day, sum("count") n FROM "AppPageVisitDaily" GROUP BY 1),
clicks AS (SELECT ops.ist_day("createdAt") AS day, count(*) n FROM "PlayStoreClick" GROUP BY 1),
trial_req AS (SELECT ops.ist_day("createdAt") AS day, count(*) n FROM "TrialRequest" GROUP BY 1)
SELECT days.day,
       coalesce(signups.n, 0)               AS signups,
       coalesce(signups.onboarded, 0)       AS signups_onboarded,
       coalesce(uploads.user_uploads, 0)    AS user_uploads,
       coalesce(uploads.demo_uploads, 0)    AS demo_uploads,
       coalesce(runs.runs, 0)               AS runs,
       coalesce(runs.apps_run, 0)           AS apps_run,
       coalesce(runs.run_minutes, 0)        AS run_minutes,
       coalesce(runs.active_minutes, 0)     AS active_minutes,
       coalesce(runs.launch_failed, 0)      AS launch_failed,
       coalesce(runs.crashed, 0)            AS crashed,
       coalesce(runs.video_gb, 0)           AS video_gb,
       coalesce(visits.n, 0)                AS app_page_visits,
       coalesce(clicks.n, 0)                AS play_store_clicks,
       coalesce(trial_req.n, 0)             AS trial_requests
FROM days
LEFT JOIN signups   USING (day)
LEFT JOIN uploads   USING (day)
LEFT JOIN runs      USING (day)
LEFT JOIN visits    USING (day)
LEFT JOIN clicks    USING (day)
LEFT JOIN trial_req USING (day);

-- 2. Uploads by category, all time and last 30 days.
CREATE VIEW ops.uploads_by_category AS
SELECT "category"::text AS category,
       count(*) FILTER (WHERE "authorName" IS NULL) AS user_uploads,
       count(*) FILTER (WHERE "authorName" IS NOT NULL) AS demo_uploads,
       count(*) FILTER (WHERE "authorName" IS NULL
                          AND "createdAt" > now()::timestamp - interval '30 days') AS user_uploads_30d
FROM "App" GROUP BY 1;

-- 3. Uploads waiting for your security review (Needs you, P0).
CREATE VIEW ops.flagged_apps AS
SELECT a."slug", a."name", a."packageName", a."versionName", u."usertag" AS owner_usertag,
       a."createdAt", a."updatedAt", a."scanDetail"
FROM "App" a JOIN "User" u ON u."id" = a."ownerId"
WHERE a."scanStatus" = 'FLAGGED';

-- 4. Own-app demos: held by @taptry until claimed. pending_owner_email is the developer
--    address the demo was uploaded for (cleared once it moves); matched to the Leads tab.
CREATE VIEW ops.demo_apps AS
SELECT a."slug", a."name", a."packageName", a."authorName", a."sourceUrl", a."createdAt",
       a."scanStatus"::text AS scan_status, a."bootOk" AS boot_ok,
       lower(a."pendingOwnerEmail") AS pending_owner_email,
       (a."pendingOwnerEmail" IS NOT NULL OR a."claimToken" IS NOT NULL) AS held_by_taptry,
       a."claimTokenExpiresAt" AS claim_expires_at,
       coalesce(r.runs, 0) AS runs_by_others,
       r.last_run_at,
       coalesce(v.visits, 0) AS page_visits,
       a."playStoreClickCount" AS play_store_clicks
FROM "App" a
LEFT JOIN (SELECT "appId", count(*) runs, max("startedAt") last_run_at
           FROM "RunSession" WHERE NOT "byOwner" GROUP BY 1) r ON r."appId" = a."id"
LEFT JOIN (SELECT "appId", sum("count") visits FROM "AppPageVisitDaily" GROUP BY 1) v ON v."appId" = a."id"
WHERE a."authorName" IS NOT NULL;

-- 5. Signups, for matching leads without handing over emails: the Worker hashes each
--    lead's lowercased email the same way and compares.
CREATE VIEW ops.signups AS
SELECT encode(sha256(convert_to(lower(u."email"), 'UTF8')), 'hex') AS email_sha256,
       u."createdAt", u."onboardingCompleted" AS onboarding_completed, u."onboardingStep" AS onboarding_step,
       u."appCount" AS app_count,
       p."name"::text AS plan, s."status"::text AS subscription_status
FROM "User" u
LEFT JOIN "Subscription" s ON s."userId" = u."id"
LEFT JOIN "Plan" p ON p."id" = s."planId"
WHERE u."deletedAt" IS NULL;

-- 6. Paid subscriptions (FREE rows left out). monthly_amount_cents comes from the latest
--    plan payment (not run packs), divided by 12 for yearly plans.
CREATE VIEW ops.subscriptions AS
SELECT s."id", p."name"::text AS plan, s."status"::text AS status, s."interval"::text AS billing_interval,
       s."cancelAtPeriodEnd" AS cancel_at_period_end, s."currentPeriodEnd" AS current_period_end,
       s."createdAt", s."updatedAt", s."statusEventAt" AS status_event_at,
       lp."amountCents" AS last_amount_cents, lp."currency" AS last_currency, lp."createdAt" AS last_paid_at,
       CASE WHEN s."interval" = 'YEARLY' THEN round(lp."amountCents" / 12.0) ELSE lp."amountCents" END
         AS monthly_amount_cents
FROM "Subscription" s
JOIN "Plan" p ON p."id" = s."planId"
LEFT JOIN LATERAL (
  SELECT "amountCents", "currency", "createdAt" FROM "Payment"
  WHERE "subscriptionId" = s."id" AND "runPackId" IS NULL
  ORDER BY "createdAt" DESC LIMIT 1
) lp ON true
WHERE p."name" <> 'FREE';

-- 7. Every payment, plan or run pack.
CREATE VIEW ops.payments AS
SELECT pay."id", pay."createdAt", ops.ist_day(pay."createdAt") AS day, pay."amountCents" AS amount_cents,
       pay."currency", pay."status",
       CASE WHEN pay."runPackId" IS NOT NULL THEN 'run_pack' ELSE 'plan' END AS kind,
       p."name"::text AS plan
FROM "Payment" pay
JOIN "Subscription" s ON s."id" = pay."subscriptionId"
JOIN "Plan" p ON p."id" = s."planId";

-- 8. Run-pack checkouts opened 2+ hours ago and never paid, last 14 days.
CREATE VIEW ops.abandoned_checkouts AS
SELECT rp."id", rp."createdAt", rp."quantity", rp."amountCents" AS amount_cents, rp."currency"::text AS currency,
       u."usertag"
FROM "RunPack" rp
JOIN "Subscription" s ON s."id" = rp."subscriptionId"
JOIN "User" u ON u."id" = s."userId"
WHERE rp."status" = 'CREATED'
  AND rp."createdAt" < now()::timestamp - interval '2 hours'
  AND rp."createdAt" > now()::timestamp - interval '14 days';

-- 9. Open abuse and copyright reports (Needs you: COPYRIGHT and MALWARE are P0).
CREATE VIEW ops.open_reports AS
SELECT r."id", r."createdAt", r."reason"::text AS reason, r."note", r."reporterEmail" AS reporter_email,
       a."slug" AS app_slug, a."name" AS app_name
FROM "Report" r JOIN "App" a ON a."id" = r."appId"
WHERE r."status" = 'OPEN';

-- 10. Enterprise "Contact us" requests from the pricing page, last 90 days (Needs you, P0).
CREATE VIEW ops.enterprise_inquiries AS
SELECT "id", "createdAt", "name", "email", "company", "expectedTrials" AS expected_trials,
       "useCase" AS use_case, "timeZone" AS time_zone
FROM "EnterpriseInquiry"
WHERE "createdAt" > now()::timestamp - interval '90 days';

-- 11. Live fleet from the app's own registry, next to AWS's view of it.
CREATE VIEW ops.fleet AS
SELECT "ec2InstanceId" AS ec2_instance_id, "region", "status"::text AS status, "capacity",
       "activeSessions" AS active_sessions, "lastHeartbeatAt" AS last_heartbeat_at,
       ("lastHeartbeatAt" IS NULL OR "lastHeartbeatAt" < now()::timestamp - interval '5 minutes') AS heartbeat_stale,
       "createdAt"
FROM "WorkerInstance"
WHERE "status" <> 'TERMINATED';

-- Grants. Re-run every time, since the schema is rebuilt above.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_ro') THEN
    GRANT USAGE ON SCHEMA ops TO ops_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA ops TO ops_ro;
    GRANT EXECUTE ON FUNCTION ops.ist_day(timestamp) TO ops_ro;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- ONE-TIME: ROLE. Run this block once, BEFORE the rest of the file, with a long
-- random password of your own. Then put this in the Worker:
--   wrangler secret put APPDB_URL
--   postgresql://ops_ro:<password>@<your pooled Neon host>/<db>?sslmode=require
-- ---------------------------------------------------------------------------
-- CREATE ROLE ops_ro LOGIN PASSWORD 'replace-with-a-long-random-password';
-- ALTER ROLE ops_ro SET default_transaction_read_only = on;
-- ALTER ROLE ops_ro SET statement_timeout = '15s';
