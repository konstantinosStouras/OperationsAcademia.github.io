#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — tell the maintainer somebody has posted something.

       jobSubmissions       \
                              ->  THIS  ->  one e-mail per submission
       candidateSubmissions /                        |
                                          the maintainer looks at it on
                                          operationsacademia.org/admin-area

   WHAT WAS MISSING. The tracking sheet's postings are announced
   (jobreview-mailer.mjs) and everything posted through the site's own forms
   was not — a job posting, and a candidate profile, arrived in Firestore, were
   published by the next build, and nothing said so. For candidates that was
   the worse half: their profiles are held behind the reveal date, so they are
   in no served file and drew no card anywhere on the site. Two of them had
   been sitting there.

   ONE E-MAIL PER SUBMISSION, and `announcedAt` on the document is the
   high-water mark, so nothing is announced twice and a run that dies half-way
   resumes rather than repeats — the same shape as the review queue's mailer,
   for the same reasons. Above `BURST` a batch goes as one list rather than as
   a mail bomb from the site's own address.

   NOTHING IS WITHHELD. This is not a gate: the posting is already live, or
   about to be at the next build, and the forms promise as much. It is a
   notification and a to-do list.

   THE WRITE ORDER IS DELIBERATE: the e-mail is sent FIRST and `announcedAt`
   stamped after. The failure that matters is a submission nobody hears about;
   a duplicate e-mail after a crash between the two is a nuisance, and the
   nuisance is the right way round.

   IT IS A NO-OP UNTIL IT IS CONFIGURED, exactly like the other three mailers:
   without FIREBASE_SERVICE_ACCOUNT there is nothing to read, and without
   SMTP_* there is nowhere to send. Both states say so and exit 0.

   Modes:
     --scan       list what would be mailed, send nothing, write nothing
     --dry-run    render the e-mails and print them, send nothing
     --selftest   offline checks, no network, no credentials
   --------------------------------------------------------------------------- */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  KINDS, SINCE, ANNOUNCED_AT, partitionSubmissions, idsOf, createdDay,
} from './submissions-review.mjs';
import {
  shell, esc, send, transport, toPlain, firestore, fromAddress, SITE, CONTACT,
} from './_mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const SCAN = has('--scan');
const DRY = has('--dry-run');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/** Where "somebody has posted something" goes. The maintainer's own address,
    which is also the one the Admin area's panel is gated on. */
const TO = process.env.SUBMISSION_ALERT_TO || process.env.JOBREVIEW_ALERT_TO || CONTACT;

/** More than this many at once is a batch arriving, not the market ticking
    over, and is announced as one list. Same figure as the review queue's, for
    the same reason. */
export const BURST = Number(process.env.SUBMISSION_BURST) || 12;

/* ---------------------------------------------------------------- rendering */

function line(label, value) {
  if (!value) return '';
  return '<tr><th style="text-align:left;padding:3px 12px 3px 0;vertical-align:top;' +
    'font-weight:600;color:#5a5f6b;white-space:nowrap">' + esc(label) +
    '</th><td style="padding:3px 0;vertical-align:top">' + esc(value) + '</td></tr>';
}

/**
 * One submission.
 *
 * It says what it IS before it says what to do about it, and it is honest
 * about the state: a job posting is on the site (or will be within a minute),
 * a candidate profile is held until the reveal date. Telling the maintainer a
 * profile is "live" when the whole point of the reveal gate is that it is not
 * would be worse than saying nothing.
 */
export function renderSubmissionEmail(kind, entry, { site = SITE, revealAt = '' } = {}) {
  const doc = entry.data || {};
  const row = entry.row || null;
  const title = kind.headline(doc, row);
  const reviewUrl = site + '/admin-area';
  const editUrl = site + '/' + kind.editPath + encodeURIComponent(entry.id);

  const held = kind.key === 'candidate' && revealAt;

  const bodyHtml =
    '<p>A <strong>' + esc(kind.one) + '</strong> has been posted through the site.</p>' +
    '<table style="border-collapse:collapse;font-size:14px;margin:14px 0">' +
      kind.summarise(doc, row).map(([l, v]) => line(l, v)).join('') +
      line('Posted', createdDay(doc)) +
      line('Reference', doc.ref || '') +
    '</table>' +
    (held
      ? '<p style="color:#5a5f6b;font-size:13px">Candidate profiles are held until <strong>' +
        esc(revealAt) + '</strong> and appear all at once on the day, so this one is not ' +
        'on the site and cannot be seen there yet — which is why it is worth reading here.</p>'
      : '<p style="color:#5a5f6b;font-size:13px">It is already live, or will be within a ' +
        'minute of the next build. Nothing is waiting on you — this is so you know it ' +
        'arrived.</p>') +
    '<p><a href="' + esc(editUrl) + '" style="display:inline-block;background:#426394;' +
      'color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:600">' +
      'Open it to correct anything</a></p>' +
    '<p><a href="' + esc(reviewUrl) + '">See everything waiting for a look</a></p>';

  return {
    subject: 'New ' + kind.one + ': ' + (title || entry.id),
    html: shell({ title: 'A ' + kind.one + ' has been posted', bodyHtml, manageUrl: reviewUrl }),
  };
}

/**
 * One e-mail for a batch — what arrived, in a list, with the count in the
 * subject. Deliberately NOT the per-submission card repeated: a hundred of
 * those is not a digest, it is the same mail bomb in one message.
 */
export function renderSubmissionDigest(items, { site = SITE } = {}) {
  const reviewUrl = site + '/admin-area';
  const rows = items.map(({ kind, entry }) => {
    const title = kind.headline(entry.data || {}, entry.row || null);
    return '<tr>' +
      '<td style="padding:3px 12px 3px 0;vertical-align:top;white-space:nowrap;' +
        'color:#5a5f6b">' + esc(createdDay(entry.data) || '') + '</td>' +
      '<td style="padding:3px 12px 3px 0;vertical-align:top;white-space:nowrap;' +
        'color:#5a5f6b">' + esc(kind.one) + '</td>' +
      '<td style="padding:3px 0;vertical-align:top">' + esc(title || entry.id) + '</td>' +
      '</tr>';
  }).join('');

  const kinds = [...new Set(items.map((i) => i.kind.many))].join(' and ');

  const bodyHtml =
    '<p><strong>' + items.length + '</strong> new ' + esc(kinds) +
    ' have been posted through the site.</p>' +
    '<p>They came in together, so they are listed here rather than sent one by one.</p>' +
    '<table style="border-collapse:collapse;font-size:14px;margin:14px 0">' + rows + '</table>' +
    '<p><a href="' + esc(reviewUrl) + '" style="display:inline-block;background:#426394;' +
      'color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:600">' +
      'Look at them on the site</a></p>' +
    '<p style="color:#5a5f6b;font-size:13px">Nothing is waiting on you — every job posting ' +
    'is already live, and candidate profiles are held until the reveal date. Each one can be ' +
    'corrected or taken down from there.</p>';

  return {
    subject: items.length + ' new submissions on Operations Academia',
    html: shell({ title: items.length + ' new submissions', bodyHtml, manageUrl: reviewUrl }),
  };
}

/* -------------------------------------------------------------------- main */

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(path.join(DATA, file), 'utf8')); }
  catch { return fallback; }
}

async function main() {
  const db = await firestore();
  if (!db) {
    log('no Firebase credentials in this environment — nothing to do.');
    log('(this is the expected state until the project is set up: _SETUP-FIREBASE.md)');
    return 0;
  }

  const revealAt = (await readJson('candidates-reveal.json', {})).revealAt || '';
  const now = new Date();

  /* Read every kind first, so a batch spanning both is announced as ONE
     digest rather than as two that each fall under the burst threshold. */
  const all = [];
  const toStamp = [];
  for (const kind of KINDS) {
    const published = idsOf(await readJson(kind.dataset, []));
    const snap = await db.collection(kind.collection)
      .where('status', 'in', ['queued', 'published']).get();
    const entries = snap.docs.map((d) => ({ id: d.id, data: d.data() }));

    const { announce, grandfather } = partitionSubmissions(kind, entries, {
      publishedIds: published, now,
    });

    log(`${kind.collection}: ${entries.length} live, ${announce.length} not yet announced` +
        (grandfather.length
          ? `, ${grandfather.length} already on the site from before ${SINCE} (stamped, not mailed)`
          : ''));

    for (const e of announce) all.push({ kind, entry: e });
    for (const e of grandfather) toStamp.push({ kind, id: e.id });
  }

  if (SCAN) {
    for (const { kind, entry } of all) {
      log(`  ${kind.one}  ${entry.id}  ${kind.headline(entry.data || {}, entry.row)}`);
    }
    log('--scan: sent nothing, wrote nothing.');
    return 0;
  }

  /* The backlog is stamped whether or not anything is mailed: it is the one
     write that has no e-mail behind it, and leaving it undone would make every
     future run re-derive the same list. */
  if (toStamp.length && !DRY) {
    const at = new Date().toISOString();
    for (const { kind, id } of toStamp) {
      try {
        await db.collection(kind.collection).doc(id)
          .set({ [ANNOUNCED_AT]: at }, { merge: true });
      } catch (e) {
        warn(`could not stamp the already-published ${kind.one} ${id}: ${e.message}`);
      }
    }
    log(`${toStamp.length} submission(s) already on the site were stamped without an e-mail.`);
  }

  if (!all.length) return 0;

  const tx = await transport();
  if (!tx && !DRY) {
    warn('SMTP is not configured — the submissions stay unannounced and will be ' +
         'mailed once it is. See _SETUP-EMAIL.md');
    return 0;
  }

  /* A batch is one message. `at` is computed ONCE so the whole batch shares a
     mark, and a stamp that fails is warned about rather than thrown: the
     e-mail has gone, and leaving the rest unstamped would send it again. */
  if (all.length > BURST) {
    const { subject, html } = renderSubmissionDigest(all);
    if (DRY) {
      log(`--dry-run: ${all.length} submissions would go as ONE digest`);
      log('subject: ' + subject);
      log(toPlain(html));
      return 0;
    }
    try {
      await send(tx, { from: fromAddress(), to: TO, subject, html, text: toPlain(html) });
    } catch (e) {
      warn(`could not e-mail the digest: ${e.message}`);
      return 0;
    }
    const at = new Date().toISOString();
    for (const { kind, entry } of all) {
      try {
        await db.collection(kind.collection).doc(entry.id)
          .set({ [ANNOUNCED_AT]: at }, { merge: true });
      } catch (e) {
        warn(`announced ${entry.id} but could not stamp it (${e.message}) — ` +
             'it may be announced twice');
      }
    }
    log(`announced ${all.length} submission(s) as one digest.`);
    return 0;
  }

  for (const { kind, entry } of all) {
    const { subject, html } = renderSubmissionEmail(kind, entry, { revealAt });

    if (DRY) {
      log('\n--- would send ---');
      log('subject: ' + subject);
      log(toPlain(html));
      continue;
    }

    try {
      await send(tx, { from: fromAddress(), to: TO, subject, html, text: toPlain(html) });
    } catch (e) {
      /* Left unstamped on purpose, so the next run tries it again — the
         failure that matters is a submission nobody hears about. */
      warn(`could not e-mail about ${entry.id}: ${e.message}`);
      continue;
    }

    try {
      await db.collection(kind.collection).doc(entry.id)
        .set({ [ANNOUNCED_AT]: new Date().toISOString() }, { merge: true });
    } catch (e) {
      warn(`e-mailed about ${entry.id} but could not stamp it (${e.message}) — ` +
           'it may be announced twice');
    }
  }

  return 0;
}

/* ---------------------------------------------------------------- selftest */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };

  const job = KINDS.find((k) => k.key === 'job');
  const cand = KINDS.find((k) => k.key === 'candidate');

  const jobDoc = {
    id: 'j1',
    data: {
      status: 'queued', createdAt: '2026-09-02T09:00:00Z', ref: 'OA-JOB-1',
      institution: 'Tulane University', school: 'A. B. Freeman School of Business',
      unit: 'Management Science', country: 'United States', type: 'Business School',
      levels: ['Assistant Professor'], applyBy: 'Until filled.',
      adUrl: 'https://example.org/ad', year: 2027,
    },
  };
  const candDoc = {
    id: 'c1',
    data: {
      status: 'queued', createdAt: '2026-09-02T10:00:00Z',
      first: 'Ada', last: 'Lovelace', affiliation: 'Imperial College London',
      position: 'PhD Candidate', researchAreas: ['Queueing'], year: 2027,
    },
  };

  /* --- one submission ---------------------------------------------------- */
  const one = renderSubmissionEmail(job, { ...jobDoc, row: job.row(jobDoc.data) },
    { site: 'https://x.test' });
  ok(/Tulane University/.test(one.subject), 'the subject names the posting');
  ok(/job posting/.test(one.subject), 'and says what kind of thing it is');
  ok(/Management Science/.test(one.html), 'the body carries the posting itself');
  ok(/post-a-job\.html\?edit=j1/.test(one.html),
    'and links straight to the form that corrects it');
  ok(/https:\/\/x\.test\/admin-area/.test(one.html), 'and to the page listing everything waiting');
  ok(/already live/.test(one.html),
    'it says the posting is live — this is a notification, never a gate');

  /* --- a held candidate profile ----------------------------------------- */
  const held = renderSubmissionEmail(cand, { ...candDoc, row: cand.row(candDoc.data) },
    { site: 'https://x.test', revealAt: '2026-10-11' });
  ok(/Ada Lovelace/.test(held.subject), 'a profile is named in its subject');
  ok(/2026-10-11/.test(held.html) && /held until/.test(held.html),
    'and a held profile SAYS it is held — the reveal gate is why it cannot be seen on the site');
  ok(!/already live/.test(held.html), 'so it never claims to be live');
  ok(/post-a-candidate\.html\?edit=c1/.test(held.html), 'and links to its own form');

  /* --- the digest -------------------------------------------------------- */
  const many = Array.from({ length: BURST + 1 }, (_, i) => ({
    kind: job,
    entry: { id: 'j' + i, data: { ...jobDoc.data, institution: 'University ' + i }, row: null },
  }));
  const digest = renderSubmissionDigest(many, { site: 'https://x.test' });
  ok(digest.subject.startsWith(String(BURST + 1)), 'a burst is announced once, with the count');
  ok(/University 0/.test(digest.html) && new RegExp('University ' + BURST).test(digest.html),
    'and lists every one of them');
  ok(!/posted through the site[\s\S]*posted through the site/.test(digest.html),
    'said once, not once per submission');

  /* --- who is waiting ---------------------------------------------------- */
  const entries = [
    jobDoc,
    { id: 'j2', data: { ...jobDoc.data, status: 'withdrawn' } },
    { id: 'j3', data: { ...jobDoc.data, status: 'sheet' } },
    { id: 'j4', data: { ...jobDoc.data, announcedAt: '2026-09-01T00:00:00Z' } },
  ];
  const split = partitionSubmissions(job, entries, { publishedIds: new Set() });
  ok(split.announce.length === 1 && split.announce[0].id === 'j1',
    'a withdrawn submission, a sheet mirror and an already-announced one are all skipped');

  /* --- the grandfather rule --------------------------------------------- */
  const old = { id: 'j9', data: { ...jobDoc.data, createdAt: '2026-01-05T09:00:00Z' } };
  const oldRow = job.row(old.data);
  const before = partitionSubmissions(job, [old], { publishedIds: new Set([oldRow.id]) });
  ok(!before.announce.length && before.grandfather.length === 1,
    'a backlog posting the site is already showing is stamped, not mailed');
  const notShown = partitionSubmissions(job, [old], { publishedIds: new Set() });
  ok(notShown.announce.length === 1,
    'but one the site is NOT showing is announced — that is the held candidate case');
  const fresh = partitionSubmissions(job, [jobDoc], {
    publishedIds: new Set([job.row(jobDoc.data).id]), since: '2026-08-19',
  });
  ok(fresh.announce.length === 1,
    'and a NEW posting the build has already published is still announced — the date is ' +
    'what stops "already on the site" swallowing it');

  /* --- order ------------------------------------------------------------- */
  const ordered = partitionSubmissions(job, [
    { id: 'b', data: { ...jobDoc.data, createdAt: '2026-09-05T09:00:00Z' } },
    { id: 'a', data: { ...jobDoc.data, createdAt: '2026-09-01T09:00:00Z' } },
  ], { publishedIds: new Set() });
  ok(ordered.announce.map((e) => e.id).join('') === 'ab',
    'a backlog is worked through oldest first, in the order it arrived');

  console.log(fails.length
    ? `submissions-mailer selftest: ${pass} passed, ${fails.length} FAILED\n  ` + fails.join('\n  ')
    : `submissions-mailer selftest: ${pass} checks passed.`);
  return fails.length === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (has('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  } else {
    try {
      process.exit(await main());
    } catch (e) {
      console.log('::error::' + (e.stack || e.message));
      process.exit(1);
    }
  }
}
