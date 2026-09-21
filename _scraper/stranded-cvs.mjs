#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia: the CVs stranded on the Storage landing strip, and who
   they belong to.

   WHY THEY ARE THERE. post-a-candidate.html uploads the CV FIRST and writes
   the profile document second (the order is deliberate: a profile must never
   point at an upload that failed). From 2026-09-04 to 20:58 UTC on 2026-09-17
   every candidateSubmissions write was refused by a ruleset past Firestore's
   evaluation budget (CLAUDE.md, "Candidates were turned away for two weeks"),
   while _storage.rules, a separate ruleset, went on accepting files. So a
   candidate who attached a CV had it uploaded and then had the profile
   refused, and nothing collects such a file: the build files only what a
   document points at, and the account-deletion sweep clears a folder only for
   an account that is going. Every object under uploads/<uid>/candidates/ with
   no document behind it is a candidate who was turned away, and the account
   behind the uid says who. (The same is true of a job advert under
   uploads/<uid>/jobs/; those are reported and left alone.)

   THE LOG THIS PRINTS INTO IS THE ACTIONS LOG OF A PUBLIC REPOSITORY, which is
   why the modes are what they are:

     --scan      counts, and one line per orphan: the uid, the kind, the
                 REDACTED address, the day, whether it fell in the outage, and
                 what happens next. No name and no filename ever: a filename
                 carries the person's name. The workflow's default.
     --report    e-mail the maintainer the whole table (name, affiliation,
                 address, account, file, day, status). The one place the
                 names go.
     --invite    write ONCE to each turned-away candidate who has no profile
                 for the season under way, asking them to post again. The
                 mark is strandedInvites/{uid}.invitedAt, in a collection no
                 client may read or write (the rules' catch-all), so no rules
                 change; a failed send stamps nothing and goes out on the
                 next press. --dry-run lists the uids it would write to.
     --clean     delete the outage's orphans whose account has been invited
                 or has since posted a profile: the file has done its one
                 job, naming the person, and is personal data that nothing
                 else clears. An orphan whose owner has not been invited
                 stays, so the list is never destroyed before it is used.
     --print     the whole table to stdout, for a run on the maintainer's own
                 machine with the credential. REFUSED on a runner.
     --selftest  offline checks, no network, no credentials

   WHAT "REBUILD THEIR PROFILES" CANNOT MEAN. A refused write stored nothing:
   the position, the research areas, the INFORMS days and the talk details
   were never anywhere but the browser, and the form kept no draft until
   2026-09-21. The CV is the only thing that survived. The invite is the
   whole of the rebuild: each candidate posts once more, which now takes a
   few minutes and is kept as a draft while they type.

   THE USAGE RECORD IS THE BETTER LIST, and the first run proved it. On
   2026-09-21 the strip held no candidate CV from the outage at all: the CV
   is optional and most candidates paste a link, so a refused profile left
   nothing in Storage. What every signed-in visit DOES leave is a document in
   usageSessions (assets/oa-usage.js): the page, when, which buttons were
   pressed and which fields were touched, never what was typed. A signed-in
   account that pressed "Post my profile" on the candidate form inside the
   window and holds no profile is a candidate the site refused, so the same
   run reads those sessions (--scan, --report and --invite alike) and lists
   them beside the CVs, marked `visit`. An account that opened the form and
   pressed nothing, or pressed Save changes on a profile it already had, is
   reported and never written to.
   --------------------------------------------------------------------------- */

import { isMain } from './_main.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { send, transport, firebaseAdmin, redact, esc, shell, SITE, CONTACT } from './_mail.mjs';
import { marketYear } from './jobs-model.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const REPORT = has('--report');
const INVITE = has('--invite');
const CLEAN = has('--clean');
const PRINT = has('--print');
const DRY = has('--dry-run');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/** The same bucket build-jobs.mjs, build-candidates.mjs and purge-accounts.mjs
    name; pinned against purge-accounts.mjs by the selftest. */
export const BUCKET = 'operations-academia.firebasestorage.app';
/** The outage: the ruleset crossed the budget on 2026-09-04 and the fix was
    published at 20:58:35 UTC on 2026-09-17 (the deploy log's own stamp). */
export const OUTAGE = { from: '2026-09-04T00:00:00.000Z', to: '2026-09-17T20:58:35.000Z' };
/** The once-only mark for the invite. Closed to every client by the rules'
    catch-all, so it needs no rules change. */
export const INVITES = 'strandedInvites';
export const INVITED_AT = 'invitedAt';
/** One message a second. */
export const PACE_MS = 1000;
/** What each kind of upload points at, and which statuses count as a live
    profile for "has since posted". */
export const KINDS = {
  candidates: { collection: 'candidateSubmissions', paths: ['cvUploadPath', 'rsUploadPath'] },
  jobs: { collection: 'jobSubmissions', paths: ['adUploadPath'] },
};
export const LIVE = ['queued', 'published'];
/** The candidate form's page as oa-usage.js files it (the pathname, with or
    without .html, with or without a query), the words on the two buttons a
    refused press was made with, and how many usage documents one read asks
    for. */
export const FORM_PAGE = '/post-a-candidate';
export const PRESS = { post: /^post my profile$/i, save: /^save changes$/i };
export const SESSION_PAGE = 5000;
/** Where the report goes: the same address the build's change e-mail uses. */
export const ADMIN = process.env.ADMIN_NOTIFY || 'kstouras@gmail.com';

/* ------------------------------------------------------------- pure halves */

/** uploads/<uid>/<kind>/<ms>-<name>, as both forms write it, or null. */
export function parseUploadPath(p) {
  const m = /^uploads\/([^/]+)\/(candidates|jobs)\/(\d+)-(.+)$/.exec(String(p || ''));
  if (!m) return null;
  return { uid: m[1], kind: m[2], stamp: Number(m[3]), name: m[4] };
}

/** When the object was created: Storage's own stamp, else the millisecond
    prefix the form put in the name, else ''. */
export function whenOf(file) {
  const t = file && file.metadata && file.metadata.timeCreated;
  if (t) { const d = new Date(t); if (!isNaN(d)) return d.toISOString(); }
  const parsed = parseUploadPath(file && file.name);
  if (parsed && parsed.stamp > 0) { const d = new Date(parsed.stamp); if (!isNaN(d)) return d.toISOString(); }
  return '';
}

export function inWindow(iso, w = OUTAGE) {
  return !!iso && iso >= w.from && iso <= w.to;
}

/** The objects no document points at, oldest first. `referenced` is the set
    of every *UploadPath value across every submission document, whatever its
    status: a pending upload the build has not filed yet is not an orphan. */
export function orphans(files, referenced) {
  const out = [];
  for (const f of files || []) {
    const parsed = parseUploadPath(f && f.name);
    if (!parsed) continue;
    if (referenced.has(f.name)) continue;
    const at = whenOf(f);
    out.push({ path: f.name, uid: parsed.uid, kind: parsed.kind, file: parsed.name,
      at, inOutage: inWindow(at) });
  }
  return out.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
}

/** What happens next for one orphan. Only a candidate's CV from the outage,
    whose account has no profile this season and has not been invited, is
    written to; everything else is reported and left where it is. */
export function nextStep(row, ctx) {
  if (row.kind === 'visit') {
    if (!row.pressed) return 'opened-only';
    if (row.pressed === 'save') return 'edit-refused';
  } else {
    if (row.kind !== 'candidates') return 'job-advert';
    if (!row.inOutage) return 'outside-window';
  }
  if (ctx.profiled.has(row.uid)) return 'came-back';
  if (ctx.invited.has(row.uid)) return 'invited';
  if (!String(row.email || '').trim()) return 'no-address';
  return 'invite';
}

/** An orphan may be deleted once its one job, naming the person, is done:
    the account was invited, or posted a profile of its own accord. */
export function cleanable(row, ctx) {
  return row.kind === 'candidates' && row.inOutage
    && (ctx.profiled.has(row.uid) || ctx.invited.has(row.uid));
}

/** Is this usage session an opening of the candidate form? */
export function onCandidateForm(page) {
  const p = String(page || '');
  if (p === FORM_PAGE || p === FORM_PAGE + '.html') return true;
  return p.startsWith(FORM_PAGE + '?') || p.startsWith(FORM_PAGE + '.html?');
}

/** Which of the form's buttons a session pressed, read off the button's own
    words in the click record: 'post', 'save' or ''. Post wins over Save. */
export function pressOf(clicks) {
  let out = '';
  for (const c of clicks || []) {
    const x = String((c && c.x) || '').trim();
    if (PRESS.post.test(x)) return 'post';
    if (PRESS.save.test(x)) out = 'save';
  }
  return out;
}

/** The signed-in accounts that opened the candidate form inside the window,
    one row per account, folded from the site's own usage record: how many
    sessions, the first and last instant, whether a button was pressed, how
    many distinct fields were touched, and the address the session carried.
    Anonymous sessions are not accounts and are dropped; what was typed was
    never recorded, so nothing here can say what the profile would have said. */
export function visitorsOf(sessions, w = OUTAGE) {
  const from = Date.parse(w.from), to = Date.parse(w.to);
  const by = new Map();
  for (const s of sessions || []) {
    if (!s || typeof s.uid !== 'string' || !s.uid || /^anon:/.test(s.uid)) continue;
    if (!onCandidateForm(s.page)) continue;
    const start = Number(s.start);
    if (!(start >= from && start <= to)) continue;
    const v = by.get(s.uid) || { uid: s.uid, kind: 'visit', email: '', sessions: 0, at: '', last: '',
      inOutage: true, pressed: '', presses: 0, touched: new Set(), dur: 0 };
    v.sessions++;
    const iso = new Date(start).toISOString();
    if (!v.at || iso < v.at) v.at = iso;
    const end = Number(s.last) >= start ? Number(s.last) : start;
    const lastIso = new Date(end).toISOString();
    if (!v.last || lastIso > v.last) v.last = lastIso;
    v.dur += Math.max(0, Number(s.dur) || 0);
    const p = pressOf(s.clicks);
    if (p) v.presses++;
    if (p === 'post' || (p && !v.pressed)) v.pressed = p;
    for (const f of s.fields || []) if (f && f.f) v.touched.add(String(f.f));
    if (!v.email && s.email) v.email = String(s.email).trim();
    by.set(s.uid, v);
  }
  return [...by.values()].map((v) => Object.assign(v, { touched: v.touched.size }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Counts over the orphans and the visits together. A person is counted once
    per step, since one account can be both a stranded CV and a visit. */
export function tally(rows) {
  const c = { orphans: 0, candidates: 0, jobs: 0, outage: 0, invite: 0,
    'came-back': 0, invited: 0, 'no-address': 0, 'outside-window': 0, 'job-advert': 0,
    visits: 0, pressed: 0, 'opened-only': 0, 'edit-refused': 0 };
  const seen = new Set();
  for (const r of rows) {
    if (r.kind === 'visit') {
      c.visits++;
      if (r.pressed === 'post') c.pressed++;
    } else {
      c.orphans++;
      c[r.kind === 'jobs' ? 'jobs' : 'candidates']++;
      if (r.inOutage) c.outage++;
    }
    const key = r.uid + '|' + r.step;
    if (r.step in c && !seen.has(key)) { c[r.step]++; seen.add(key); }
  }
  return c;
}

export function summarise(c) {
  return `${c.orphans} orphaned upload(s) on the landing strip (${c.candidates} CV(s), ${c.jobs} job advert(s)), ` +
    `${c.outage} from the outage window; ${c.visits} signed-in account(s) opened the candidate form during the outage ` +
    `and ${c.pressed} of them pressed Post my profile. Of the candidates turned away, by CV or by press: ` +
    `${c.invite} to invite, ${c.invited} already invited, ${c['came-back']} posted a profile since, ` +
    `${c['no-address']} with no address. Reported and left alone: ${c['opened-only']} opened the form without pressing, ` +
    `${c['edit-refused']} pressed Save changes on a profile they already had, ` +
    `${c['outside-window']} CV(s) orphaned outside the window, ${c['job-advert']} job advert(s).`;
}

const day = (iso) => (iso ? iso.slice(0, 10) : 'day unknown');

/** The maintainer's table: the ONE place the names and addresses go. */
export function renderReport({ rows, visits = [], counts, site = SITE }) {
  const cell = (v) => `<td style="padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;font-size:13px;">${esc(v || '')}</td>`;
  const th = (h) => `<th align="left" style="padding:6px 8px;border-bottom:2px solid #ddd;font-size:13px;">${esc(h)}</th>`;
  const table = (head, trs) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">` +
    `<tr>${head.map(th).join('')}</tr>\n${trs}</table>`;
  const head = ['Who', 'Affiliation', 'Address', 'Account', 'File', 'Uploaded', 'Kind', 'Next'];
  const trs = rows.map((r) =>
    `<tr>${cell(r.name || '(no name on the account)')}${cell(r.affiliation)}${cell(r.email || '(no address)')}` +
    `${cell(r.uid)}${cell(r.file)}${cell(day(r.at) + (r.inOutage ? ' (outage)' : ''))}${cell(r.kind)}${cell(r.step)}</tr>`).join('\n');
  const vhead = ['Who', 'Affiliation', 'Address', 'Account', 'Sessions', 'First', 'Last', 'Pressed', 'Fields touched', 'Next'];
  const pressed = (v) => (v.pressed === 'post' ? 'Post my profile' : v.pressed === 'save' ? 'Save changes' : 'nothing');
  const vtrs = visits.map((v) =>
    `<tr>${cell(v.name || '(no name on the account)')}${cell(v.affiliation)}${cell(v.email || '(no address)')}` +
    `${cell(v.uid)}${cell(String(v.sessions))}${cell(day(v.at))}${cell(day(v.last))}${cell(pressed(v))}` +
    `${cell(String(v.touched))}${cell(v.step)}</tr>`).join('\n');
  const bodyHtml =
    `<p>${esc(summarise(counts))}</p>` +
    `<h3 style="font-size:15px;margin:18px 0 6px;">Accounts that opened the candidate form during the outage</h3>` +
    `<p>From the site's own usage record: which page a signed-in account opened, when, which buttons it pressed and ` +
    `how many form fields it touched. What was typed was never recorded. An account that pressed Post my profile ` +
    `between 4 September and 17 September 2026, 20:58 UTC, and holds no profile for this season is a candidate ` +
    `the site refused.</p>` +
    (visits.length ? table(vhead, vtrs)
      : `<p>None: no signed-in account opened the form in the window.</p>`) +
    `<h3 style="font-size:15px;margin:18px 0 6px;">Uploads with no submission behind them</h3>` +
    `<p>These files sit on the Storage landing strip with no submission pointing at them. ` +
    `A candidate's CV from the outage window is a candidate whose profile was refused after the file had gone up.</p>` +
    (rows.length ? table(head, trs) : `<p>None.</p>`) +
    `<p style="font-size:13px;color:#666;">"invite" means the button's invite mode would write to them once; ` +
    `"came-back" means the account has posted a profile for this season since; "invited" means it already has been; ` +
    `"opened-only" and "edit-refused" are listed for your own judgement and are never written to. ` +
    `Nothing here can rebuild a refused profile: the refused write stored nothing.</p>`;
  const subject = `[OA] ${counts.invite + counts.invited + counts['came-back'] + counts['no-address']} candidate(s) turned away in September, ` +
    `${counts.visits} form visit(s), ${counts.orphans} stranded upload(s)`;
  const html = shell({ title: subject, bodyHtml, manageUrl: null });
  return { subject, html };
}

/** The invite: to the candidate, about their own submission and nothing
    else. No link to anything of theirs, no other person's data. */
export function renderInvite({ firstName = '', site = SITE, contact = CONTACT, cv = true } = {}) {
  const hello = firstName ? `Hello ${esc(firstName)},` : 'Hello,';
  const link = `${site.replace(/\/+$/, '')}/post-a-candidate`;
  const what = cv
    ? 'Your CV reached us, but the profile that goes with it did not, and nothing you typed was kept.'
    : 'You pressed Post my profile, the site refused it, and nothing you typed was kept.';
  const bodyHtml =
    `<p>${hello}</p>` +
    `<p>Between 4 and 17 September a fault on Operations Academia refused every candidate profile ` +
    `that was posted, and the page wrongly said the site was not accepting profiles yet. ` +
    `${what} We are sorry.</p>` +
    `<p>The fault is fixed. Could you post your profile once more? It takes a few minutes, the form ` +
    `now keeps a draft in your browser while you type, and a profile posted before the reveal date ` +
    `shown on the candidates page appears with everyone else's on that day.</p>` +
    `<p><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;background:#3B7DBC;color:#fff;` +
    `border-radius:4px;text-decoration:none;font-weight:600;">Post your candidacy</a></p>` +
    `<p style="font-size:13px;color:#666;">Or copy this address into your browser: ${esc(link)}</p>` +
    `<p>If you have posted it again already, please ignore this message. If anything is unclear, ` +
    `reply to this e-mail or write to <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>`;
  const subject = 'Your candidate profile did not reach Operations Academia. Please post it again';
  const html = shell({ title: subject, bodyHtml, manageUrl: null });
  return { subject, html };
}

/** The full table on stdout, for a LOCAL run only (see main). Kept out of
    log() so the selftest's rule over every log line stays honest. */
export function printTable(rows, visits = []) {
  const line = (r) => [r.uid, r.kind, day(r.at) + (r.inOutage ? '*' : ' '), r.step,
    r.name || '(no name)', r.affiliation || '', r.email || '(no address)', r.file].join('  |  ');
  process.stdout.write('uid | kind | day (*=outage) | next | name | affiliation | address | file\n');
  for (const r of rows) process.stdout.write(line(r) + '\n');
  const vline = (v) => [v.uid, 'visit', day(v.at) + '..' + day(v.last), v.step, v.name || '(no name)',
    v.affiliation || '', v.email || '(no address)', `${v.pressed || 'no press'}, ${v.sessions} session(s), ${v.touched} field(s)`].join('  |  ');
  process.stdout.write('uid | visit | first..last | next | name | affiliation | address | what they did\n');
  for (const v of visits) process.stdout.write(vline(v) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------- main */

async function main() {
  /* THE TABLE NEVER REACHES A PUBLIC LOG: --print is for a checkout on the
     maintainer's own machine and is refused before anything is read. */
  if (PRINT && (process.env.GITHUB_ACTIONS || process.env.CI)) {
    log('::error::--print is refused on a runner: the table carries names, and this log is public. Use --report.');
    return 1;
  }
  const fb = await firebaseAdmin();
  if (!fb) {
    log('no Firebase credentials in this environment: nothing to do.');
    log('(this is the expected state until the project is set up: _SETUP-FIREBASE.md)');
    return 0;
  }
  let bucket = null;
  try {
    const admin = await import('firebase-admin');
    const app = admin.default || admin;
    bucket = app.storage().bucket(BUCKET);
  } catch {
    warn('Storage is unavailable: the landing strip could not be listed.');
    return 0;
  }
  const tx = (REPORT || INVITE) && !DRY ? await transport() : null;
  if ((REPORT || INVITE) && !DRY && !tx) {
    warn('SMTP is not configured: nothing can be sent. Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS and press again.');
    return 0;
  }

  /* 1. the strip */
  const [files] = await bucket.getFiles({ prefix: 'uploads/' });

  /* 2. what a document points at, and who has a profile this season */
  const referenced = new Set();
  const profiled = new Set();
  const year = marketYear(new Date());
  for (const [kind, spec] of Object.entries(KINDS)) {
    const snap = await fb.db.collection(spec.collection).get();
    snap.forEach((d) => {
      const v = d.data() || {};
      for (const k of spec.paths) if (typeof v[k] === 'string' && v[k]) referenced.add(v[k]);
      if (kind === 'candidates' && LIVE.includes(v.status) && Number(v.year) === year && v.uid) {
        profiled.add(String(v.uid));
      }
    });
  }
  const rows = orphans(files, referenced);

  /* 2b. the usage record: the signed-in accounts that opened the candidate
     form inside the window (the header says why this is the better list).
     A read that fails costs this half of the list and never the other. */
  let visits = [];
  const sessionAddress = new Map();
  try {
    const from = Date.parse(OUTAGE.from), to = Date.parse(OUTAGE.to);
    const sessions = [];
    let after = null;
    for (;;) {
      let q = fb.db.collection('usageSessions').where('start', '>=', from).where('start', '<=', to)
        .orderBy('start').limit(SESSION_PAGE);
      if (after) q = q.startAfter(after);
      const snap = await q.get();
      snap.forEach((d) => sessions.push(d.data() || {}));
      if (snap.size < SESSION_PAGE) break;
      after = snap.docs[snap.docs.length - 1];
    }
    visits = visitorsOf(sessions);
    for (const v of visits) if (v.email) sessionAddress.set(v.uid, v.email);
    log(`${sessions.length} usage session(s) in the window, ${visits.length} signed-in account(s) on the candidate form`);
  } catch (e) {
    warn(`the usage record could not be read (${e.code || 'error'}); the form's visitors are not listed this run`);
  }

  /* 3. who each orphan and each visitor is: the profile's name first, then
     the roster row, then Auth's; the sign-in address first, then the typed
     one, then the address the session itself carried */
  const invited = new Set();
  const people = new Map();
  for (const uid of new Set([...rows.map((r) => r.uid), ...visits.map((v) => v.uid)])) {
    const who = { name: '', first: '', affiliation: '', email: '' };
    try {
      const u = await fb.auth.getUser(uid);
      who.email = String(u.email || '').trim();
      who.name = String(u.displayName || '').trim();
    } catch { /* an account that has gone: the row keeps its uid */ }
    try {
      const p = (await fb.db.collection('profiles').doc(uid).get()).data() || {};
      const n = [p.firstName, p.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
      if (n) who.name = n;
      who.first = String(p.firstName || '').trim();
      if (p.affiliation) who.affiliation = String(p.affiliation).trim();
      if (!who.email && p.contactEmail) who.email = String(p.contactEmail).trim();
    } catch { /* no profile */ }
    try {
      const r = (await fb.db.collection('userDirectory').doc(uid).get()).data() || {};
      if (!who.name && r.name) who.name = String(r.name).trim();
      if (!who.affiliation && r.affiliation) who.affiliation = String(r.affiliation).trim();
      if (!who.email && r.email) who.email = String(r.email).trim();
    } catch { /* no roster row */ }
    if (!who.email && sessionAddress.get(uid)) who.email = sessionAddress.get(uid);
    try {
      const m = (await fb.db.collection(INVITES).doc(uid).get()).data() || {};
      if (m[INVITED_AT]) invited.add(uid);
    } catch { /* never invited */ }
    people.set(uid, who);
  }
  const ctx = { profiled, invited };
  const all = [...rows, ...visits];
  for (const r of all) {
    Object.assign(r, people.get(r.uid));
    r.step = nextStep(r, ctx);
  }
  const counts = tally(all);
  log(summarise(counts));
  for (const r of rows) {
    log(`  ${r.uid}  ${r.kind}  ${redact(r.email)}  ${day(r.at)}  ${r.inOutage ? 'outage' : 'other'}  ${r.step}`);
  }
  for (const v of visits) {
    log(`  ${v.uid}  visit  ${redact(v.email)}  ${day(v.at)}..${day(v.last)}  ${v.pressed || 'no press'}  ${v.sessions} session(s)  ${v.step}`);
  }
  if (PRINT) printTable(rows, visits);

  if (REPORT) {
    const msg = renderReport({ rows, visits, counts });
    let ok = false;
    try {
      ok = await send(tx, { to: ADMIN, subject: msg.subject, html: msg.html }, { dryRun: DRY });
    } catch (e) {
      warn(`the report could not be sent to ${redact(ADMIN)} (${e.code || e.responseCode || 'error'})`);
    }
    log(`report ${ok ? 'sent' : 'not sent'} to ${redact(ADMIN)}: ${rows.length} upload row(s), ${visits.length} visit row(s)`);
  }

  if (INVITE) {
    const seen = new Set();
    const queue = all.filter((r) => r.step === 'invite' && !seen.has(r.uid) && seen.add(r.uid));
    if (DRY) {
      for (const r of queue) log(`  would invite: ${r.uid}  ${redact(r.email)}  (${r.kind === 'visit' ? 'pressed Post on' : 'CV of'} ${day(r.at)})`);
      log(`--dry-run: ${queue.length} invite(s) would go out. Nothing sent, nothing written.`);
    } else {
      let sent = 0, failed = 0, unstamped = 0;
      for (const r of queue) {
        const msg = renderInvite({ firstName: r.first, cv: r.kind === 'candidates' });
        let ok = false;
        try {
          ok = await send(tx, { to: r.email, subject: msg.subject, html: msg.html });
        } catch (e) {
          failed++;
          warn(`${r.uid}: not sent to ${redact(r.email)} (${e.code || e.responseCode || 'error'})`);
        }
        if (ok) {
          /* stamped ONLY after the transport took the message; a stamp that
             fails is warned about by id and the queue carries on */
          sent++;
          try {
            await fb.db.collection(INVITES).doc(r.uid)
              .set({ [INVITED_AT]: new Date().toISOString(), path: r.path }, { merge: true });
            invited.add(r.uid);
            log(`  invited: ${r.uid}  ${redact(r.email)}`);
          } catch (e) {
            unstamped++;
            warn(`${r.uid}: invited, but the once-only mark could not be written (${e.code || 'error'}); ` +
                 'this account may be written to again on the next press');
          }
        }
        await sleep(PACE_MS);
      }
      log(`${sent} invite(s) sent (${sent - unstamped} stamped, ${unstamped} sent but NOT stamped), ${failed} failed.`);
    }
  }

  if (CLEAN) {
    let gone = 0, kept = 0;
    for (const r of rows) {
      if (!cleanable(r, ctx)) { kept++; continue; }
      if (DRY) {
        log(`  would delete: ${r.uid}  ${day(r.at)}  ${r.step}`);
        gone++;
        continue;
      }
      try {
        await bucket.file(r.path).delete();
        gone++;
        log(`  deleted: ${r.uid}  ${day(r.at)}  ${r.step}`);
      } catch (e) {
        kept++;
        warn(`${r.uid}: the orphan could not be deleted (${e.code || 'error'})`);
      }
    }
    log(`${DRY ? '--dry-run: ' : ''}${gone} orphan(s) ${DRY ? 'would be ' : ''}deleted, ${kept} left where they are.`);
  }
  return 0;
}

/* ---------------------------------------------------------------- selftest */

async function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };
  const eq = (got, want, what) => ok(JSON.stringify(got) === JSON.stringify(want),
    `${what}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  const noDash = (s) => !/\u2014/.test(String(s));

  /* --- the path ----------------------------------------------------------- */
  eq(parseUploadPath('uploads/abc123/candidates/1757500000000-Jane-Smith-CV.pdf'),
    { uid: 'abc123', kind: 'candidates', stamp: 1757500000000, name: 'Jane-Smith-CV.pdf' },
    'a candidate upload path is read into its parts');
  eq(parseUploadPath('uploads/u9/jobs/1757500000001-advert.docx').kind, 'jobs', 'and a job advert too');
  eq(parseUploadPath('uploads/u9/other/1-x.pdf'), null, 'a kind the forms never write is not an upload');
  eq(parseUploadPath('uploads/u9/candidates/nostamp.pdf'), null, 'nor is a name without the millisecond prefix');
  eq(parseUploadPath('cvs/u9/x.pdf'), null, 'nor anything outside uploads/');

  /* --- when ------------------------------------------------------------------ */
  eq(whenOf({ name: 'uploads/u/candidates/1757500000000-a.pdf', metadata: { timeCreated: '2026-09-10T09:00:00.000Z' } }),
    '2026-09-10T09:00:00.000Z', 'Storage\'s own stamp wins');
  eq(whenOf({ name: 'uploads/u/candidates/1757500000000-a.pdf' }), new Date(1757500000000).toISOString(),
    'and the millisecond prefix stands in when there is none');
  eq(whenOf({ name: 'not/an/upload' }), '', 'and nothing is nothing');
  ok(inWindow('2026-09-04T00:00:00.000Z') && inWindow('2026-09-17T20:58:35.000Z'),
    'the outage window is inclusive at both ends');
  ok(!inWindow('2026-09-03T23:59:59.999Z') && !inWindow('2026-09-17T20:58:36.000Z') && !inWindow(''),
    'and excludes the moment before and the moment after');

  /* --- the orphans ----------------------------------------------------------- */
  const files = [
    { name: 'uploads/u1/candidates/1757500000000-jane.pdf', metadata: { timeCreated: '2026-09-10T09:00:00.000Z' } },
    { name: 'uploads/u2/candidates/1757600000000-bob.pdf', metadata: { timeCreated: '2026-09-11T09:00:00.000Z' } },
    { name: 'uploads/u3/candidates/1755000000000-old.pdf', metadata: { timeCreated: '2026-08-12T09:00:00.000Z' } },
    { name: 'uploads/u4/jobs/1757700000000-ad.pdf', metadata: { timeCreated: '2026-09-12T09:00:00.000Z' } },
    { name: 'uploads/u5/candidates/1757800000000-pending.pdf', metadata: { timeCreated: '2026-09-13T09:00:00.000Z' } },
    { name: 'uploads/junk.txt' },
  ];
  const referenced = new Set(['uploads/u5/candidates/1757800000000-pending.pdf']);
  const rows = orphans(files, referenced);
  eq(rows.map((r) => r.uid), ['u3', 'u1', 'u2', 'u4'], 'a referenced upload is not an orphan, junk is ignored, oldest first');
  eq(rows.map((r) => r.inOutage), [false, true, true, true], 'each carries whether it fell in the outage');
  eq(rows[1].file, 'jane.pdf', 'and the filename, which the report shows and the log never does');

  /* --- what happens next ----------------------------------------------------- */
  const ctx = { profiled: new Set(['u2']), invited: new Set(['u6']) };
  const row = (over) => Object.assign({ kind: 'candidates', inOutage: true, uid: 'u1', email: 'a@b.edu' }, over);
  eq(nextStep(row({}), ctx), 'invite', 'a turned-away candidate with no profile and an address is invited');
  eq(nextStep(row({ uid: 'u2' }), ctx), 'came-back', 'one who has posted a profile since is not');
  eq(nextStep(row({ uid: 'u6' }), ctx), 'invited', 'nor one already invited');
  eq(nextStep(row({ email: '' }), ctx), 'no-address', 'nor one with no address to write to');
  eq(nextStep(row({ inOutage: false }), ctx), 'outside-window', 'a CV orphaned outside the window is only reported');
  eq(nextStep(row({ kind: 'jobs' }), ctx), 'job-advert', 'and so is a job advert');
  ok(cleanable(row({ uid: 'u2' }), ctx) && cleanable(row({ uid: 'u6' }), ctx),
    'an orphan is cleanable once its account has posted or been invited');
  ok(!cleanable(row({}), ctx) && !cleanable(row({ uid: 'u2', inOutage: false }), ctx) && !cleanable(row({ uid: 'u2', kind: 'jobs' }), ctx),
    'and never before, nor outside the window, nor a job advert');

  /* --- the tally and its sentence ------------------------------------------ */
  const tallied = rows.map((r) => Object.assign(r, { email: r.uid === 'u1' ? 'j@x.edu' : '', step: null }));
  for (const r of tallied) r.step = nextStep(r, ctx);
  const counts = tally(tallied);
  eq([counts.orphans, counts.candidates, counts.jobs, counts.outage, counts.invite, counts['came-back'], counts['outside-window'], counts['job-advert']],
    [4, 3, 1, 3, 1, 1, 1, 1], 'the tally counts every kind of orphan');
  ok(/4 orphaned upload\(s\)/.test(summarise(counts)) && /1 to invite/.test(summarise(counts)) && noDash(summarise(counts)),
    'and the sentence says so, with no em dash');

  /* --- the report: the one place the names go -------------------------------- */
  const rep = renderReport({ rows: [Object.assign(row({ name: 'Jane <b>Smith</b>', affiliation: 'Somewhere U', file: 'Jane-Smith-CV.pdf',
    at: '2026-09-10T09:00:00.000Z', step: 'invite' }))], counts, site: 'https://x.test' });
  ok(/Jane &lt;b&gt;Smith&lt;\/b&gt;/.test(rep.html) && /a@b\.edu/.test(rep.html) && /Jane-Smith-CV\.pdf/.test(rep.html),
    'the report carries the name, the address and the file, every value escaped');
  ok(/candidate\(s\) turned away in September/.test(rep.subject) && noDash(rep.subject) && noDash(rep.html),
    'and a subject that says what it is, with no em dash');

  /* --- the invite: about their own submission and nothing else --------------- */
  const inv = renderInvite({ firstName: 'Jane <i>', site: 'https://x.test/', contact: 'help@x.test' });
  ok(/Hello Jane &lt;i&gt;,/.test(inv.html), 'the invite greets by first name, escaped');
  ok(/https:\/\/x\.test\/post-a-candidate/.test(inv.html) && !/x\.test\/\/post/.test(inv.html),
    'and links the posting page, the trailing slash folded');
  /* shell() adds the site's own contact address in its footer; that one and the
     contact handed in are the only two the message may carry. */
  const noContact = inv.html.replace(/help@x\.test/g, '').split(CONTACT).join('');
  ok(!/@/.test(noContact) && /help@x\.test/.test(inv.html), 'and carries no address but the contact one');
  ok(/refused every candidate profile/.test(inv.html) && /We are sorry/.test(inv.html) && /keeps a draft/.test(inv.html),
    'says what happened, apologises, and says the form now keeps a draft');
  ok(!/\d{4}-\d{2}-\d{2}/.test(inv.html) && /reveal date shown on the candidates page/.test(inv.html),
    'and types no reveal date: the page states it, this message points there');
  ok(noDash(inv.subject) && noDash(inv.html), 'no em dash in the invite');
  ok(/Hello,/.test(renderInvite({}).html), 'and a missing first name is a bare hello');
  ok(/Your CV reached us/.test(inv.html) && !/You pressed Post my profile/.test(inv.html),
    'by default the invite is about the CV that reached us');
  const inv2 = renderInvite({ firstName: 'J', cv: false, contact: 'help@x.test' });
  ok(/You pressed Post my profile, the site refused it/.test(inv2.html) && !/Your CV reached us/.test(inv2.html)
     && /post-a-candidate/.test(inv2.html) && noDash(inv2.html),
    'and for a visitor it is about the press, with no CV claimed');

  /* --- the usage record: who opened the form, and who pressed ---------------- */
  const S = (o) => Object.assign({ uid: 'v1', email: 'v@x.edu', page: '/post-a-candidate', start: Date.parse('2026-09-10T10:00:00Z'),
    last: Date.parse('2026-09-10T10:14:00Z'), dur: 840, clicks: [], fields: [] }, o);
  ok(onCandidateForm('/post-a-candidate') && onCandidateForm('/post-a-candidate.html') && onCandidateForm('/post-a-candidate?edit=x')
     && onCandidateForm('/post-a-candidate.html?edit=x') && !onCandidateForm('/post-a-job') && !onCandidateForm('/post-a-candidates')
     && !onCandidateForm('') && !onCandidateForm(null),
    'the form is recognised with or without .html and a query, and nothing else is');
  eq([pressOf([{ x: 'Post my profile' }]), pressOf([{ x: 'Save changes' }]), pressOf([{ x: 'Sign in' }]), pressOf(undefined),
    pressOf([{ x: 'Save changes' }, { x: ' post my profile ' }]), pressOf([null, {}])], ['post', 'save', '', '', 'post', ''],
    'the press is read off the button\'s own words, and Post wins over Save');
  const vis = visitorsOf([
    S({ clicks: [{ x: 'Post my profile' }], fields: [{ f: 'first' }, { f: 'last' }, { f: 'first' }] }),
    S({ start: Date.parse('2026-09-12T08:00:00Z'), last: Date.parse('2026-09-12T08:05:00Z'), dur: 300, fields: [{ f: 'cvUrl' }] }),
    S({ uid: 'v2', email: 'w@x.edu', page: '/post-a-candidate.html', start: Date.parse('2026-09-04T00:00:00Z'),
      last: 0, clicks: [{ x: 'Post my profile' }] }),
    S({ uid: 'v3', email: '', page: '/post-a-candidate?edit=abc', clicks: [{ x: 'Save changes' }], start: Date.parse('2026-09-17T20:58:35Z') }),
    S({ uid: 'anon:abc', clicks: [{ x: 'Post my profile' }] }),
    S({ uid: 'v4', page: '/jobs', clicks: [{ x: 'Post my profile' }] }),
    S({ uid: 'v5', start: Date.parse('2026-09-03T23:59:59Z') }),
    S({ uid: 'v6', start: Date.parse('2026-09-17T20:58:36Z') }),
    S({ uid: '', clicks: [{ x: 'Post my profile' }] }),
    null,
  ]);
  eq(vis.map((v) => v.uid), ['v2', 'v1', 'v3'],
    'one row per signed-in account on the form inside the window, oldest first; anonymous, other pages and both edges out');
  const v1 = vis.find((v) => v.uid === 'v1');
  eq([v1.sessions, v1.pressed, v1.presses, v1.touched, v1.dur, v1.at, v1.last, v1.email],
    [2, 'post', 1, 3, 1140, '2026-09-10T10:00:00.000Z', '2026-09-12T08:05:00.000Z', 'v@x.edu'],
    'its sessions are folded: the count, the press, the distinct fields, the dwell, the first and last instants, the address');
  eq([vis[0].last, vis[2].pressed, vis[2].email], ['2026-09-04T00:00:00.000Z', 'save', ''],
    'a last stamp before the start is the start; an edit press is told apart; no address is no address');
  ok(vis.every((v) => v.kind === 'visit' && v.inOutage === true), 'and every row is a visit inside the outage');
  const vctx = { profiled: new Set(['v2']), invited: new Set(['v9']) };
  eq([nextStep(v1, vctx), nextStep(vis[0], vctx), nextStep(vis[2], vctx),
    nextStep(Object.assign({}, v1, { pressed: '' }), vctx), nextStep(Object.assign({}, v1, { email: '' }), vctx),
    nextStep(Object.assign({}, v1, { uid: 'v9' }), vctx)],
  ['invite', 'came-back', 'edit-refused', 'opened-only', 'no-address', 'invited'],
  'a press with no profile since is invited; a profile since is came-back; a Save press, no press and no address are reported only');
  const both = [...vis.map((v) => Object.assign({}, v, { step: nextStep(v, vctx) })), ...tallied];
  const vcounts = tally(both);
  eq([vcounts.visits, vcounts.pressed, vcounts['edit-refused'], vcounts['opened-only'], vcounts.invite, vcounts['came-back'], vcounts.orphans],
    [3, 2, 1, 0, 2, 2, 4], 'the tally counts the visits apart from the orphans');
  eq(tally([Object.assign({}, v1, { step: 'invite' }), Object.assign({}, v1, { kind: 'candidates', step: 'invite', inOutage: true })]).invite, 1,
    'and a person who is both a stranded CV and a visit is counted once');
  ok(/3 signed-in account\(s\) opened the candidate form/.test(summarise(vcounts)) && /2 of them pressed Post my profile/.test(summarise(vcounts))
     && noDash(summarise(vcounts)), 'and the sentence says so');
  const vrep = renderReport({ rows: [], visits: [Object.assign({}, v1, { name: 'Vee <b>', affiliation: 'A U', step: 'invite' })],
    counts: vcounts, site: 'https://x.test' });
  ok(/Vee &lt;b&gt;/.test(vrep.html) && /v@x\.edu/.test(vrep.html) && /Post my profile/.test(vrep.html)
     && /Accounts that opened the candidate form during the outage/.test(vrep.html) && /What was typed was never recorded/.test(vrep.html),
    'the report carries the visitors in a table of their own, every value escaped');
  ok(/None: no signed-in account opened the form/.test(renderReport({ rows: [], visits: [], counts: vcounts }).html),
    'and says so when there were none');
  ok(/3 form visit\(s\)/.test(vrep.subject) && noDash(vrep.subject) && noDash(vrep.html), 'the subject counts the visits');

  /* --- the file's own source: the guards that keep the log clean ------------ */
  const src = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const mainAt = src.indexOf('async function main()');
  const mainEnd = src.indexOf('/* ---------------------------------------------------------------- selftest */');
  ok(mainAt > 0 && mainEnd > mainAt, 'main() was found');
  const body = src.slice(mainAt, mainEnd);
  ok(body.length > 3000, 'and is the right size, or the checks below are vacuous');
  const printAt = body.indexOf("if (PRINT && (process.env.GITHUB_ACTIONS || process.env.CI))");
  ok(printAt > 0 && printAt < body.indexOf('await firebaseAdmin()'),
    '--print is refused on a runner before anything is read');
  ok(/if \(PRINT\) printTable\(rows, visits\);/.test(body) && (body.match(/printTable\(/g) || []).length === 1,
    'and the table reaches stdout through printTable() alone, never through log()');
  const readAt = body.indexOf("collection('usageSessions')");
  const tryAt = body.lastIndexOf('try {', readAt);
  ok(readAt > 0 && tryAt > 0 && /where\('start', '>=', from\)\.where\('start', '<=', to\)/.test(body)
     && body.indexOf('visits = visitorsOf(sessions);') > readAt && body.indexOf('} catch (e) {', readAt) > readAt,
    'the usage record is read bounded by the window at both ends, inside a try, and folded through visitorsOf()');
  ok(/renderReport\(\{ rows, visits, counts \}\)/.test(body) && /cv: r\.kind === 'candidates'/.test(body)
     && /const all = \[\.\.\.rows, \.\.\.visits\];/.test(body) && /all\.filter\(\(r\) => r\.step === 'invite'/.test(body),
    'the report, the invite queue and the invite\'s wording all see the visits');
  /* Every log and warning line in main(): a uid, a day, a step, a count, or an
     address through redact(), and never a name, a filename, an affiliation or
     an error's message text. */
  const calls = body.match(/\b(log|warn)\(([\s\S]*?)\);\n/g) || [];
  ok(calls.length >= 12, `the log lines were really found (${calls.length})`);
  const bare = (l) => l.replace(/redact\([^)]*\)/g, '');
  ok(calls.every((l) => !/\.name\b/.test(bare(l)) && !/\.file\b/.test(bare(l)) && !/\.affiliation\b/.test(bare(l))
      && !/\.first\b/.test(bare(l)) && !/\.email\b/.test(bare(l)) && !/\bemail\b/.test(bare(l))
      && !/e\.message/.test(l) && !/msg\.(html|subject)/.test(l) && !/\.path\b/.test(bare(l))),
    'no log line names a person, a file, an address (redact() only), a path or an error\'s message text');
  ok(calls.some((l) => /redact\(r\.email\)/.test(l)) && calls.some((l) => /redact\(ADMIN\)/.test(l)),
    'and the redact exemption is exercised, so the check is not vacuous');
  const sendAt = body.indexOf('ok = await send(tx, { to: r.email');
  const stampAt = body.indexOf('.set({ [INVITED_AT]:');
  const ifOk = body.indexOf('if (ok) {', sendAt);
  ok(sendAt > 0 && stampAt > sendAt && ifOk > sendAt && ifOk < stampAt,
    'invitedAt is written AFTER send() and only inside the branch where it returned true');
  ok((body.match(/await send\(tx/g) || []).length === 2
     && body.indexOf('if (REPORT) {') < body.indexOf('await send(tx, { to: ADMIN')
     && body.indexOf('if (INVITE) {') < sendAt,
    'exactly two sends, one under --report and one under --invite; a bare scan sends nothing');
  ok(/if \(!cleanable\(r, ctx\)\) \{ kept\+\+; continue; \}/.test(body) && (body.match(/\.delete\(\)/g) || []).length === 1,
    'the one delete is behind cleanable(), so an orphan whose owner has not been invited is never destroyed');
  ok(/r\.step === 'invite'/.test(body), 'the invite queue is exactly the rows nextStep() said to invite');
  ok(/await sleep\(PACE_MS\)/.test(body) && PACE_MS === 1000, 'one message a second');
  const tail = src.slice(src.lastIndexOf('main().then('));
  ok(tail.length > 100 && tail.length < 800 && !/e\.message/.test(tail),
    'the top-level catch prints an error\'s code, never its message text');

  console.log(fails.length
    ? `stranded-cvs selftest: ${fails.length} FAILED, ${pass} passed\n\n  ${fails.join('\n  ')}`
    : `stranded-cvs selftest: ${pass} checks passed`);
  return fails.length === 0;
}

if (!isMain(import.meta.url)) {
  // imported: the pure halves above are the whole of it
} else if (has('--selftest')) {
  process.exit((await selftest()) ? 0 : 1);
} else {
  main().then((code) => process.exit(code)).catch((e) => {
    /* the code, never the message text: a public log, and an error's message
       can quote an address or a document path in full */
    console.log('::error::the stranded-uploads scan failed: ' + (e.code || e.name || 'error'));
    process.exit(1);
  });
}
