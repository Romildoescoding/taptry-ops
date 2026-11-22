/**
 * TapTry Ops: Outreach Tracker script (runs as connect@).
 * Paste into the TapTry Outreach Tracker: Extensions > Apps Script.
 * Script properties (Project Settings > Script properties):
 *   INGEST_URL     https://ingest.taptry.in
 *   INGEST_SECRET  the same value as the Worker's INGEST_SECRET
 * Then run setup() once and approve.
 *
 * Every 5 minutes: pushes changed rows of Leads, Escalations, Nudges and Log to the
 * dashboard, and writes back changes you made there (lead status, escalation sent).
 * Every day at 9:00 IST: sends you the digest email from connect@.
 */

var TABS = ['Leads', 'Escalations', 'Nudges', 'Log'];
var CHUNK = 100;
var STATE_FILE = 'taptry-ops-sync-state.json';

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pushChanges').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('fullSync').timeBased().atHour(3).everyDays(1).inTimezone('Asia/Kolkata').create();
  ScriptApp.newTrigger('sendDigest').timeBased().atHour(9).nearMinute(0).everyDays(1).inTimezone('Asia/Kolkata').create();
  fullSync();
  Logger.log('Set up. First full sync done.');
}

function fullSync() {
  saveState_({});
  pushChanges();
}

function pushChanges() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var state = loadState_();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    TABS.forEach(function (tab) {
      var sheet = ss.getSheetByName(tab);
      if (!sheet) return;
      var values = sheet.getDataRange().getValues();
      if (values.length < 1) return;
      var headers = values[0].map(function (h) { return String(h).trim(); });
      var seen = state[tab] || {};
      var changed = [], hashes = [];
      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (row.join('').trim() === '') continue;
        var obj = { _row: i + 1 };
        headers.forEach(function (h, j) { if (h) obj[h] = cell_(row[j]); });
        var key = keyFor_(tab, obj, i);
        var hash = md5_(JSON.stringify(row.map(cell_)));
        if (seen[key] !== hash) { changed.push(obj); hashes.push([key, hash]); }
      }
      for (var k = 0; k < changed.length; k += CHUNK) {
        post_('/ingest/v1/sheet/' + tab, { headers: headers, rows: changed.slice(k, k + CHUNK) });
        hashes.slice(k, k + CHUNK).forEach(function (kh) { seen[kh[0]] = kh[1]; });
        state[tab] = seen;
        saveState_(state); // keep progress if a later chunk fails
      }
      state[tab] = seen;
    });
    saveState_(state);
    applyUpdates_();
  } finally {
    lock.releaseLock();
  }
}

/** Writes back what you changed on the dashboard: lead Status, escalation Status/answer/sent time. */
function applyUpdates_() {
  var res = post_('/ingest/v1/sheet-updates', {});
  var updates = res.updates || [];
  if (!updates.length) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var done = [];
  var cache = {};
  updates.forEach(function (u) {
    var sheet = ss.getSheetByName(u.tab);
    if (!sheet) return;
    if (!cache[u.tab]) cache[u.tab] = sheet.getDataRange().getValues();
    var values = cache[u.tab];
    var headers = values[0].map(function (h) { return String(h).trim(); });
    var keyCol = headers.indexOf(u.tab === 'Leads' ? 'Email' : 'ID');
    var col = headers.indexOf(u.col);
    if (keyCol < 0 || col < 0) { done.push(u.id); return; }
    for (var i = 1; i < values.length; i++) {
      var k = String(values[i][keyCol]).trim().toLowerCase().replace(/^#/, '');
      if (k === String(u.key).toLowerCase().replace(/^#/, '')) {
        sheet.getRange(i + 1, col + 1).setValue(u.value);
        values[i][col] = u.value;
        break;
      }
    }
    done.push(u.id);
  });
  if (done.length) post_('/ingest/v1/sheet-updates', { ack: done });
}

function sendDigest() {
  var d = post_('/ingest/v1/digest', {});
  MailApp.sendEmail({ to: d.to, subject: d.subject, htmlBody: d.html, name: 'TapTry Ops' });
}

// ---------- helpers ----------

function keyFor_(tab, o, i) {
  if (tab === 'Leads') return String(o['Email'] || 'row' + i).toLowerCase();
  if (tab === 'Escalations') return String(o['ID'] || 'row' + i);
  if (tab === 'Nudges') return String(o['Sent (UTC)']) + '|' + String(o['Email']).toLowerCase();
  return String(o['Run (UTC)']) + '|' + String(o['Type']);
}

function cell_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  return v === null || v === undefined ? '' : v;
}

function md5_(s) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)).slice(0, 16);
}

function hex_(bytes) {
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('');
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

function stateFile_() {
  var it = DriveApp.getFilesByName(STATE_FILE);
  return it.hasNext() ? it.next() : DriveApp.createFile(STATE_FILE, '{}', 'application/json');
}

function loadState_() {
  try { return JSON.parse(stateFile_().getBlob().getDataAsString()) || {}; } catch (e) { return {}; }
}

function saveState_(state) {
  stateFile_().setContent(JSON.stringify(state));
}
