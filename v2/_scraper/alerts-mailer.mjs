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

   Modes:
     --dry-run    match and render, send nothing, print each message
     --scan       report the subscriptions and what each would send
     --selftest   offline checks of the matcher and the renderers
   --------------------------------------------------------------------------- */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shell, esc, send, transport, firestore, unsubHeaders, SITE, toPlain } from './_mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// the one matcher, shared with the browser
const M = require(path.join(HERE, '..', 'assets', 'oa-alert-match.js'));

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const SCAN = argv.has('--scan');

const MANAGE_URL = `${SITE}/alerts`;
const MAX_ROWS = 60;          // an e-mail listing more than this is unreadable

/* --------------------------------------------------------------- rendering */

function jobHtml(r) {
  const meta = [
    (r.levels || []).join(', '),
    r.country,
    r.applyBy ? `apply by ${r.applyBy}` : '',
  ].filter(Boolean).join(' &middot; ');

  const links = [
    r.postedAtUrl ? `<a href="${esc(r.postedAtUrl)}">official advertisement</a>` : '',
    r.adUrl ? `<a href="${esc(r.adUrl)}">job ad (PDF)</a>` : '',
  ].filter(Boolean).join(' &middot; ');

  return `<li style="margin-bottom:14px;">
    <strong style="font-size:16px;">${esc(r.institution)}</strong><br>
    <span style="color:rgba(0,0,0,.6);">${esc(r.department)}</span><br>
    <span style="color:#666;font-size:13px;">${meta}</span>
    ${links ? `<br><span style="font-size:13px;">${links}</span>` : ''}
  </li>`;
}

export function renderAlertEmail({ alert, jobs, updates }) {
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

  if (updates.length) {
    parts.push(`<p style="margin:${n ? '22px' : '0'} 0 10px;"><strong>What is new on the
      site</strong></p><ul style="padding-left:20px;margin:0 0 18px;">`);
    for (const u of updates) {
      parts.push(`<li style="margin-bottom:12px;">
        <strong>${esc(u.title)}</strong><br>
        <span style="color:#555;">${esc(u.summary)}</span>
        ${u.url ? `<br><a href="${esc(u.url)}">Take a look</a>` : ''}
      </li>`);
    }
    parts.push('</ul>');
  }

  parts.push(`<p style="margin-top:20px;">
    <a href="${esc(SITE)}/jobs" style="display:inline-block;background:#3B7DBC;color:#fff;
       padding:9px 18px;border-radius:3px;text-decoration:none;font-weight:600;">
       Browse all job postings</a></p>`);

  return shell({
    title: alert.name || 'Operations Academia',
    bodyHtml: parts.join('\n'),
    manageUrl: MANAGE_URL,
    unsubUrl: `${MANAGE_URL}?unsubscribe=${encodeURIComponent(alert.id || '')}`,
  });
}

/* --------------------------------------------------------------- selftest */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, w) => { if (c) pass++; else fails.push(w); };

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

  const log = [
    { id: 'a', date: '2026-08-15', title: 'T', summary: 'S' },
    { id: 'b', date: '2026-08-01', title: 'U', summary: 'S' },
  ];
  ok(M.newUpdatesFor(log, { topics: ['updates'] }, '2026-08-10').length === 1,
    'only change-log entries inside the window are sent');
  ok(M.newUpdatesFor(log, { topics: ['jobs'] }, '').length === 0,
    'a jobs-only alert is sent no change-log entries');

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
  ok(!/<script/i.test(html), 'the e-mail contains no script');

  const evil = renderAlertEmail({
    alert: { id: 'x', name: 'n' },
    jobs: [{ ...rows[0], institution: '<img src=x onerror=alert(1)>' }],
    updates: [],
  });
  ok(!evil.includes('<img src=x'), 'a posting cannot inject markup into the e-mail');

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
  if (argv.has('--selftest')) process.exit(selftest() ? 0 : 1);

  const db = await firestore();
  if (!db) {
    console.log('no Firebase credentials — nothing to send.');
    console.log('(expected until the project is set up: v2/_SETUP-EMAIL.md)');
    return;
  }

  const [rows, changelog] = await Promise.all([
    readFile(path.join(HERE, '..', 'data', 'jobs.json'), 'utf8').then(JSON.parse).catch(() => []),
    readFile(path.join(HERE, '..', 'changelog.json'), 'utf8').then(JSON.parse)
      .catch(() => ({ updates: [] })),
  ]);
  const updates = changelog.updates || [];

  const snap = await db.collectionGroup('alerts').get();
  const now = new Date();
  const tx = await transport();
  if (!tx && !DRY && !SCAN) {
    console.log('::warning::SMTP is not configured — running as a dry run');
  }

  let sent = 0, skipped = 0, failed = 0;

  for (const doc of snap.docs) {
    const a = { id: doc.id, ...doc.data() };
    const label = `${a.name || '(unnamed)'} <${a.email || 'no address'}>`;

    if (a.enabled === false) { skipped++; if (SCAN) console.log(`  paused   ${label}`); continue; }
    if (!a.email) { skipped++; if (SCAN) console.log(`  no addr  ${label}`); continue; }
    if (!M.hasIntent(a.criteria)) { skipped++; if (SCAN) console.log(`  no topic ${label}`); continue; }
    if (!M.isDue(a.frequency, a.lastSentAt, now)) {
      skipped++;
      if (SCAN) console.log(`  not due  ${label}  (${a.frequency})`);
      continue;
    }

    const since = a.lastSentAt || a.createdAt || '';
    const jobs = M.newJobsFor(rows, a.criteria, since)
      .sort((x, y) => String(y.addedAt).localeCompare(String(x.addedAt)));
    const news = M.newUpdatesFor(updates, a.criteria, String(since).slice(0, 10),
      now.toISOString().slice(0, 10));

    if (!jobs.length && !news.length) {
      // NOTHING NEW IS NOT A SEND. Advance the mark anyway, so tomorrow's
      // window starts here rather than re-scanning from the last real send.
      skipped++;
      if (SCAN) console.log(`  nothing  ${label}`);
      else if (!DRY) await doc.ref.update({ lastCheckedAt: now.toISOString() });
      continue;
    }

    if (SCAN) {
      console.log(`  DUE      ${label}  ${jobs.length} posting(s), ${news.length} update(s)`);
      continue;
    }

    const html = renderAlertEmail({ alert: a, jobs, updates: news });
    const subject = a.name ||
      (jobs.length ? `${jobs.length} new job posting${jobs.length > 1 ? 's' : ''}`
        : 'What is new on Operations Academia');

    try {
      await send(tx, {
        to: a.email,
        subject,
        html,
        headers: unsubHeaders(`${MANAGE_URL}?unsubscribe=${encodeURIComponent(a.id)}`),
      }, { dryRun: DRY });

      if (!DRY) {
        // advanced only on success — a failure retries this alert, not the world
        await doc.ref.update({
          lastSentAt: now.toISOString(),
          lastCheckedAt: now.toISOString(),
          lastSentCount: jobs.length + news.length,
        });
      }
      sent++;
      console.log(`sent ${label}: ${jobs.length} posting(s), ${news.length} update(s)`);
    } catch (err) {
      failed++;
      console.log(`::warning::could not send to ${a.email}: ${err.message}`);
    }
  }

  console.log(`\n${sent} sent, ${skipped} skipped, ${failed} failed, of ${snap.size} alert(s)`);
}

main().catch((err) => {
  console.error('alerts-mailer failed:', err);
  process.exit(1);
});
