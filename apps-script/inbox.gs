/**
 * TapTry Ops: inbox script. One copy in each of connect@, reachout@ and hello@.
 * Create it at script.google.com while signed in as that inbox.
 * 1. Project Settings: tick "Show appsscript.json", then paste appsscript.json from the repo.
 * 2. Script properties:
 *      INGEST_URL     https://ingest.taptry.in
 *      INGEST_SECRET  same value as the Worker's INGEST_SECRET
 *      INBOX          connect | reachout | hello
 * 3. Run setup() once and approve.
 * 4. Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone". Deploy.
 *
 * Every 5 minutes it pushes new mail to the dashboard (the first run goes back 14 days).
 * As a web app it lets the dashboard read a thread and send your reply from this inbox.
 * Every request to it must be signed with INGEST_SECRET, or it's refused.
 */

var BACKFILL_DAYS = 14;
var WINDOW_SEC = 2 * 3600;
var TIME_BUDGET_MS = 4.5 * 60 * 1000;
// Gmail allows a limited number of reads per minute per inbox. Reads are spaced out,
// and if Gmail still says "quota exceeded" the script waits and tries again. The first
// 14-day catch-up therefore takes a few runs; it carries on by itself every 5 minutes.
var PAUSE_MS = 150;
var STOP = 'STOP_FOR_NOW';

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pushMail').timeBased().everyMinutes(5).create();
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('CHECKPOINT')) p.setProperty('CHECKPOINT', String(Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 86400));
  pushMail();
  Logger.log('Set up. Now deploy as a web app (Execute as Me, access Anyone).');
}

function pushMail() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var p = PropertiesService.getScriptProperties();
    var started = Date.now();
    var checkpoint = Number(p.getProperty('CHECKPOINT')) || Math.floor(Date.now() / 1000) - 3600;
    var now = Math.floor(Date.now() / 1000);
    while (checkpoint < now - 60 && Date.now() - started < TIME_BUDGET_MS) {
      var end = Math.min(checkpoint + WINDOW_SEC, now - 60);
      // 10-minute overlap: late-arriving mail is caught; duplicates are harmless.
      var msgs = fetchWindow_(checkpoint - 600, end, started);
      if (msgs === null) break; // ran out of time mid-window: retry this window next run
      for (var i = 0; i < msgs.length; i += 100) post_('/ingest/v1/mail/' + inbox_(), { messages: msgs.slice(i, i + 100), webapp: webappUrl_() });
      if (!msgs.length) post_('/ingest/v1/mail/' + inbox_(), { messages: [], webapp: webappUrl_() });
      checkpoint = end;
      p.setProperty('CHECKPOINT', String(checkpoint));
    }
    Logger.log('Mail synced up to ' + new Date(checkpoint * 1000) + (checkpoint < now - 900 ? '. Still catching up; the next runs continue automatically.' : '. Up to date.'));
  } finally {
    lock.releaseLock();
  }
}

function fetchWindow_(after, before, started) {
  var q = 'after:' + after + ' before:' + before + ' -in:chats -in:spam -in:trash -in:drafts';
  var ids = [], token = null;
  try {
    do {
      var res = gmail_(function () { return Gmail.Users.Messages.list('me', { q: q, maxResults: 500, pageToken: token }); }, started);
      (res.messages || []).forEach(function (m) { ids.push(m.id); });
      token = res.nextPageToken;
    } while (token);
  } catch (e) {
    if (String(e && e.message) === STOP) return null;
    throw e;
  }
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    if (Date.now() - started > TIME_BUDGET_MS) return null;
    var id = ids[i];
    var meta;
    try {
      meta = gmail_(function () {
        return Gmail.Users.Messages.get('me', id, {
          format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Auto-Submitted', 'Precedence', 'X-Autoreply', 'X-Autorespond'],
        });
      }, started);
    } catch (e) {
      if (String(e && e.message) === STOP) return null;
      throw e;
    }
    var labels = meta.labelIds || [];
    var h = headers_(meta.payload && meta.payload.headers);
    var m = {
      id: meta.id, threadId: meta.threadId, labels: labels, from: h['from'] || '', to: h['to'] || '', subject: h['subject'] || '',
      date: Number(meta.internalDate), snippet: meta.snippet || '', autoSubmitted: h['auto-submitted'] || '',
      precedence: h['precedence'] || '', autoReplyHeader: h['x-autoreply'] || h['x-autorespond'] || '',
    };
    if (labels.indexOf('SENT') < 0) {
      try {
        m.body = cleanBody_(gmail_(function () { return GmailApp.getMessageById(meta.id).getPlainBody(); }, started)).slice(0, 6000);
      } catch (e) {
        if (String(e && e.message) === STOP) return null;
        m.body = '';
      }
    }
    out.push(m);
  }
  return out;
}

// ---------- web app: called by the dashboard ----------

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    verify_(req.ts, req.sig, req.payload);
    var p = JSON.parse(req.payload);
    if (p.action === 'ping') return json_({ ok: true, inbox: inbox_() });
    if (p.action === 'thread') return json_({ ok: true, messages: thread_(p.threadId) });
    if (p.action === 'reply') return json_(reply_(p.threadId, p.body));
    if (p.action === 'sync') { pushMail(); return json_({ ok: true }); }
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet() {
  return json_({ ok: false, error: 'POST only' });
}

function thread_(threadId) {
  var me = Session.getEffectiveUser().getEmail().toLowerCase();
  var t = GmailApp.getThreadById(threadId);
  if (!t) throw new Error('thread not found in ' + me);
  return t.getMessages().map(function (m) {
    return {
      id: m.getId(), from: m.getFrom(), to: m.getTo(), date: m.getDate().getTime(), subject: m.getSubject(),
      body: cleanBody_(m.getPlainBody()).slice(0, 8000), mine: m.getFrom().toLowerCase().indexOf(me) >= 0,
    };
  });
}

/** Replies in the thread to the lead's latest message, from this inbox. */
function reply_(threadId, body) {
  if (!body || String(body).trim().length < 2) throw new Error('empty reply');
  var me = Session.getEffectiveUser().getEmail().toLowerCase();
  var t = GmailApp.getThreadById(threadId);
  if (!t) throw new Error('thread not found');
  var msgs = t.getMessages();
  var target = null;
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].getFrom().toLowerCase().indexOf(me) < 0) { target = msgs[i]; break; }
  }
  if (!target) throw new Error('no message from the lead in this thread');
  target.reply(String(body));
  return { ok: true, to: target.getReplyTo() || target.getFrom(), subject: target.getSubject() };
}

// ---------- helpers ----------

function verify_(ts, sig, payload) {
  var secret = PropertiesService.getScriptProperties().getProperty('INGEST_SECRET');
  if (!secret || !ts || !sig || typeof payload !== 'string') throw new Error('unsigned');
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new Error('stale request');
  var expected = hex_(Utilities.computeHmacSha256Signature(ts + '.' + payload, secret, Utilities.Charset.UTF_8));
  if (expected !== sig) throw new Error('bad signature');
}

function cleanBody_(text) {
  var lines = String(text || '').replace(/\r/g, '').split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^On .{5,200}wrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || (/^From: /.test(l) && out.length > 0)) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Runs one Gmail call, spaced out, waiting and retrying when Gmail's per-minute limit is hit. */
function gmail_(fn, started) {
  var wait = 15000;
  for (;;) {
    try {
      var r = fn();
      Utilities.sleep(PAUSE_MS);
      return r;
    } catch (e) {
      var msg = String((e && e.message) || e);
      if (!/quota|rate limit|too many|429|try again later/i.test(msg)) throw e;
      if (Date.now() - started + wait > TIME_BUDGET_MS) throw new Error(STOP); // pick up again on the next run
      Utilities.sleep(wait);
      wait = Math.min(wait * 2, 60000);
    }
  }
}

function headers_(list) {
  var h = {};
  (list || []).forEach(function (x) { h[String(x.name).toLowerCase()] = x.value; });
  return h;
}

function inbox_() {
  var v = PropertiesService.getScriptProperties().getProperty('INBOX');
  if (['connect', 'reachout', 'hello'].indexOf(v) < 0) throw new Error('Set INBOX to connect, reachout or hello');
  return v;
}

function webappUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function hex_(bytes) {
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('');
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function post_(path, obj) {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('INGEST_URL'), secret = p.getProperty('INGEST_SECRET');
  if (!url || !secret) throw new Error('Set INGEST_URL and INGEST_SECRET in Script properties');
  var body = JSON.stringify(obj);
  var ts = String(Math.floor(Date.now() / 1000));
  var sig = hex_(Utilities.computeHmacSha256Signature(ts + '.' + body, secret, Utilities.Charset.UTF_8));
  var res = UrlFetchApp.fetch(url.replace(/\/$/, '') + path, {
    method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true,
    headers: { 'X-TT-Timestamp': ts, 'X-TT-Signature': sig },
  });
  var out = {};
  try { out = JSON.parse(res.getContentText()); } catch (e) { out = { error: res.getContentText().slice(0, 200) }; }
  if (res.getResponseCode() !== 200 || !out.ok) throw new Error(path + ': HTTP ' + res.getResponseCode() + ' ' + (out.error || ''));
  return out;
}
