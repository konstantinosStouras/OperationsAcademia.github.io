#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — send the e-mail alerts that are due.

   Reads every subscription (a collectionGroup query over users/{uid}/alerts),
   works out what is new for each one since it last sent, and e-mails it.

   Matching uses assets/oa-alert-match.js — the SAME file the alerts page loads
   in the browser — so the preview a subscriber saw when they created the alert
   and the e-mail they receive cannot disagree.

   HIGH-WATER MARKS. Each alert carries its own `lastSentAt`, advanced ONLY
   when its send succeeds. A transient SMTP failure therefore retries that one
   alert next run rather than skipping the window, and a run that dies halfway
   does not silently swallow a day of postings for everybody after it.

   CLOSING THIS WEEK (owner, 2026-09-04). The deadlines topic reminds a
   subscriber of the postings matching their filters whose final or suggested
   apply-by date falls within the next seven days (closingSoonFor in
   assets/oa-alert-match.js). Its mark is `lastDeadlineUntil` — the END of the
   window the alert was last checked against, written when a digest was
   delivered and on the idle branch, and never a wall clock: the next window
   only announces dates after it, so a closing date is named once and a run
   that could not send re-checks the same window rather than losing it.

   CANDIDATES (owner, 2026-08-23). The candidates topic reads ONE source:
   data/candidates.json — the file build-candidates.mjs leaves EMPTY until the
   admin's reveal date, so a profile the site is not showing cannot reach an
   inbox by construction; this mailer never looks at candidateSubmissions.
   The first candidate e-mail any alert receives is a single short "the
   profiles are now live" note (never a listing — on the reveal day weeks of
   profiles appear at once, and eighty separate mentions is the bombardment
   the owner asked to avoid); after it, each new public profile is listed in
   the alert's normal digest. The per-alert mark is `lastCandidateAt`, and
   candidateNews() in assets/oa-alert-match.js is the whole decision.

   Modes:
     --dry-run    match and render, send nothing, print each message
     --scan       report the subscriptions and what each would send
     --selftest   offline checks of the matcher and the renderers
   --------------------------------------------------------------------------- */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  shell, esc, safeUrl, headerSafe, send, transport, firestore, unsubHeaders, SITE, toPlain,
} from './_mail.mjs';
import { longDate } from './jobs-model.mjs';
/* WHICH PAGE a posting is on, and the link that opens THAT one — the same
   `livePostingUrl` the poster's own "your posting is live" e-mail uses, which
   asks assets/oa-jobnav.js. A posting whose season has rolled lives on
   Previous markets, and a link to the jobs page would open a list that cannot
   contain it. */
import { livePostingUrl } from './submissions-mailer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// the one matcher, shared with the browser
const M = require(path.join(HERE, '..', 'assets', 'oa-alert-match.js'));
// and the one answer to "may this update be shown to anyone yet?", shared with
// the two What's-new lists and the alert preview — see the header of that file
const News = require(path.join(HERE, '..', 'assets', 'oa-news.js'));

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const SCAN = argv.has('--scan');

const MANAGE_URL = `${SITE}/alerts`;

/** The link that actually stops these e-mails. It carries the alert id and the
    owning account, because the alerts page must find the subscription without
    the reader having to work out which of theirs it was. */
function unsubscribeUrl(a) {
  return `${MANAGE_URL}?unsubscribe=${encodeURIComponent(a.id)}` +
    (a.uid ? `&u=${encodeURIComponent(a.uid)}` : '');
}
const MAX_ROWS = 60;          // an e-mail listing more than this is unreadable

/** yyyy-mm-dd, the day before the one given. '' for anything unparseable. */
function dayBefore(iso) {
  const t = Date.parse(String(iso || '') + 'T00:00:00Z');
  return Number.isNaN(t) ? '' : new Date(t - 86400000).toISOString().slice(0, 10);
}

/**
 * The last day an update digest may reach: today, or the day before the oldest
 * entry still waiting for review, whichever is earlier.
 *
 * Pure, because it is the one piece of the review gate that decides whether an
 * announcement is DELAYED or LOST. The per-alert window is a high-water mark on
 * the DATE of the newest entry sent, so an entry sent from after an unreviewed
 * one would move that mark past it — and the older entry, once published, would
 * then be behind every subscriber's window and reach nobody, with nothing
 * anywhere to say so. Stopping short delays instead: publish or remove the one
 * that is waiting and the rest go out on the next run, in the order they were
 * written.
 *
 * A REMOVED entry deliberately does not hold the stream — removing one is a
 * decision, not a pause, and it is one of the two ways to release the hold. The
 * consequence, stated rather than hidden: an entry removed and later RESTORED
 * goes back on the site but is not re-announced, its date being behind the
 * windows that moved on meanwhile. That is the right way round — many
 * subscribers will already have been e-mailed it before it came down, and
 * nothing here can tell which, so silence beats sending some of them a
 * duplicate.
 */
function updateWindowEnd(today, oldestPending) {
  const before = dayBefore(oldestPending);
  return before && before < today ? before : today;
}

/** The subscriber's address, for the run log. Actions logs of a public
    repository are world-readable, so a subscription list must not be printed
    into one in full. */
function redact(email) {
  const m = String(email || '').match(/^([^@]{1,2})[^@]*(@.*)$/);
  return m ? `${m[1]}***${m[2]}` : (email ? '***' : 'no address');
}

/* --------------------------------------------------------------- rendering */

function jobHtml(r) {
  // Every field here is submitted through the posting form, so each part is
  // escaped BEFORE the separators are joined in — the separator is the only
  // markup in this string. (Escaping the joined result would eat the &middot;.)
  const meta = [
    (r.levels || []).join(', '),
    r.country,
    // the suggested (first-review) date, where the posting names one — keep
    // the wording in step with the alerts page's preview (oa-alerts.js)
    r.reviewDate ? `suggested apply by ${longDate(r.reviewDate)}` : '',
    r.applyBy ? `final apply by ${r.applyBy}` : '',
  ].filter(Boolean).map(esc).join(' &middot; ');

  const posted = safeUrl(r.postedAtUrl), ad = safeUrl(r.adUrl);
  const links = [
    posted ? `<a href="${esc(posted)}">official advertisement</a>` : '',
    ad ? `<a href="${esc(ad)}">job ad (PDF)</a>` : '',
  ].filter(Boolean).join(' &middot; ');

  return `<li style="margin-bottom:14px;">
    <strong style="font-size:16px;">${esc(r.institution)}</strong><br>
    <span style="color:rgba(0,0,0,.6);">${esc(r.department)}</span><br>
    <span style="color:#666;font-size:13px;">${meta}</span>
    ${links ? `<br><span style="font-size:13px;">${links}</span>` : ''}
  </li>`;
}

/** One candidate profile, as a list item. Every field is submitted through
    the profile form, so each part is escaped before the separators join it,
    and every link goes through safeUrl — a profile reaches an inbox
    unreviewed, exactly like a posting. */
function candidateHtml(r) {
  const meta = [r.position, r.affiliation].filter(Boolean).map(esc).join(' &middot; ');
  const areas = (r.researchAreas || []).map(esc).join(', ');

  const cv = safeUrl(r.cvUrl), rs = safeUrl(r.rsUrl), web = safeUrl(r.webUrl);
  const links = [
    cv ? `<a href="${esc(cv)}">CV</a>` : '',
    rs ? `<a href="${esc(rs)}">research summary</a>` : '',
    web ? `<a href="${esc(web)}">website</a>` : '',
  ].filter(Boolean).join(' &middot; ');

  return `<li style="margin-bottom:14px;">
    <strong style="font-size:16px;">${esc(r.name)}</strong><br>
    <span style="color:rgba(0,0,0,.6);">${meta}</span>
    ${areas ? `<br><span style="color:#666;font-size:13px;">${areas}</span>` : ''}
    ${links ? `<br><span style="font-size:13px;">${links}</span>` : ''}
  </li>`;
}

/** One posting about to close, as a list item: the institution, the
    department, WHICH date it is and the date, and the posting's own
    permalink. Every field is submitted through a form, so each part is
    escaped before it is joined in. */
function closingHtml(e, now) {
  const r = e.row || {};
  const when = (e.kind === 'suggested' ? 'Suggested apply by ' : 'Final apply by ') +
    longDate(e.date);
  const href = livePostingUrl(r, { now });
  return `<li style="margin-bottom:14px;">
    <strong style="font-size:16px;">${esc(r.institution)}</strong><br>
    <span style="color:rgba(0,0,0,.6);">${esc(r.department)}</span><br>
    <span style="color:#666;font-size:13px;">${esc(when)} &middot;
      <a href="${esc(href)}">Open the posting</a></span>
  </li>`;
}

/**
 * The one-off "the candidate profiles are now live" note — the FIRST candidate
 * e-mail every subscriber gets, sent instead of a listing (see the header).
 * Written to read like a person wrote it, short and friendly, and with no
 * em-dashes anywhere (both by the owner's instruction); the selftest pins the
 * last one, because an em-dash is exactly what a later edit would add without
 * thinking.
 */
export function renderCandidatesLiveEmail({ alert, count }) {
  const who = count === 1
    ? 'The first candidate has already shared their profile'
    : `${count} candidates have already shared their profiles`;

  const body = `
    <p style="margin:0 0 14px;">Hello,</p>
    <p style="margin:0 0 14px;">Good news: the candidate profiles for this year's
      Operations job market are now live on Operations Academia. ${esc(who)}, with
      their research areas, their CVs and the INFORMS days they will be around.</p>
    <p style="margin:24px 0;">
      <a href="${esc(SITE)}/#candidates" style="display:inline-block;background:#3B7DBC;color:#fff;
         padding:9px 18px;border-radius:3px;text-decoration:none;font-weight:600;">
         Meet the candidates</a></p>
    <p style="margin:0 0 14px;">More profiles will keep arriving as the season goes on.
      You asked us to tell you about candidates, so whenever someone new posts a
      profile we will send you a short note about them.</p>
    <p style="margin:0;">Happy reading,<br>The Operations Academia team</p>`;

  return shell({
    title: alert.name || 'Operations Academia',
    bodyHtml: body,
    manageUrl: MANAGE_URL,
    unsubUrl: unsubscribeUrl(alert),
  });
}

export function renderAlertEmail({ alert, jobs, updates, candidates = [], closing = [],
  now = new Date() }) {
  const parts = [];
  const n = jobs.length;

  if (n) {
    parts.push(`<p style="margin:0 0 14px;">${n === 1
      ? 'One new job posting matches your alert:'
      : `${n} new job postings match your alert:`}</p>`);
    parts.push('<ul style="padding-left:20px;margin:0 0 18px;">');
    parts.push(jobs.slice(0, MAX_ROWS).map(jobHtml).join(''));
    parts.push('</ul>');
    if (n > MAX_ROWS) {
      parts.push(`<p style="color:#666;font-size:13px;">…and ${n - MAX_ROWS} more.
        <a href="${esc(SITE)}/jobs">See them all on the site</a>.</p>`);
    }
  }

  const nc = candidates.length;
  if (nc) {
    parts.push(`<p style="margin:${n ? '22px' : '0'} 0 14px;">${nc === 1
      ? 'A new candidate joined the job market page:'
      : `${nc} new candidates joined the job market page:`}</p>`);
    parts.push('<ul style="padding-left:20px;margin:0 0 18px;">');
    parts.push(candidates.slice(0, MAX_ROWS).map(candidateHtml).join(''));
    parts.push('</ul>');
    if (nc > MAX_ROWS) {
      parts.push(`<p style="color:#666;font-size:13px;">…and ${nc - MAX_ROWS} more.
        <a href="${esc(SITE)}/#candidates">See them all on the site</a>.</p>`);
    }
  }

  /* CLOSING THIS WEEK. Headed as its own section, because it is a reminder
     about postings the reader may already have been told about, not news of
     new ones; keep the wording in step with the alerts page's preview
     (oa-alerts.js). */
  const nd = closing.length;
  if (nd) {
    parts.push(`<p style="margin:${(n || nc) ? '22px' : '0'} 0 10px;">` +
      '<strong>Closing this week</strong></p>');
    parts.push(`<p style="margin:0 0 14px;">${nd === 1
      ? 'One posting matching your alert closes in the next seven days:'
      : `${nd} postings matching your alert close in the next seven days:`}</p>`);
    parts.push('<ul style="padding-left:20px;margin:0 0 18px;">');
    parts.push(closing.slice(0, MAX_ROWS).map((e) => closingHtml(e, now)).join(''));
    parts.push('</ul>');
    if (nd > MAX_ROWS) {
      parts.push(`<p style="color:#666;font-size:13px;">…and ${nd - MAX_ROWS} more.
        <a href="${esc(SITE)}/jobs">See them all on the site</a>.</p>`);
    }
  }

  if (updates.length) {
    parts.push(`<p style="margin:${(n || nc || nd) ? '22px' : '0'} 0 10px;"><strong>What is new on the
      site</strong></p><ul style="padding-left:20px;margin:0 0 18px;">`);
    for (const u of updates) {
      const uUrl = safeUrl(u.url);
      parts.push(`<li style="margin-bottom:12px;">
        <strong>${esc(u.title)}</strong><br>
        <span style="color:#555;">${esc(u.summary)}</span>
        ${uUrl ? `<br><a href="${esc(uUrl)}">Take a look</a>` : ''}
      </li>`);
    }
    parts.push('</ul>');
  }

  // The button aims where the e-mail's news is: a candidates-only message
  // must not end on "Browse all job postings" about postings it never named.
  const cta = (nc && !n && !nd)
    ? { href: `${SITE}/#candidates`, label: 'Meet the candidates' }
    : { href: `${SITE}/jobs`, label: 'Browse all job postings' };
  parts.push(`<p style="margin-top:20px;">
    <a href="${esc(cta.href)}" style="display:inline-block;background:#3B7DBC;color:#fff;
       padding:9px 18px;border-radius:3px;text-decoration:none;font-weight:600;">
       ${esc(cta.label)}</a></p>`);

  return shell({
    title: alert.name || 'Operations Academia',
    bodyHtml: parts.join('\n'),
    manageUrl: MANAGE_URL,
    unsubUrl: unsubscribeUrl(alert),
  });
}

/* --------------------------------------------------------------- selftest */

async function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, w) => { if (c) pass++; else fails.push(w); };

  /** Run something whose only job is to print, without printing. */
  const quiet = async (fn) => {
    const real = console.log;
    console.log = () => {};
    try { return await fn(); } finally { console.log = real; }
  };

  const rows = [
    { id: '1', institution: 'University of Münster', department: 'Ops', type: 'University',
      country: 'Germany', levels: ['Post-Doc'], characteristics: ['PhD'],
      addedAt: '2026-08-10T00:00:00Z', applyBy: 'September 1, 2026' },
    { id: '2', institution: 'Duke University', department: 'Fuqua', type: 'Business School',
      country: 'USA', levels: ['Assistant Professor'], characteristics: ['MBA'],
      addedAt: '2026-08-14T00:00:00Z', applyBy: 'November 1, 2026' },
  ];

  // the shared matcher behaves the same here as in the browser
  ok(M.matchesJob(rows[0], { topics: ['jobs'] }), 'a filterless alert matches everything');
  ok(!M.matchesJob(rows[0], { topics: ['jobs'], country: ['USA'] }), 'country filter excludes');
  ok(M.matchesJob(rows[0], { topics: ['jobs'], text: 'munster' }),
    'text match folds diacritics');
  ok(M.matchesJob(rows[1], { topics: ['jobs'], country: ['USA'], level: ['Assistant Professor'] }),
    'two filters both satisfied');
  ok(!M.matchesJob(rows[1], { topics: ['jobs'], country: ['USA'], level: ['Post-Doc'] }),
    'filters are ANDed, not ORed');

  // the window
  ok(M.newJobsFor(rows, { topics: ['jobs'] }, '2026-08-12T00:00:00Z').length === 1,
    'only postings added after the high-water mark are sent');
  ok(M.newJobsFor(rows, { topics: ['jobs'] }, '').length === 2,
    'a never-sent alert considers everything');
  ok(M.newJobsFor(rows, { topics: ['updates'] }, '').length === 0,
    'an updates-only alert is sent no postings');

  /* THE JOB WINDOW IS A MARK ON THE POSTINGS, and the loss it ends is worth
     naming: an alert carrying jobs AND updates, whose run saw no new postings
     — a stale read, or simply a build committing while this ran — sent its
     update digest and advanced `lastSentAt` to NOW. Every posting published in
     between was then behind the mark for ever. Read from the postings instead,
     an empty jobs list writes no job mark at all, so nothing can be skipped.

     Read out of this file's own source, because the branch that writes it
     needs Firestore and a mailbox to reach. */
  const mailerSrc = await readFile(path.join(HERE, 'alerts-mailer.mjs'), 'utf8');
  ok(/const since = a\.lastJobAt \|\| a\.lastSentAt \|\| a\.createdAt/.test(mailerSrc),
    'the job window reads lastJobAt first, falling back to what an alert already has');
  ok(/const newestJob = M\.latestAddedAt\(jobs\);\s*\n\s*if \(newestJob\) patch\.lastJobAt = newestJob;/
    .test(mailerSrc),
    'and it is advanced to the newest posting actually sent, never to the clock');
  ok(!/patch\.lastJobAt = now/.test(mailerSrc),
    'a wall clock never becomes the job mark — that is the loss this ends');
  ok(M.latestAddedAt(rows) === '2026-08-14T00:00:00Z',
    'the mark a send leaves is the newest addedAt it carried');
  ok(M.newJobsFor(rows, { topics: ['jobs'] }, M.latestAddedAt(rows)).length === 0,
    'and nothing already sent is sent twice');
  ok(M.newJobsFor(rows, { topics: ['jobs'] }, M.latestAddedAt([rows[0]])).length === 1,
    'while a posting published after the mark is still waiting for its digest');
  /* THE IDLE BRANCH LEAVES THE WINDOW ALONE. "Nothing new" writes lastCheckedAt
     and nothing else, so a quiet run cannot swallow the next approval either. */
  ok(/const idle = \{ lastCheckedAt: now\.toISOString\(\) \};/.test(mailerSrc) &&
     !/const idle = \{[^}]*lastJobAt/.test(mailerSrc),
    'a run with nothing to send moves no window at all');
  /* …but it FREEZES the job floor where it stood: `since` fell back to
     lastSentAt, which every digest advances, so an update-only digest moved
     the job window past a posting approved minutes earlier. The three
     patches that can advance lastSentAt without carrying a posting each pin
     lastJobAt to `since` when the alert has none — never to `now`. */
  ok((mailerSrc.match(/if \(!a\.lastJobAt\) \w+\.lastJobAt = since;/g) || []).length === 3,
    'the job floor is frozen at `since` on the idle, reveal-note and no-posting digest paths');


  const log = [
    { id: 'a', date: '2026-08-15', title: 'T', summary: 'S' },
    { id: 'b', date: '2026-08-01', title: 'U', summary: 'S' },
  ];
  const UP = { topics: ['updates'] };
  ok(M.newUpdatesFor(log, UP, '2026-08-10').length === 1,
    'only change-log entries after the last one sent are sent');
  ok(M.newUpdatesFor(log, { topics: ['jobs'] }, '').length === 0,
    'a jobs-only alert is sent no change-log entries');

  // The window is keyed on the DATE OF THE LAST ENTRY SENT, not on a send
  // timestamp. Comparing a calendar date against an instant drops every entry
  // dated on the day of the last send — so an announcement made the same
  // morning as a digest would reach nobody, ever.
  ok(M.newUpdatesFor(log, UP, '2026-08-14', '2026-08-15').length === 1,
    'an entry dated today is sent when the last one sent was yesterday');
  ok(M.newUpdatesFor(log, UP, '2026-08-15', '2026-08-15').length === 0,
    'an entry already sent is not sent twice');
  ok(M.newUpdatesFor([{ date: '2026-12-01', title: 'later' }], UP, '', '2026-08-15').length === 0,
    'an entry dated in the future waits rather than going out early');
  ok(M.newUpdatesFor([{ title: 'no date' }], UP, '', '2026-08-15').length === 0,
    'an entry with no date is never sent');
  ok(M.latestUpdateDate(log) === '2026-08-15',
    'latestUpdateDate reports the newest entry, to become the next mark');
  ok(M.latestUpdateDate([]) === '',
    'latestUpdateDate of nothing is empty, so the mark is left alone');
  ok(M.daysBefore(new Date('2026-08-15T00:00:00Z'), 31) === '2026-07-15',
    'a first-ever send is capped rather than posting the back-catalogue');

  /* ------------------------------------------------------------- candidates

     The rules the owner set (2026-08-23), each pinned: nothing about a profile
     the site is not showing; ONE friendly note when the year's profiles go
     live, never a listing of the lot; then a note about each new profile,
     since by then it is public information. */
  const CAND = [
    { id: '2027-doe-jane', name: 'Jane Doe', position: 'PhD Candidate',
      affiliation: 'Wharton, University of Pennsylvania',
      researchAreas: ['Supply Chain Management', 'Behavioral Operations'],
      informsDays: ['Sunday'], cvUrl: 'https://example.org/cv.pdf',
      addedAt: '2026-08-20T09:00:00Z' },
    { id: '2027-lee-ann', name: 'Ann Lee', position: 'Post-Doctoral Researcher',
      affiliation: 'MIT Sloan', researchAreas: [],
      addedAt: '2026-10-12T08:00:00Z' },
  ];
  const CT = { topics: ['candidates'] };

  ok(M.candidateNews([], CT, '') === null,
    'held profiles are not in the served file, so nothing about them can be sent');
  ok(M.candidateNews(CAND, { topics: ['jobs'] }, '') === null,
    'a jobs-only alert is sent no candidate e-mail');
  const rev = M.candidateNews(CAND, CT, '');
  ok(rev && rev.kind === 'reveal' && rev.count === 2,
    'the first candidate e-mail is the one friendly note, never a listing');
  ok(rev.mark === '2026-10-12T08:00:00Z',
    'the note covers everything on the page — its mark is the newest profile');
  const lst = M.candidateNews(CAND, CT, '2026-08-20T09:00:00Z');
  ok(lst && lst.kind === 'profiles' && lst.rows.length === 1 &&
    lst.rows[0].id === '2027-lee-ann',
    'after the note, only profiles added since the mark are listed');
  ok(M.candidateNews(CAND, CT, '2026-10-12T08:00:00Z') === null,
    'nothing new means no candidate e-mail, and the mark stands');

  /* Seasons repeat: next cycle the admin sets a new reveal date, the served
     file is held back to empty, and on the new reveal day it fills at once.
     The announcement is keyed on the REVEAL DAY, so a subscriber whose mark
     survives from last season is met with the note again, not a listing. */
  const REV = '2026-10-11';
  ok(M.candidateNews(CAND, CT, '2025-11-05T00:00:00Z', REV).kind === 'reveal',
    'a mark left from last season meets the new reveal with the note, never a listing');
  const after = M.candidateNews(CAND, CT, '2026-10-11T09:00:00Z', REV);
  ok(after && after.kind === 'profiles' && after.rows.length === 1,
    'a mark stamped on or after the reveal day lists only the genuinely new profiles');
  const filtered = M.candidateNews(CAND,
    { topics: ['candidates'], country: ['USA'], level: ['Post-Doc'] },
    '2026-08-20T09:00:00Z');
  ok(filtered && filtered.rows.length === 1,
    'the job filters never narrow people — the candidates topic has no filters');

  const live = renderCandidatesLiveEmail({ alert: { id: 'x', name: 'My alert' }, count: 2 });
  ok(live.includes('2 candidates'), 'the live note says how many profiles are up');
  ok(live.includes('#candidates'), 'the live note links to the candidates section');
  ok(live.includes('Unsubscribe'), 'the live note offers an unsubscribe');
  ok(!live.includes('—') && !live.includes('&mdash;'),
    'and carries no em-dash, per the owner’s instruction on its wording');
  ok(renderCandidatesLiveEmail({ alert: { id: 'x' }, count: 1 })
    .includes('The first candidate'),
    'a single profile reads as a sentence, not as "1 candidates"');

  const candDigest = renderAlertEmail({
    alert: { id: 'x', name: 'n' }, jobs: [], updates: [], candidates: CAND,
  });
  ok(candDigest.includes('Jane Doe') && candDigest.includes('Ann Lee'),
    'the digest lists the new profiles');
  ok(candDigest.includes('Meet the candidates'),
    'a candidates-only e-mail ends on the candidates, not on the job board');
  const evilCand = renderAlertEmail({
    alert: { id: 'x', name: 'n' }, jobs: [], updates: [],
    candidates: [{ ...CAND[0], name: '<img src=x onerror=alert(1)>',
      affiliation: '<b>aff</b>', cvUrl: 'javascript:alert(1)', webUrl: 'data:text/html,x' }],
  });
  ok(!evilCand.includes('<img src=x'), 'a profile name cannot inject markup');
  ok(!evilCand.includes('<b>aff</b>'), 'a profile affiliation cannot inject markup');
  ok(!/href="javascript:/i.test(evilCand), 'a javascript: CV link is not linked');
  ok(!/href="data:/i.test(evilCand), 'a data: website link is not linked');

  /* ------------------------------------------------------ closing this week

     The deadlines topic (owner, 2026-09-04): the postings matching the alert's
     filters whose final or suggested apply-by date is within the next seven
     days, each named ONCE. The window arithmetic and the mark are pinned
     here, the renderer below; the matcher's own edges are pinned in
     _scraper/selftest.mjs. */
  const TODAY = '2026-09-04';
  const DL_UNTIL = M.shiftDay(TODAY, M.DEADLINE_WINDOW_DAYS);
  ok(M.DEADLINE_WINDOW_DAYS === 7 && DL_UNTIL === '2026-09-11',
    'the window runs today through today plus seven days, as the page promises');
  const CLOSING = [
    { id: '2027-a-university-20260901', institution: 'A University', department: 'Ops',
      type: 'University', country: 'Ireland', levels: ['Assistant Professor'],
      characteristics: [], posted: '2026-09-01', year: 2027,
      applyByDate: '2026-09-08', reviewDate: '', addedAt: '2026-09-01T00:00:00Z' },
    { id: '2027-b-university-20260901', institution: 'B University', department: 'SCM',
      type: 'Business School', country: 'Germany', levels: ['Post-Doc'],
      characteristics: [], posted: '2026-09-01', year: 2027,
      applyByDate: '', reviewDate: '2026-09-05', addedAt: '2026-09-01T00:00:00Z' },
    { id: '2027-c-university-20260901', institution: 'C University', department: 'Ops',
      type: 'University', country: 'Ireland', levels: [], characteristics: [],
      posted: '2026-09-01', year: 2027, applyByDate: '2026-10-01', reviewDate: '',
      addedAt: '2026-09-01T00:00:00Z' },
  ];
  const DL = { topics: ['deadlines'] };
  const win = (covered) => M.closingSoonFor(CLOSING, DL,
    { from: TODAY, until: DL_UNTIL, coveredUntil: covered });
  ok(win('').map((e) => e.row.id + ':' + e.kind + ':' + e.date).join(',') ===
     '2027-b-university-20260901:suggested:2026-09-05,2027-a-university-20260901:final:2026-09-08',
    'a never-checked alert is told every posting closing in the window, earliest first, ' +
    'a suggested date named as suggested and a final one as final');
  ok(win(DL_UNTIL).length === 0,
    'and once the window end is the mark, nothing in it is sent twice');
  ok(win('2026-09-06').map((e) => e.row.id).join(',') === '2027-a-university-20260901',
    'a mark inside the window lets through only the dates after it');
  ok(M.closingSoonFor(CLOSING, { topics: ['jobs'] },
    { from: TODAY, until: DL_UNTIL, coveredUntil: '' }).length === 0,
    'a jobs-only alert is sent no closing reminder');
  ok(M.closingSoonFor(CLOSING, { topics: ['deadlines'], country: ['Germany'] },
    { from: TODAY, until: DL_UNTIL, coveredUntil: '' }).map((e) => e.row.id).join(',') ===
     '2027-b-university-20260901',
    'the reminder honours the same filters the jobs topic does');

  /* THE MARK IS THE WINDOW END, written on the idle branch and behind a real
     delivery, and never the clock. Read out of this file's own source, like
     the job mark above, because the branch that writes it needs Firestore and
     a mailbox. */
  ok(/const deadlineUntil = M\.shiftDay\(today, M\.DEADLINE_WINDOW_DAYS\);/.test(mailerSrc),
    'the window end is today plus the shared constant');
  ok(/coveredUntil: a\.lastDeadlineUntil \|\| ''/.test(mailerSrc),
    'and the alert is checked against the days after its own lastDeadlineUntil');
  ok(/if \(wantsDeadlines && jobsOk\) idle\.lastDeadlineUntil = deadlineUntil;/.test(mailerSrc),
    'an idle run covers the window it checked and found empty — only when the jobs file was read');
  ok(/if \(wantsDeadlines && jobsOk\) patch\.lastDeadlineUntil = deadlineUntil;/.test(mailerSrc),
    'a delivered digest covers the window it carried — only when the jobs file was read');
  /* AN UNREAD JOBS FILE IS NOT AN EMPTY WINDOW. The jobs read falls back to []
     on failure (the safe direction for the jobs and candidates marks, which
     move only behind a delivery), and with no rows the deadlines topic finds
     nothing and takes the idle branch — the one branch that moves a mark
     without a send. Unguarded, every closing date in that week would be
     stamped covered without having been looked at. So the read records
     whether it succeeded and BOTH stamps carry the guard. */
  ok(/let jobsOk = true;/.test(mailerSrc) &&
     /\.catch\(\(\) => \{ jobsOk = false; return \[\]; \}\)/.test(mailerSrc),
    'the jobs read remembers whether it succeeded, apart from what it held');
  // a literal dot: the pins above write `idle\.` and cannot match themselves
  ok((mailerSrc.match(/\b(idle|patch)\.lastDeadlineUntil = deadlineUntil;/g) || []).length === 2 &&
     (mailerSrc.match(/wantsDeadlines && jobsOk\) (idle|patch)\.lastDeadlineUntil = deadlineUntil;/g) || []).length === 2,
    'every write of the deadlines mark is gated on the jobs file having been read');
  ok(/::warning::data\/jobs\.json could not be read/.test(mailerSrc),
    'and an unread jobs file is named in the run log');
  // the needle is assembled, not written, so this check cannot match itself
  ok(!new RegExp('lastDeadlineUntil = ' + '(now|today)\\b').test(mailerSrc),
    'a wall clock never becomes the deadlines mark — the mark is the window END');
  ok(/lastSentCount: jobs\.length \+ news\.length \+ candRows\.length \+ closing\.length/
    .test(mailerSrc), 'the closing rows count towards lastSentCount');
  ok(/`\$\{closing\.length\} posting\$\{closing\.length > 1 \? 's' : ''\} ` \+\s*`close\$\{closing\.length === 1 \? 's' : ''\} this week`/
    .test(mailerSrc), 'a digest that carried only deadlines is subjected "N postings close this week"');
  ok(/!jobs\.length && !news\.length && !cand && !closing\.length/.test(mailerSrc),
    'a closing reminder alone is enough to send');

  // the section, rendered
  const dlDigest = renderAlertEmail({
    alert: { id: 'x', name: 'n' }, jobs: [], updates: [], closing: win(''),
    now: new Date(TODAY + 'T09:00:00Z'),
  });
  ok(dlDigest.includes('Closing this week'), 'the digest carries the "Closing this week" section');
  ok(dlDigest.includes('2 postings matching your alert close in the next seven days'),
    'and says how many');
  ok(dlDigest.includes('Final apply by September 8, 2026') &&
     dlDigest.includes('Suggested apply by September 5, 2026'),
    'each row names which date it is, and the date, in the site\'s own words');
  ok(dlDigest.includes('A University') && dlDigest.includes('B University') &&
     dlDigest.includes('SCM'),
    'each row names the institution and the department');
  ok(dlDigest.includes('jobs.html?job=2027-a-university-20260901'),
    'and links the posting\'s own permalink, through the shared page rule');
  ok(dlDigest.includes('Browse all job postings'),
    'a deadlines-only e-mail still ends on the job board');
  const oneDl = renderAlertEmail({
    alert: { id: 'x', name: 'n' }, jobs: [], updates: [], closing: win('').slice(0, 1),
  });
  ok(oneDl.includes('One posting matching your alert closes in the next seven days'),
    'a single posting reads as a sentence');
  const evilDl = renderAlertEmail({
    alert: { id: 'x', name: 'n' }, jobs: [], updates: [],
    closing: [{ kind: 'final', date: '2026-09-08',
      row: { ...CLOSING[0], id: '"><script>bad()</script>',
        institution: '<img src=x onerror=alert(1)>', department: '<b>d</b>' } }],
  });
  ok(!evilDl.includes('<img src=x') && !evilDl.includes('<b>d</b>') &&
     !evilDl.includes('<script>bad()'),
    'a posting cannot inject markup into the closing section, id included');
  ok(!dlDigest.includes('\u2014'), 'and the section carries no em-dash');

  /* ------------------------------- what may be announced at all (oa-news.js)

     An e-mail cannot be recalled, so the review gate has to hold HERE as well
     as on the page: an entry the maintainer has not published, or has taken
     down, must not reach an inbox. These are the mailer's own use of the
     module; the decision rules themselves are pinned in _scraper/selftest.mjs. */
  const REVIEWED = [
    { id: 'old', date: '2026-08-01', title: 'Before the gate', summary: 'S' },
    { id: 'live', date: '2026-08-25', title: 'Published', summary: 'S' },
    { id: 'draft', date: '2026-08-26', title: 'Waiting', summary: 'S' },
    { id: 'gone', date: '2026-08-27', title: 'Taken down', summary: 'S' },
  ];
  const DECIDED = { live: { status: 'approved' }, gone: { status: 'removed' } };
  const sendable = News.publicUpdates(REVIEWED, DECIDED).map((e) => e.id);
  ok(sendable.join(',') === 'live,old',
    'only published entries are e-mailed — an unreviewed one and a removed one are not');
  ok(News.publicUpdates(REVIEWED, {}).map((e) => e.id).join(',') === 'old',
    'and with no decisions readable, nothing since the review gate goes out');

  /* THE ORDER MATTERS, because the per-alert mark is a DATE. Sending the entry
     of the 25th while the 26th is still unreviewed is fine; sending one dated
     AFTER an unreviewed entry would move the mark past it, and publishing that
     entry later would then reach nobody at all. */
  ok(updateWindowEnd('2026-08-30', '2026-08-26') === '2026-08-25',
    'the digest stops the day before the oldest entry still waiting for review');
  ok(updateWindowEnd('2026-08-30', '') === '2026-08-30',
    'with nothing waiting it runs to today');
  ok(updateWindowEnd('2026-08-30', '2026-09-10') === '2026-08-30',
    'an entry waiting with a FUTURE date holds nothing back — it was not due anyway');
  ok(updateWindowEnd('2026-08-30', '2026-08-30') === '2026-08-29',
    'and one waiting since today holds back today');
  const QUEUED = [
    { id: 'before', date: '2026-08-25', title: 'Published, and older', summary: 'S' },
    { id: 'draft', date: '2026-08-26', title: 'Waiting', summary: 'S' },
    { id: 'after', date: '2026-08-28', title: 'Published, but newer', summary: 'S' },
  ];
  const QDECIDED = { before: { status: 'approved' }, after: { status: 'approved' } };
  const qEnd = updateWindowEnd('2026-08-30', '2026-08-26');
  const qSent = M.newUpdatesFor(News.publicUpdates(QUEUED, QDECIDED), UP, '2026-08-20', qEnd)
    .map((e) => e.id);
  ok(qSent.join(',') === 'before',
    'a published entry DATED AFTER an unreviewed one waits for it; one dated before goes now');

  /* AND A LONG HOLD MUST NOT QUIETLY DROP IT. A subscriber who has never had an
     update digest has no `lastUpdateDate`, so their window floor is a 31-day
     cap — and while it slid with the clock, an entry held longer than a month
     fell out of it on the very day it was published: skipped on that run and on
     every run after, with nothing in the log saying so. Freezing the floor the
     first time it is computed is what fixes it, and this is that timeline,
     played out day by day the way the run does it. */
  const HELD = [{ id: 'x', date: '2026-08-26', title: 'Waited a long time', summary: 'S' }];
  const windowFor = (day, decided, storedFloor) => {
    const pending = News.partition(HELD, decided).pending;
    const oldest = pending.reduce((m, e) => (!m || e.date < m ? e.date : m), '');
    const end = updateWindowEnd(day, oldest);
    const from = storedFloor ||
      M.daysBefore(new Date(Date.parse(end + 'T00:00:00Z')), 31);
    return { from, end, sent: M.newUpdatesFor(HELD, UP, from, end).map((e) => e.id) };
  };
  // day 1 of the hold: nothing sent, and the floor is frozen where it stood
  const w1 = windowFor('2026-08-27', {});
  ok(w1.sent.length === 0 && w1.end === '2026-08-25',
    'while the entry waits, the window stops short of it and nothing goes out');
  const frozen = w1.from;
  // a month later it is published — WITHOUT the frozen floor it is already lost
  const slid = windowFor('2026-09-27', { x: { status: News.APPROVED } });
  ok(slid.sent.length === 0,
    'a floor measured from today would have skipped it — the bug this pins');
  const kept = windowFor('2026-09-27', { x: { status: News.APPROVED } }, frozen);
  ok(kept.sent.join(',') === 'x',
    'the frozen floor still covers it, so a month-long hold delays and does not lose');
  ok(M.latestUpdateDate(HELD) === '2026-08-26',
    'and the mark then advances to the entry itself, so it is not sent twice');

  // due-ness
  const now = new Date('2026-08-15T12:00:00Z');
  ok(M.isDue('daily', null, now), 'a never-sent alert is due');
  ok(!M.isDue('daily', '2026-08-15T06:00:00Z', now), 'a daily alert is not due after 6 hours');
  ok(M.isDue('daily', '2026-08-14T06:00:00Z', now), 'a daily alert is due after 30 hours');
  ok(!M.isDue('weekly', '2026-08-12T00:00:00Z', now), 'a weekly alert is not due after 3 days');
  ok(M.isDue('weekly', '2026-08-01T00:00:00Z', now), 'a weekly alert is due after 14 days');

  // rendering
  const html = renderAlertEmail({
    alert: { id: 'x', name: 'My alert' }, jobs: rows, updates: log,
  });
  ok(html.includes('Duke University'), 'the e-mail lists the matching postings');
  ok(html.includes('Unsubscribe'), 'the e-mail offers an unsubscribe');
  ok(html.includes('operationsacademia.org/alerts'), 'the e-mail links to the manage page');
  ok(html.includes('unsubscribe=x'),
    'the unsubscribe link names the alert, so opening it can actually stop it');

  // The List-Unsubscribe header must not promise one-click. This site is
  // served by GitHub Pages and cannot accept the POST that header declares;
  // announcing it shows a button that silently does nothing.
  const h = unsubHeaders('https://www.operationsacademia.org/alerts?unsubscribe=x');
  ok(!!h['List-Unsubscribe'], 'a List-Unsubscribe header is set');
  ok(!('List-Unsubscribe-Post' in h),
    'one-click is NOT declared — there is no endpoint that could honour it');
  ok(h['List-Unsubscribe'].includes('mailto:'), 'a mailto fallback is offered');
  ok(!/<script/i.test(html), 'the e-mail contains no script');

  const evil = renderAlertEmail({
    alert: { id: 'x', name: 'n' },
    jobs: [{ ...rows[0], institution: '<img src=x onerror=alert(1)>' }],
    updates: [],
  });
  ok(!evil.includes('<img src=x'), 'a posting cannot inject markup into the e-mail');

  // EVERY field of a posting is submitted through the form, not just the two
  // that used to be escaped: country, level and the apply-by date are joined
  // into one meta line and were interpolated raw.
  const evil2 = renderAlertEmail({
    alert: { id: 'x', name: 'n' },
    jobs: [{ ...rows[0], country: '<img src=x onerror=alert(1)>',
      levels: ['<b>lvl</b>'], applyBy: '"><script>bad()</script>' }],
    updates: [],
  });
  ok(!evil2.includes('<img src=x'), 'a posting country cannot inject markup');
  ok(!evil2.includes('<b>lvl</b>'), 'a posting level cannot inject markup');
  ok(!evil2.includes('<script>bad()'), 'a posting apply-by date cannot inject markup');
  ok(evil2.includes('&middot;'), 'the meta separator survives the escaping');

  // A link in a posting reaches an inbox unreviewed, so only http(s) is put in
  // an href — escaping cannot make a javascript: or data: URL harmless.
  const links = renderAlertEmail({
    alert: { id: 'x', name: 'n' },
    jobs: [{ ...rows[0], adUrl: 'javascript:alert(1)', postedAtUrl: 'data:text/html,<b>x' }],
    updates: [],
  });
  ok(!/href="javascript:/i.test(links), 'a javascript: job link is not linked');
  ok(!/href="data:/i.test(links), 'a data: job link is not linked');
  ok(safeUrl('https://example.org/a') === 'https://example.org/a', 'an https link survives');

  // A header ends at the first newline; an alert name becomes the subject.
  ok(!/[\r\n]/.test(headerSafe('News\r\nBcc: everyone@example.com')),
    'a newline cannot be smuggled into a header');
  ok(headerSafe('News\r\nBcc: x@y.z').includes('Bcc'),
    'the injected text is folded into the value, not silently dropped');

  // Actions logs of a public repository are world-readable.
  ok(redact('subscriber@example.com') === 'su***@example.com',
    'the run log does not print a subscriber address in full');
  ok(redact('') === 'no address', 'a missing address still reads sensibly');

  // THE CONTRACT THE HIGH-WATER MARK RESTS ON. send() must report false when it
  // only printed the message — with no transport, or in a dry run. If it ever
  // returned true there, this mailer would advance lastSentAt over a window it
  // never delivered, and those postings could never be e-mailed to anyone.
  const msg = { to: 'a@b.c', subject: 's', html: '<p>x</p>' };
  const stub = { sendMail: async () => {} };
  ok(await quiet(() => send(null, msg)) === false, 'no transport is not a send');
  ok(await quiet(() => send(stub, msg, { dryRun: true })) === false, 'a dry run is not a send');
  ok(await quiet(() => send(stub, msg)) === true, 'a delivered message reports true');

  // and the guard is applied where the caller cannot forget it
  let seen = null;
  await quiet(() => send({ sendMail: async (m) => { seen = m; } },
    { to: 'a@b.c\r\nBcc: victim@example.com', subject: 'hi\nX-Spoof: 1', html: '<p>x</p>' }));
  ok(!/[\r\n]/.test(seen.to) && !/[\r\n]/.test(seen.subject),
    'send() folds newlines out of every header it is given');

  const plain = toPlain(html);
  ok(plain.includes('Duke University') && !plain.includes('<'),
    'the plain-text alternative is readable and tag-free');

  if (fails.length) {
    console.log(`\n${fails.length} FAILED, ${pass} passed`);
    for (const f of fails) console.log('  FAIL  ' + f);
    return false;
  }
  console.log(`alerts-mailer selftest: ${pass} checks passed`);
  return true;
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (argv.has('--selftest')) process.exit(await selftest() ? 0 : 1);

  const db = await firestore();
  if (!db) {
    console.log('no Firebase credentials — nothing to send.');
    console.log('(expected until the project is set up: v2/_SETUP-EMAIL.md)');
    return;
  }

  /* WHETHER THE JOBS FILE WAS READ, remembered apart from what it held. The
     jobs and candidates marks move only behind a delivery, so an unreadable
     file costs them nothing (nothing matched, nothing sent, nothing stamped).
     The DEADLINES mark is the one mark that moves on the idle branch — a
     window checked and found empty is covered — and an unreadable file reads
     exactly like an empty window: every closing date in the week would be
     stamped covered without ever having been looked at, and "delayed, never
     lost" would be false for that week. So the two stamps below are gated on
     this flag, and a run that could not read the file re-checks the same
     window next time. */
  let jobsOk = true;
  const [rows, changelog, candRowsAll, candMeta] = await Promise.all([
    readFile(path.join(HERE, '..', 'data', 'jobs.json'), 'utf8').then(JSON.parse)
      .catch(() => { jobsOk = false; return []; }),
    readFile(path.join(HERE, '..', 'changelog.json'), 'utf8').then(JSON.parse)
      .catch(() => ({ updates: [] })),
    /* THE ONLY SOURCE OF CANDIDATES IS THE SERVED FILE. build-candidates.mjs
       writes no row into it until the admin's reveal date, so while profiles
       are held this reads [] and nothing about them can be mentioned — the
       reveal gate holds here because there is nothing to leak, not because
       this file remembers to check a date. A read failure is [] too: the safe
       direction (nothing sent, no mark advanced, retried next run). */
    readFile(path.join(HERE, '..', 'data', 'candidates.json'), 'utf8')
      .then(JSON.parse).catch(() => []),
    // the meta names the reveal day — what decides announcement vs listing
    readFile(path.join(HERE, '..', 'data', 'candidates-meta.json'), 'utf8')
      .then(JSON.parse).catch(() => null),
  ]);
  if (!jobsOk) {
    console.log('::warning::data/jobs.json could not be read — the deadlines ' +
      'window is not marked covered this run, so the next run re-checks it');
  }
  const cands = Array.isArray(candRowsAll) ? candRowsAll : [];
  const candRevealAt = (candMeta && candMeta.revealAt) || '';
  /* WHAT MAY BE SENT is not the whole change log. An entry the maintainer has
     not published yet must not be announced — an e-mail is the one thing that
     cannot be recalled, so a digest would defeat the review gate outright —
     and one they have taken down must not be announced either.
     assets/oa-news.js is the same decision the site's own lists make.

     A READ FAILURE IS NOT AN EMPTY SET OF DECISIONS. Without them everything
     since the gate reads as unreviewed, which is the safe direction (nothing
     new goes out) rather than the wrong one, and older entries still reach a
     subscriber whose window covers them. It is caught, not left to reject:
     letting it kill the run would stop the JOB digests too, and those have
     nothing to do with the update log. */
  let decisions = {};
  try {
    const dsnap = await db.collection(News.COLLECTION).get();
    dsnap.forEach((d) => { decisions[d.id] = d.data(); });
  } catch (err) {
    decisions = {};
    console.log('::warning::could not read the What\'s-new decisions ' +
      `(${err.code || err.message}) — only updates from before the review gate ` +
      'will be sent this run');
  }
  const all = changelog.updates || [];
  const split = News.partition(all, decisions);
  const updates = News.publicUpdates(all, decisions);
  if (split.pending.length || split.removed.length) {
    console.log(`${split.pending.length} change-log entr` +
      `${split.pending.length === 1 ? 'y is' : 'ies are'} waiting for review and ` +
      `${split.removed.length} removed — neither is e-mailed.`);
  }

  /* AND THE ONES AFTER IT WAIT THEIR TURN. The window per subscriber is a
     high-water mark on the DATE of the newest entry sent (see newUpdatesFor),
     so sending an entry dated after one that is still unreviewed would push
     the mark past it — and publishing that older entry later would then reach
     nobody, silently, for ever. So the send stops the day before the oldest
     entry still waiting: publish it or remove it, and everything behind it
     goes out on the next run. Nothing is lost either way, and the order the
     entries are announced in is the order they were written. */
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const oldestPending = split.pending.reduce(
    (m, e) => (!m || e.date < m ? e.date : m), '');
  const until = updateWindowEnd(today, oldestPending);
  /* THE DEADLINES WINDOW is the same for every alert this run: today through
     today plus the constant the alerts page promises. Per alert, only the
     dates AFTER its `lastDeadlineUntil` go out — see closingSoonFor. */
  const deadlineUntil = M.shiftDay(today, M.DEADLINE_WINDOW_DAYS);
  if (until !== today) {
    console.log(`update digests stop at ${until} — ` +
      `"${split.pending[split.pending.length - 1].title}" (${oldestPending}) ` +
      'is still waiting for review.');
  }

  const snap = await db.collectionGroup('alerts').get();
  const tx = await transport();
  // Without a transport NOTHING can be delivered, so the run really is a dry
  // run — including its Firestore writes. Advancing a mark here would put every
  // posting in the window permanently behind the high-water mark, so the first
  // run that CAN send would never see it. (Firebase is normally configured
  // before the mailbox, and this job fires hourly in between.)
  const LIVE = !!tx && !DRY;
  if (!tx && !DRY && !SCAN) {
    console.log('::warning::SMTP is not configured — running as a dry run');
  }

  let sent = 0, skipped = 0, failed = 0;

  for (const doc of snap.docs) {
    const a = { id: doc.id, ...doc.data() };
    const label = `${a.name || '(unnamed)'} <${redact(a.email)}>`;

    if (a.enabled === false) { skipped++; if (SCAN) console.log(`  paused   ${label}`); continue; }
    if (!a.email) { skipped++; if (SCAN) console.log(`  no addr  ${label}`); continue; }
    if (!M.hasIntent(a.criteria)) { skipped++; if (SCAN) console.log(`  no topic ${label}`); continue; }
    if (!M.isDue(a.frequency, a.lastSentAt, now)) {
      skipped++;
      if (SCAN) console.log(`  not due  ${label}  (${a.frequency})`);
      continue;
    }

    /* THE JOB WINDOW IS A MARK ON THE POSTINGS, NOT A WALL CLOCK.
       `lastJobAt` is the newest `addedAt` this alert has actually been sent —
       the same shape as `lastUpdateDate` and `lastCandidateAt`, and for the
       same stated reason: a mark set from the clock can outrun a posting that
       was published while it ran, and everything behind it is then lost in
       silence rather than delayed.

       Jobs were the one topic still windowed on `lastSentAt`, and that is
       exactly how an approval reached nobody. A run reading a stale checkout
       (the instant path did, by construction — see oa-alerts-mail.yml) found
       no new postings, sent the alert's UPDATE digest, and advanced
       `lastSentAt` to now; the posting approved minutes earlier was dated
       before that and never matched again. Any overlap between the build and
       this job does the same thing, so the mark is taken from the postings
       themselves and no timing can slip one behind it.

       `lastSentAt` stays what it always was — WHEN a digest last went out,
       which is what `isDue` is measured on. Only the window moved.

       An alert that has never had one falls back to `lastSentAt`, so nothing
       already sent is re-sent; then `createdAt`; then a 31-day cap, because an
       empty `since` matches every posting ever imported and the first digest
       such a subscriber gets would be the whole back-catalogue. */
    const since = a.lastJobAt || a.lastSentAt || a.createdAt ||
      (M.daysBefore(now, 31) + 'T00:00:00Z');
    const jobs = M.newJobsFor(rows, a.criteria, since)
      .sort((x, y) => String(y.addedAt).localeCompare(String(x.addedAt)));

    /* The change-log window is tracked by the DATE OF THE LAST ENTRY SENT, not
       by the send timestamp — see newUpdatesFor. On a first-ever send it is
       capped at 31 days so a new subscriber is not posted the whole
       back-catalogue, and THAT FLOOR IS FROZEN THE FIRST TIME IT IS COMPUTED
       rather than left to slide with the clock.

       Sliding is what loses a held entry, and only measuring the cap from the
       window end does not save it: while the entry waits the window is frozen
       and nothing is sent, but the DAY IT IS PUBLISHED the hold lifts, the
       window end jumps to today, and a floor of "today minus 31 days" has by
       then moved past the entry's own date — so it is skipped on that run and
       on every run after it, silently. Freezing the floor on first sight keeps
       the entry inside the window however long it waits, and costs one extra
       field on an alert that has never had an update digest. */
    const sinceUpdate = a.lastUpdateDate ||
      M.daysBefore(new Date(Date.parse(until + 'T00:00:00Z') || now.getTime()), 31);
    // persisted below, in whichever branch this alert takes
    const floor = (!a.lastUpdateDate && M.wantsUpdates(a.criteria)) ? sinceUpdate : '';
    const news = M.newUpdatesFor(updates, a.criteria, sinceUpdate, until);

    /* CANDIDATES. `lastCandidateAt` is this alert's own candidate mark; empty
       means it has never had a candidate e-mail, and candidateNews then
       answers with the one-off "the profiles are now live" note instead of a
       listing — see the header, and the long note on candidateNews itself.
       While the reveal holds, `cands` is [] and this is null: silence. */
    const cand = M.candidateNews(cands, a.criteria, a.lastCandidateAt || '', candRevealAt);
    const candRows = cand && cand.kind === 'profiles' ? cand.rows : [];

    /* CLOSING THIS WEEK. `lastDeadlineUntil` is the end of the window this
       alert was last checked against; empty for an alert that has never had
       the topic, so its first digest carries the whole week. It is a mark on
       the WINDOW, never on the clock: written as `deadlineUntil` when a digest
       is delivered and on the idle branch, so a run that could not send
       re-checks the same days instead of losing them. */
    const wantsDeadlines = M.wantsDeadlines(a.criteria);
    const closing = M.closingSoonFor(rows, a.criteria, {
      from: today, until: deadlineUntil, coveredUntil: a.lastDeadlineUntil || '',
    });

    if (!jobs.length && !news.length && !cand && !closing.length) {
      // NOTHING NEW IS NOT A SEND. Advance the mark anyway, so tomorrow's
      // window starts here rather than re-scanning from the last real send.
      skipped++;
      if (SCAN) console.log(`  nothing  ${label}`);
      else if (LIVE) {
        const idle = { lastCheckedAt: now.toISOString() };
        if (floor) idle.lastUpdateDate = floor;   // freeze the floor, see above
        /* …and the JOB floor, for the same reason. `since` fell back to
           lastSentAt, which EVERY digest advances — an update-only or
           candidates-only digest moved the job window to now, and a posting
           approved minutes before it (dated from its approval) was behind
           the mark for ever. Frozen once, at the value it had, it can only
           ever move on a digest that actually carried postings. */
        if (!a.lastJobAt) idle.lastJobAt = since;
        // the deadlines window was checked and found empty: cover it, so the
        // next run announces only what enters the window after today's end —
        // but only if the file was READ; an unread file is not an empty window
        if (wantsDeadlines && jobsOk) idle.lastDeadlineUntil = deadlineUntil;
        await doc.ref.update(idle);
      }
      continue;
    }

    if (SCAN) {
      const candNote = !cand ? ''
        : cand.kind === 'reveal'
          ? `, the candidates-are-live note (${cand.count} profile(s))`
          : `, ${candRows.length} candidate profile(s)`;
      console.log(`  DUE      ${label}  ${jobs.length} posting(s), ${news.length} update(s)` +
        `${candNote}, ${closing.length} closing this week`);
      continue;
    }

    /* THE REVEAL NOTE IS ITS OWN E-MAIL — one short, friendly message saying
       the year's profiles are live, never folded into a digest as a section
       (the owner's wording is the point of it). Its mark advances only behind
       a real delivery, like every other; a failure here does not block the
       job/update digest below, which carries no candidate rows in this state
       (candRows is [] while the announcement is pending). */
    if (cand && cand.kind === 'reveal') {
      try {
        const delivered = await send(tx, {
          to: a.email,
          subject: "This year's job market candidates are now live",
          html: renderCandidatesLiveEmail({ alert: a, count: cand.count }),
          headers: unsubHeaders(unsubscribeUrl(a)),
        }, { dryRun: DRY });

        if (delivered) {
          const notePatch = {
            lastCandidateAt: cand.mark || now.toISOString(),
            lastCheckedAt: now.toISOString(),
          };
          if (!a.lastJobAt) notePatch.lastJobAt = since;   // freeze the job floor too
          // freeze the update-window floor here too — a run whose whole
          // output is this note must not leave it sliding (see the idle
          // branch); the digest below rewrites it when it also sends
          if (floor) notePatch.lastUpdateDate = floor;
          await doc.ref.update(notePatch);
          sent++;
          console.log(`sent ${label}: the candidates-are-live note (${cand.count} profile(s))`);
        } else {
          console.log(`would send ${label}: the candidates-are-live note (${cand.count} profile(s))`);
        }
      } catch (err) {
        failed++;
        console.log(`::warning::could not send to ${redact(a.email)}: ${err.message}`);
      }
    }

    // the announcement may have been the whole of this run for this alert
    if (!jobs.length && !news.length && !candRows.length && !closing.length) continue;

    const html = renderAlertEmail({
      alert: a, jobs, updates: news, candidates: candRows, closing, now,
    });
    const subject = a.name ||
      (jobs.length ? `${jobs.length} new job posting${jobs.length > 1 ? 's' : ''}`
        : closing.length
          ? `${closing.length} posting${closing.length > 1 ? 's' : ''} ` +
            `close${closing.length === 1 ? 's' : ''} this week`
          : candRows.length
            ? (candRows.length === 1 ? 'A new job market candidate'
              : `${candRows.length} new job market candidates`)
            : 'What is new on Operations Academia');

    try {
      const delivered = await send(tx, {
        to: a.email,
        subject,
        html,
        headers: unsubHeaders(unsubscribeUrl(a)),
      }, { dryRun: DRY });

      // THE MARK MOVES ONLY BEHIND A REAL DELIVERY. send() returns false when
      // it merely printed the message (a dry run, or no SMTP configured);
      // treating that as a send would drop this window on the floor for good.
      if (!delivered) {
        skipped++;
        console.log(`would send ${label}: ${jobs.length} posting(s), ` +
          `${candRows.length} candidate(s), ${news.length} update(s), ` +
          `${closing.length} closing this week`);
        continue;
      }

      // advanced only on success — a failure retries this alert, not the world
      const patch = {
        lastSentAt: now.toISOString(),
        lastCheckedAt: now.toISOString(),
        lastSentCount: jobs.length + news.length + candRows.length + closing.length,
      };
      /* …and the newest posting actually sent, which is what the next job
         window starts after. Written ONLY when postings went out: a digest
         that carried updates alone must not move the job mark, or it swallows
         whatever was published in between — the very loss this mark exists to
         end. The whole matched set counts, not the first MAX_ROWS listed: the
         e-mail names the rest and points at the site, so they have been
         announced. */
      const newestJob = M.latestAddedAt(jobs);
      if (newestJob) patch.lastJobAt = newestJob;
      else if (!a.lastJobAt) patch.lastJobAt = since;   // frozen where it stood, never `now`
      // record the newest change-log entry actually sent, so the next window
      // starts after it rather than at a timestamp. The frozen floor is written
      // first and only stands when nothing was sent — a real send always knows
      // a later date than the floor does.
      if (floor) patch.lastUpdateDate = floor;
      const latest = M.latestUpdateDate(news);
      if (latest) patch.lastUpdateDate = latest;
      // and the newest profile actually sent, for the same reason: the next
      // candidate window starts after it, never at a wall clock a profile
      // published mid-run could slip behind
      if (candRows.length && cand.mark) patch.lastCandidateAt = cand.mark;
      /* …and the deadlines window this digest covered — its END, whether or
         not a posting fell inside it (a checked-and-empty window is covered
         too). Never `now`: the mark is a day the window reached, and the next
         window starts after it. Gated on the file having been read, like
         the idle stamp: an updates-only digest over an unread jobs file has
         covered nothing. */
      if (wantsDeadlines && jobsOk) patch.lastDeadlineUntil = deadlineUntil;
      await doc.ref.update(patch);

      sent++;
      console.log(`sent ${label}: ${jobs.length} posting(s), ` +
        `${candRows.length} candidate(s), ${news.length} update(s), ` +
        `${closing.length} closing this week`);
    } catch (err) {
      failed++;
      console.log(`::warning::could not send to ${redact(a.email)}: ${err.message}`);
    }
  }

  console.log(`\n${sent} sent, ${skipped} skipped, ${failed} failed, of ${snap.size} alert(s)`);
}

main().catch((err) => {
  console.error('alerts-mailer failed:', err);
  process.exit(1);
});
