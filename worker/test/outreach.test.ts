import { describe, expect, it } from "vitest";
import { classifyMail, firstInt, isoOrNull, leadFromSheet, logFamily, parseAddr, sourceKind } from "../src/ingest";
import { parseRange, istToday } from "../src/outreach";
import { buildQuery, cleanName, dateRangeFor } from "../src/posthog";
import { sign } from "../src/hmac";

describe("sheet mapping", () => {
  it("normalises dates, sources, inboxes and notes", () => {
    expect(isoOrNull("2026-11-15T14:14:11Z")).toBe("2026-11-15T14:14:11.000Z");
    expect(isoOrNull("2026-11-15 15:15")).toBe("2026-11-15T15:15:00.000Z");
    expect(isoOrNull("")).toBeNull();
    expect(sourceKind("warm:reddit /r/androiddev/abc https://x")).toBe("reddit");
    expect(sourceKind("warm:ownapp https://github.com/a/b")).toBe("ownapp");
    expect(sourceKind("https://play.google.com/store/apps/details?id=x")).toBe("play");
    expect(firstInt("Play new: 174 (connect 57)")).toBe(174);
    expect(firstInt("followups: 0")).toBe(0);
    expect(logFamily("Daily AM (resumed after send)")).toBe("daily");
    expect(logFamily("Warm leads PM")).toBe("warm");
    const lead = leadFromSheet({
      Email: "Dev@Example.com", Status: "followed_up", Inbox: "reachout@taptry.in", Source: "warm:github https://github.com/a",
      "First sent (UTC)": "2026-11-10T04:00:00Z", Notes: "v=C hook... [FU1] 2026-11-12 [FU2] 2026-11-14 Auto-reply received", _row: 12,
    });
    expect(lead).toMatchObject({ email: "dev@example.com", inbox: "reachout", source_kind: "github", fu_count: 2, variant: "C", auto_reply: 1, row_num: 12 });
  });
});

describe("mail classification", () => {
  const owner = "romilrajrana1@gmail.com";
  const own = ["connect@taptry.in", "reachout@taptry.in", "hello@taptry.in"];
  const base = { id: "1", threadId: "t", date: 0 };
  it("tells sent, human, auto, bounce and Romil apart", () => {
    expect(classifyMail({ ...base, labels: ["SENT"], from: "connect@taptry.in", to: "dev@x.com" }, owner, own)).toEqual({ direction: "out", kind: "out" });
    expect(classifyMail({ ...base, labels: ["SENT"], from: "connect@taptry.in", to: owner }, owner, own).kind).toBe("internal");
    expect(classifyMail({ ...base, labels: ["INBOX"], from: "Dev <dev@x.com>", subject: "Re: Pixel Runner in your browser" }, owner, own).kind).toBe("human");
    expect(classifyMail({ ...base, labels: ["INBOX"], from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)" }, owner, own).kind).toBe("bounce");
    expect(classifyMail({ ...base, labels: ["INBOX"], from: "Dev <dev@x.com>", subject: "Automatic reply: hi" }, owner, own).kind).toBe("auto");
    expect(classifyMail({ ...base, labels: ["INBOX"], from: "Dev <dev@x.com>", subject: "Re: hi", autoSubmitted: "auto-replied" }, owner, own).kind).toBe("auto");
    expect(classifyMail({ ...base, labels: ["INBOX"], from: `Romil <${owner}>`, subject: "Re: #R7" }, owner, own).kind).toBe("romil");
    expect(parseAddr('"Jane Doe" <Jane@Doe.com>')).toEqual({ name: "Jane Doe", addr: "jane@doe.com" });
  });
});

describe("date ranges", () => {
  const now = new Date("2026-11-22T20:00:00Z"); // 23 Nov 01:30 IST
  it("uses IST days", () => {
    expect(istToday(now)).toBe("2026-11-23");
    const r = parseRange({ preset: "7d" }, now);
    expect(r.from).toBe("2026-11-17");
    expect(r.to).toBe("2026-11-23");
    expect(r.days.length).toBe(7);
    expect(r.fromUtc).toBe("2026-11-16T18:30:00.000Z");
    const y = parseRange({ preset: "yesterday" }, now);
    expect([y.from, y.to]).toEqual(["2026-11-22", "2026-11-22"]);
    expect(parseRange({ from: "2026-11-01", to: "2026-11-05" }, now).days.length).toBe(5);
  });
});

describe("PostHog query override", () => {
  it("swaps the date range, keeps weekly math intervals, adds compare to big numbers", () => {
    const bold = { kind: "TrendsQuery", series: [{ event: "$pageview", math: "dau" }], dateRange: { date_from: "-30d" }, trendsFilter: { display: "BoldNumber" } };
    expect(buildQuery(bold, { preset: "7d", compare: true })).toMatchObject({ dateRange: { date_from: "-7d", date_to: null }, compareFilter: { compare: true } });
    const wau = { kind: "TrendsQuery", series: [{ math: "weekly_active" }], interval: "day" };
    expect(buildQuery(wau, { preset: "90d", interval: "week" }).interval).toBe("day");
    expect(buildQuery({ kind: "TrendsQuery", series: [{}], interval: "day" }, { interval: "week" }).interval).toBe("week");
    expect(dateRangeFor({ from: "2026-11-01", to: "2026-11-10" })).toEqual({ date_from: "2026-11-01", date_to: "2026-11-10" });
    expect(cleanName("Active users (last 30 days)")).toBe("Active users");
    expect(cleanName("Sessions (Last 7 days)")).toBe("Sessions");
  });
});

describe("Apps Script signature format", () => {
  it("matches HMAC-SHA256 hex of `${ts}.${body}`", async () => {
    // Known value computed independently: HMAC-SHA256(key="k", msg="1.{}")
    const s = await sign("k", "1", "{}");
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    const crypto2 = await import("node:crypto");
    expect(s).toBe(crypto2.createHmac("sha256", "k").update("1.{}").digest("hex"));
  });
});

import { validWebappUrl } from "../src/gas";
import { test as t2, expect as e2 } from "vitest";
t2("pasted web app links are accepted in both Google forms", () => {
  const id = "AKfycbzMTAqam6q7Sb-ZOVzdcY3Q67pTViWzVxE_PlCEFt1NdXUKNaY";
  e2(validWebappUrl(` https://script.google.com/macros/s/${id}/exec `)).toBe(`https://script.google.com/macros/s/${id}/exec`);
  e2(validWebappUrl(`https://script.google.com/a/macros/taptry.in/s/${id}/exec`)).toBe(`https://script.google.com/a/macros/taptry.in/s/${id}/exec`);
  e2(validWebappUrl(`https://script.google.com/macros/s/${id}/dev`)).toBeNull();
  e2(validWebappUrl("https://evil.example/macros/s/x/exec")).toBeNull();
  e2(validWebappUrl(undefined)).toBeNull();
});
