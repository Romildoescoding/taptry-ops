// Decides whether an incoming email deserves Romil's attention.
//   noise   machine mail that is never worth reading (DMARC reports, open tracking, no-reply senders)
//   auto    an answer from a machine: out-of-office, ticket confirmations, support bots, "we'll get back to you"
//   desk    a company support desk writing back (ticket formats); possibly a person, rarely urgent
//   person  someone actually replied
// Only the first part of the message is checked, so quoted history and footers don't trip it.

export type Triage = { verdict: "noise" | "auto" | "desk" | "person"; reason?: string; hot?: boolean };

const NOISE_FROM =
  /^(dmarc|dmarcreport|noreply-dmarc-support|rua|ruf|mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|notifications?|notify|bounces?|news(letter)?|marketing|mailer)([+._-][^@]*)?@/i;
const NOISE_DOMAIN = /@([\w-]+\.)*(gmass\.co|mailchimp\.com|mcsv\.net|sendgrid\.net|amazonses\.com|mandrillapp\.com|hubspot(email)?\.(com|net)|intercom-mail\.com)$/i;
const NOISE_SUBJECT = /dmarc|aggregate report|report domain:|tls report|delivery status notification|undeliverable|mail delivery (failed|subsystem)|returned mail|email opened|was opened|link clicked/i;

const AUTO_SUBJECT =
  /^(re:\s*)?(automatic reply|auto(matic)?[ -]?(reply|response)|autoreply|out of (the )?office|ooo\b|away from|on vacation|on leave)|\[?(ticket|case|request) #?\s?\d+|request (received|#)|(we('ve| have)|has been) received|thank(s| you) for (contacting|reaching out to|your (email|message|inquiry|enquiry|request))|support (request|ticket)/i;

// Phrases only machines write.
const AUTO_STRONG = new RegExp(
  [
    "this is an? (automatic|automated|auto-?generated)",
    "automatic(ally)? (sent|generated|reply|response)",
    "auto-?reply",
    "out of (the )?office",
    "i('m| am) (currently )?(out|away|on (vacation|leave|holiday))",
    "(ticket|case|request) (#|number|no\\.?) ?\\d+",
    "ticket #?\\d+",
    "(you )?(do not|don't) need to reply",
    "(connect you with|transfer you to|speak (to|with)) a (human|live)( agent)?",
    "i may not be (the )?best equipped",
    "virtual (assistant|agent)",
    "i('m| am) (an? )?(ai|automated|virtual|bot)\\b",
    "i('m| am) eva\\b",
    "(ai|chat) ?bot",
    "due to (a |an )?(current |high |increased |unusually high )?(surge|volume|demand)",
    "high volume of (chats|emails|requests|inquiries|messages)",
    "no longer (use|monitor|accept)",
    "(is|are) not monitored|unmonitored",
    "this (platform|inbox|mailbox|address|channel) is (only )?for",
    "check your recipient address",
    "if there is (a need|an opportunity) for (further )?(cooperation|collaboration)",
    "we will (proactively )?(reach out|be in touch|contact you) (to you )?(if|when|in the future)",
    "will be delivered to the relevant team",
    "(has|have) been (forwarded|passed|shared) (on )?to (the|our)",
    "for (faster|quicker) (support|help|answers),? (please )?(visit|check|see)",
    "visit (our )?(help ?center|support (page|center|site)|faq)",
    "dmarc",
  ].join("|"),
  "i",
);
// Acknowledgement phrases; trusted when the sender looks like a support desk.
const ACK = new RegExp(
  [
    "we('ve| have) (received|got) your",
    "your (message|request|email|ticket|inquiry|enquiry) (has been|was|is) (received|logged|recorded)",
    "(a member of|someone (from|on)) (our|the) (support )?team will",
    "(will|we'll) (get back to you|respond|reply) (as soon as|shortly|within|soon)",
    "respond(s)? within \\d+",
    "within \\d+(-\\d+)? (business |working )?(hours|days)",
  ].join("|"),
  "i",
);
// Polite brush-offs; trusted only from a support desk and when nothing in the text reads like a real answer.
const SOFT = new RegExp(
  [
    "thank(s| you) for (your )?(contacting|reaching out|getting in touch|interest|message|email|feedback|patience)",
    "(please|kindly) (describe|provide|send) (the|your|us|more)",
    "need (a bit )?more information",
    "(please )?(contact|reach) us (at|via|through)|contact page|contact form",
  ].join("|"),
  "i",
);
// Signs a person engaged with the pitch.
const ENGAGED =
  /\b(sure|sounds|i('ll| will)|we('ll| will) (try|check|look|give|test)|looks (good|great|cool|nice|interesting)|love (it|this|the idea)|awesome|great idea|tried|trying|uploaded|signed|my app|our app|how (do|does|can|would)|can i|can we|could i|could we|would it|does it|is it)\b/i;

const DESK_SENDER =
  /^(support|help|helpdesk|care|customer[-._]?(care|service|support|success)|service|contact|info|feedback|hello|team|cs|ask)([+._-][^@]*)?@/i;
const DESK_NAME = /support|customer (care|service)|help ?desk|care team|team at|\bteam\b|service desk/i;
const DESK_FORMAT = /do not reply below this line|type your reply above this line|##-|ticket #|case #|zendesk|freshdesk|helpscout|intercom/i;

// Real buying or trouble signals, checked only on mail written by a person.
const HOT =
  /\b(pric(e|es|ing)|cost(s)?|how much|quote|invoice|contract|enterprise|meeting|schedule|book a call|(a|quick) call|zoom|google meet|calendly|interested|let'?s (talk|chat|try|do)|sign(ed)? up|onboard|partner(ship)?|integrat\w*|legal|gdpr|lawyer|scam|stop (emailing|sending)|remove me|cease)\b/i;

export function stripHtml(s: string): string {
  if (!/<[a-z!/][^>]*>/i.test(s)) return s;
  return s
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export function triage(m: { from_addr?: string | null; from_name?: string | null; subject?: string | null; body?: string | null; snippet?: string | null }): Triage {
  const from = (m.from_addr ?? "").toLowerCase();
  const name = m.from_name ?? "";
  const subject = m.subject ?? "";
  const text = stripHtml(m.body || m.snippet || "").slice(0, 900);

  if (NOISE_FROM.test(from) || NOISE_DOMAIN.test(from)) return { verdict: "noise", reason: "Automated sender" };
  if (NOISE_SUBJECT.test(subject) || /^this is a dmarc|dmarc aggregate report/i.test(text)) return { verdict: "noise", reason: "Report / notification" };

  if (AUTO_SUBJECT.test(subject)) return { verdict: "auto", reason: "Auto-reply" };
  if (AUTO_STRONG.test(text)) return { verdict: "auto", reason: "Auto-reply / support bot" };

  const deskish = DESK_SENDER.test(from) || DESK_NAME.test(name) || DESK_FORMAT.test(text);
  const hot = HOT.test(text); // not the subject: it carries the app name (e.g. "Quick Invoice")
  if (deskish && ACK.test(text)) return { verdict: "auto", reason: "Support desk acknowledgement" };
  if (deskish && SOFT.test(text) && !hot && !ENGAGED.test(text)) return { verdict: "auto", reason: "Support desk brush-off" };
  if (deskish && DESK_FORMAT.test(text)) return { verdict: "desk", reason: "Support desk" };

  return { verdict: "person", hot };
}
