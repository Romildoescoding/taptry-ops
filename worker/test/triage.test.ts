import { describe, expect, test } from "vitest";
import { triage } from "../src/triage";

// Real messages from the Needs-you list (Nov 2026), trimmed.
const cases: [string, Parameters<typeof triage>[0], string][] = [
  ["DMARC Microsoft", { from_addr: "dmarcreport@microsoft.com", from_name: "DMARC Aggregate Report", subject: "Report Domain: taptry.in Submitter: protection.outlook.com", body: "This is a DMARC aggregate report from Microsoft Corporation. For Emails received between 2026-11-07" }, "noise"],
  ["DMARC SpamTitan", { from_addr: "dmarc@spamtitan.com", subject: "Report Domain: taptry.in", body: "This is a DMARC aggregate report for taptry.in 1 records." }, "noise"],
  ["GMass open", { from_addr: "notify@gmass.co", subject: "Opened", body: "*Recipient:* support@infinitestudio.art *Subject:* Dude!! *City*: Unknown" }, "noise"],
  ["Nourish bot", { from_addr: "support@usenourish.com", subject: "Re: Nourish", body: "Hi Romil, I may not be best equipped to support you with this current conversation. This said, I want to make sure you get the best possible support, so I'd be happy to connect you with a human agent at Nourish" }, "auto"],
  ["Shred OOO", { from_addr: "hello@shred.app", from_name: "Team at Shred", subject: "Re: SHRED", body: "Hi there, This is an automatic reply while we work on processing your request. Our team responds within 24 hours" }, "auto"],
  ["Reverse Health", { from_addr: "care@reverse.health", from_name: "Customer Care from Reverse Health", subject: "Re: RH", body: "Thank you for reaching out to Reverse Health. Due to a current surge in inquiries, our team is handling a high volume of chats." }, "auto"],
  ["Delicious Monsters", { from_addr: "support@highscoregames.com", from_name: "HIGHSCORE GAMES", subject: "Re: Delicious Monsters", body: "Welcome, Chef. Thank you for your interest in Delicious Monster. Your feedback regarding the playable demo and the suggestion for the \"Try Now\" feature will be delivered to the relevant team for future reference." }, "auto"],
  ["invideo EVA", { from_addr: "support@invideo.io", from_name: "Eva from invideo", subject: "Re: invideo", body: "Hi Romil, I'm EVA, and your message came through to invideo support. I can't arrange a call or make decisions on behalf of the person you addressed" }, "auto"],
  ["meitu", { from_addr: "support@meitu.com", from_name: "meitu", subject: "Re: Wink", body: "Hi there, Thanks for reaching out and sharing your feedback. We have received your email and highly value it. If there is a need for cooperation in the future, we will proactively reach out to you." }, "auto"],
  ["Vidu", { from_addr: "support@vidu.com", from_name: "Support Vidu", subject: "Re: Vidu", body: "Dear user, Thank you so much for reaching out and sharing your passion for Vidu! We have received your feedback, and if there is an opportunity for further collaboration, we will be in touch with you in the future." }, "auto"],
  ["Turo", { from_addr: "support@turo.com", from_name: "Turo Support", subject: "Re: Turo", body: "We no longer use the email address support@turo.com for new support requests. But we're still available to help! Visit help.turo.com" }, "auto"],
  ["Wag html", { from_addr: "support@wagwalking.com", from_name: "Wag! Support", subject: "Re: Wag", body: "<span><!doctypehtml><meta content=width=device-width name=viewport><body><div class=\"ft-email-body\">Thanks for contacting Wag! We have received your request and a member of our team will get back to you shortly.</div></body>" }, "auto"],
  ["Parqet", { from_addr: "support@parqet.com", from_name: "Fin von Parqet", subject: "Re: Parqet", body: "Hello! Your message has reached us! You might already guess it, you are currently reading an automatically sent text. You will still receive a personal reply from us" }, "auto"],
  ["TalkCampus", { from_addr: "support@talkcampus.io", from_name: "TalkCampus Support", subject: "Re: let people try TalkLife", body: "Hi Tap Try, Thanks for getting in touch — we've received your support ticket and a member of the team will get back to you as soon as possible. Ticket #2095" }, "auto"],
  ["Wallcraft", { from_addr: "support@wallcraft.app", from_name: "Wallcraft Support", subject: "Re: Wallcraft", body: "Hello! Thank you for your message. We'd love to help, but we need a bit more information to understand the issue. Could you please describe the problem in more detail?" }, "auto"],
  ["NCH", { from_addr: "support@nch.com.au", from_name: "Emile, NCH Software", subject: "Re: NCH", body: "Hi! Thanks for your message! This platform is for customers/users who have technical inquiries regarding our programs. You may want to check your recipient address." }, "auto"],
  ["Zendesk agent header", { from_addr: "support@zeptolab.com", from_name: "ZeptoLab Support", subject: "Re: Cut the Rope", body: "### Do not reply below this line ### --------------------------------------------------------------------------------- ZeptoLab Support | November 22, 2026 | 09:41 -0600 ----- Hi! Our business team handles partnerships, I passed your idea along." }, "desk"],
  ["Zendesk ack", { from_addr: "support@peoplefun.com", from_name: "Peoplefun", subject: "[Peoplefun] Re: Wordscapes", body: "### Do not reply below this line ### ---- Peoplefun | November 15, 2026 ---- Thank you for contacting us! We have received your request and will respond within 24 hours." }, "auto"],
  ["Daniverse redirect", { from_addr: "support@daniverse.app", subject: "Re: Daniverse", body: "Hi Romil, Thank you for reaching out! Please contact us at milo@zygle.digital for further discussion. Best regards, Daniverse Games Team" }, "auto"],
  ["Vladimir (person)", { from_addr: "jetcarq@gmail.com", subject: "Re: idea", body: "Hi Your sample isn't working, but thanks for idea, demo option could be useful. Will create demo button and special workflow to show how it works on demo account." }, "person"],
  ["Indie dev on support@ asking price", { from_addr: "support@tinystudio.dev", subject: "Re: idea", body: "Thanks for reaching out. We're a 2-person studio, what would this cost us for 3 apps?" }, "person"],
  ["Indie dev on support@ saying yes", { from_addr: "support@tinystudio.dev", subject: "Re: idea", body: "Thanks for reaching out! Sure, I'll try it this weekend with our app." }, "person"],
  ["Plain human", { from_addr: "maya@gmail.com", subject: "Re: Quick idea", body: "Hey Romil, this looks neat. How does the trial link work for people who don't have an Android phone?" }, "person"],
];

describe("triage of real replies", () => {
  for (const [name, m, want] of cases) test(name, () => expect(triage(m).verdict).toBe(want));
  test("pricing question is hot", () => expect(triage(cases[20][1]).hot).toBe(true));
  test("a plain question is not hot", () => expect(triage(cases[22][1]).hot).toBe(false));
});
