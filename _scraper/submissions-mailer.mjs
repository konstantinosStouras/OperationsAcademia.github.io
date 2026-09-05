#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — tell the maintainer somebody has posted something.

       jobSubmissions       \                        the maintainer looks at it
                              ->  THIS  -> (1) ->  on /admin-area
       candidateSubmissions /             \
                                           (2) ->  the POSTER hears that their
                                                   posting is publicly shown

   TWO MESSAGES, TWO AUDIENCES, ONE READ. (1) is the maintainer's notice that
   somebody has posted something — and, since 2026-08-29, it says WHO
   (`postedBy`): a person's name and address, or the crawler and the workbook
   it read. (2) is the poster's own, sent once their posting is really on the
   site, thanking them and showing them what a visitor now sees. They share
   this run's two reads and nothing else: separate recipients, separate
   renderers, separate high-water marks.

   WHAT WAS MISSING. The tracking sheet's postings are announced
   (jobreview-mailer.mjs) and everything posted through the site's own forms
   was not — a job posting, and a candidate profile, arrived in Firestore, were
   published by the next build, and nothing said so. For candidates that was
   the worse half: their profiles are held behind the reveal date, so they are
   in no served file and drew no card anywhere on the site. Two of them had
   been sitting there.

   ONE E-MAIL PER SUBMISSION, and `announcedAt` on the document is the
   high-water mark (`liveMailedAt` for the poster's), so nothing is sent twice and a run that dies half-way
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

import { isMain } from './_main.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  KINDS, SINCE, ANNOUNCED_AT, LIVE_SINCE, LIVE_MAILED_AT,
  partitionSubmissions, partitionLive, idsOf, servedIndex, createdDay,
} from './submissions-review.mjs';
import { postedBy, longDate, marketLabel, assignIds } from './jobs-model.mjs';
import {
  shell, esc, safeUrl, send, transport, toPlain, firestore, fromAddress, SITE, CONTACT,
} from './_mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* WHEN the candidate profiles go public: 14:00 UTC on the reveal day, decided
   in assets/oa-reveal.js (the build's own gate calls it), so this e-mail says
   "held" exactly while the build is holding and not a moment longer. */
const OAReveal = createRequire(import.meta.url)('../assets/oa-reveal.js');
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
 * WHO posted it — the line the owner asked for (2026-08-29): a person's name
 * and the address they gave, so the maintainer's inbox answers "who sent
 * this?" without their opening the Admin area and finding the card.
 *
 * TO THE MAINTAINER AND NOBODY ELSE — the owner's own "(and only)". This
 * message goes to one address, the one `isAdmin()` authorises for every admin
 * surface on the site; the poster's address is never in a served file
 * (PUBLIC_FIELDS), never on a public page, and never in the e-mail the POSTER
 * receives. It is a `mailto:` so replying to the person is one click rather
 * than a copy-paste out of a table.
 *
 * `postedBy` is the shared rule (jobs-model.mjs), so this e-mail and the
 * review queue's cannot disagree about what a source is called — and a
 * tracking-sheet MIRROR the maintainer has taken over reads as the crawler's
 * row that it is, rather than as somebody's submission with no name on it.
 */
function postedByHtml(doc) {
  const who = postedBy(doc);
  const shown = who.email
    ? (who.name ? esc(who.name) + ' ' : '') +
      '<a href="mailto:' + esc(who.email) + '">' + esc(who.email) + '</a>'
    : esc(who.text);
  return '<p style="margin:0 0 14px;color:#5a5f6b;font-size:13px">' +
    '<strong style="color:#222">Posted by:</strong> ' + shown + '</p>';
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
export function renderSubmissionEmail(kind, entry,
  { site = SITE, revealAt = '', now = new Date() } = {}) {
  const doc = entry.data || {};
  const row = entry.row || null;
  const title = kind.headline(doc, row);
  const reviewUrl = site + '/admin-area';
  const editUrl = site + '/' + kind.editPath + encodeURIComponent(entry.id);

  /* held only while the reveal instant is still ahead, asked of the module:
     a profile is live from 14:00 UTC on the reveal day like any posting, and
     an e-mail sent after that must not go on calling it held. With NO date
     announced (describeReveal answers null) every profile is held, exactly as
     the build's gate holds them; reading that as live would tell the
     maintainer a profile is on the site in the one state where none is. */
  const when = kind.key === 'candidate' ? OAReveal.describeReveal(revealAt, { now }) : null;
  const held = kind.key === 'candidate' && !(when && when.revealed);

  const bodyHtml =
    '<p>A <strong>' + esc(kind.one) + '</strong> has been posted through the site.</p>' +
    postedByHtml(doc) +
    '<table style="border-collapse:collapse;font-size:14px;margin:14px 0">' +
      kind.summarise(doc, row).map(([l, v]) => line(l, v)).join('') +
      line('Posted', createdDay(doc)) +
      line('Reference', doc.ref || '') +
    '</table>' +
    (held
      ? '<p style="color:#5a5f6b;font-size:13px">Candidate profiles are held until <strong>' +
        esc(when ? when.utc + ' on ' + when.dayLong : 'the reveal date is announced') +
        '</strong> and appear all at once at that moment, so this one is not on the site ' +
        'and cannot be seen there yet, which is why it is worth reading here.</p>'
      : '<p style="color:#5a5f6b;font-size:13px">It is already live, or will be within a ' +
        'minute of the next build. Nothing is waiting on you; this is so you know it ' +
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
  /* WHO, per row: a digest is still the only thing the maintainer reads about
     these, so the answer cannot be dropped for arriving in company. Plain
     text rather than a mailto here — twelve links in a list is a wall of
     blue, and the per-submission card is one click away. */
  const rows = items.map(({ kind, entry }) => {
    const title = kind.headline(entry.data || {}, entry.row || null);
    const who = postedBy(entry.data || {});
    return '<tr>' +
      '<td style="padding:3px 12px 3px 0;vertical-align:top;white-space:nowrap;' +
        'color:#5a5f6b">' + esc(createdDay(entry.data) || '') + '</td>' +
      '<td style="padding:3px 12px 3px 0;vertical-align:top;white-space:nowrap;' +
        'color:#5a5f6b">' + esc(kind.one) + '</td>' +
      '<td style="padding:3px 12px 3px 0;vertical-align:top">' +
        esc(title || entry.id) + '</td>' +
      '<td style="padding:3px 0;vertical-align:top;color:#5a5f6b">' +
        esc(who.text) + '</td>' +
      '</tr>';
  }).join('');

  const kinds = [...new Set(items.map((i) => i.kind.many))].join(' and ');

  const bodyHtml =
    '<p><strong>' + items.length + '</strong> new ' + esc(kinds) +
    ' have been posted through the site.</p>' +
    '<p>They came in together, so they are listed here rather than sent one by one.</p>' +
    '<table style="border-collapse:collapse;font-size:14px;margin:14px 0">' +
      '<tr>' + ['Posted', 'Kind', 'What', 'Posted by'].map((h) =>
        '<th style="text-align:left;padding:0 12px 4px 0;font-weight:600;color:#222;' +
        'white-space:nowrap">' + esc(h) + '</th>').join('') + '</tr>' +
      rows + '</table>' +
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

/* ------------------------------------------- the poster's own e-mail

   Owner, 2026-08-29. Everything above this line goes to the maintainer; this
   one goes to the person who filled the form in, once their posting is really
   on the site. See `partitionLive` in submissions-review.mjs for WHEN, which
   is the half that matters — the message is only honest because the condition
   is "the row is in the served file this run just read".                   */

/** WHICH PAGE the posting is on, and the link that opens THAT one — the site's
    own `OAJobNav`, so the address in the e-mail is the address the Admin
    area's cards use and the jobs page's `?job=` focus understands. A posting
    whose season has rolled lives on Previous markets, and a link to the jobs
    page would open a list that cannot contain it. */
const JOBNAV = createRequire(import.meta.url)('../assets/oa-jobnav.js');

/** The one link a poster is given for their own posting. */
export function livePostingUrl(row, { site = SITE, now = new Date() } = {}) {
  return site + '/' + JOBNAV.hrefFor(row || {}, now);
}

/**
 * "Your posting is on the site" — sent once, to the person who posted it.
 *
 * WHAT IT SHOWS IS WHAT THE SITE SHOWS. The row comes from `data/jobs.json`,
 * not from their document, so a name the build canonicalised, a deadline it
 * healed and the market years it derived all read here exactly as a visitor
 * reads them — and if any of that is wrong, the same message is where they
 * find the link to correct it.
 *
 * WHAT IT DOES NOT SHOW is anything private. Their own address is not quoted
 * back at them (it tells them nothing, and this is a message people forward),
 * and the chair's name and address they gave us are ADMIN-ONLY by the same
 * `PUBLIC_FIELDS` rule that keeps them out of `data/` — so the summary is
 * built from the SERVED row and can only ever contain published fields.
 */
export function renderLivePostingEmail(entry, { site = SITE, now = new Date() } = {}) {
  const doc = entry.data || {};
  const r = entry.published || entry.row || {};
  const title = [r.institution, r.department].filter(Boolean).join(' — ');
  const url = livePostingUrl(r, { site, now });
  const editUrl = site + '/post-a-job.html?edit=' + encodeURIComponent(entry.id);
  const mineUrl = site + '/my-postings.html';
  const ad = safeUrl(r.adUrl);

  const first = String(doc.firstName || '').trim();
  const hello = first ? 'Dear ' + esc(first) + ',' : 'Hello,';

  /* The seasons the posting is listed under — `years` is the SPAN, and a
     search advertised in one season that closes in the next is genuinely on
     both pages, so saying only one of them would be wrong. */
  const years = Array.isArray(r.years) && r.years.length
    ? r.years : (r.year ? [r.year] : []);
  const seasons = years.map((y) => marketLabel(Number(y))).join(' and ');

  const bodyHtml =
    '<p>' + hello + '</p>' +
    '<p>Your job posting is now <strong>live on operationsacademia.org</strong> ' +
    'and can be seen by everyone visiting the site.</p>' +
    '<p><a href="' + esc(url) + '" style="display:inline-block;background:#426394;' +
      'color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:600">' +
      'See your posting on the site</a></p>' +
    '<p style="margin:18px 0 6px;font-weight:600">Your posting, as it appears</p>' +
    '<table style="border-collapse:collapse;font-size:14px;margin:0 0 14px">' +
      line('Institution', r.institution) +
      line('School / department', r.department) +
      line('Type', r.type) +
      line('Entry level', (r.levels || []).join(', ')) +
      line('Country', r.country) +
      line('Advertised', /^\d{4}-\d{2}-\d{2}$/.test(String(r.posted || ''))
        ? longDate(r.posted) : r.posted) +
      line('Listed under', seasons) +
      line('Suggested apply by', r.reviewDate ? longDate(r.reviewDate) : '') +
      line('Final apply by', r.applyBy) +
      line('Advertisement', ad) +
      line('Reference', doc.ref || r.ref || '') +
    '</table>' +
    '<p>Thank you for using <strong>OperationsAcademia.org</strong>. We wish you ' +
    'every success with your search, and hope you fill the position with an ' +
    'excellent candidate.</p>' +
    '<p style="color:#5a5f6b;font-size:13px">Something to change? You can ' +
    '<a href="' + esc(editUrl) + '">correct this posting</a> at any time, and ' +
    '<a href="' + esc(mineUrl) + '">My postings</a> lists everything you have ' +
    'posted — corrections and takedowns reach the site within a few minutes. ' +
    'Please quote the reference above if you write to us about it.</p>';

  return {
    subject: 'Your job posting is live: ' + (title || r.id || 'Operations Academia'),
    html: shell({ title: 'Your job posting is live', bodyHtml, manageUrl: null }),
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
  /* The approved name corrections the BUILD applies (data/name-fixes.json).
     Passed on so a row derived here cannot differ from the row the build
     published — it only matters on the derived-id fallback, which is exactly
     where a divergence would be silent. */
  const fixes = (await readJson('name-fixes.json', {})).fixes || [];
  const now = new Date();

  /* Read every kind first, so a batch spanning both is announced as ONE
     digest rather than as two that each fall under the burst threshold.

     TWO PASSES OFF ONE READ. The maintainer's announcement and the poster's
     "it is live now" both need the same two things — the live documents and
     the served dataset — so they are derived together and sent separately.
     Each keeps its OWN high-water mark, so neither can suppress the other. */
  const all = [];
  const toStamp = [];
  const live = [];
  const liveStamp = [];
  for (const kind of KINDS) {
    const rows = await readJson(kind.dataset, []);
    const published = idsOf(rows);
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

    /* …and who is owed a thank-you. `published` here is the ROW, not the id:
       the poster is shown what the site shows. */
    /* The two-way index: a submission is joined to its row by the REFERENCE
       the form issued, never by a re-derived id — see `matchServed`. */
    const told = partitionLive(kind, entries, { published: servedIndex(rows), now, fixes });
    if (kind.tellsPoster) {
      log(`${kind.collection}: ${told.mail.length} poster(s) to tell their posting is live` +
          (told.grandfather.length
            ? `, ${told.grandfather.length} posted before ${LIVE_SINCE} (stamped, not mailed)`
            : ''));
    }
    for (const e of told.mail) live.push({ kind, entry: e });
    for (const e of told.grandfather) liveStamp.push({ kind, id: e.id });
  }

  if (SCAN) {
    /* THE DOCUMENT, NEVER THE PERSON. --scan prints into the Actions log of
       a public repository, and a candidate's headline is their NAME — for a
       profile held behind the reveal date, a name that is by design in no
       served file. A job posting's headline names a university and a
       department, which the site publishes anyway. */
    for (const { kind, entry } of all) {
      log(`  to the maintainer: ${kind.one}  ${entry.id}  ` +
          `${kind.tellsPoster ? kind.headline(entry.data || {}, entry.row) : '(held)'}`);
    }
    for (const { kind, entry } of live) {
      log(`  to the poster: ${kind.one}  ${entry.id}  ` +
          `${kind.headline(entry.data || {}, entry.row)}`);
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

  /* The same rule for the poster's mark, and for the same reason: the backlog
     that predates the feature is written off once, silently, rather than
     re-derived by every run for ever. */
  if (liveStamp.length && !DRY) {
    const at = new Date().toISOString();
    for (const { kind, id } of liveStamp) {
      try {
        await db.collection(kind.collection).doc(id)
          .set({ [LIVE_MAILED_AT]: at }, { merge: true });
      } catch (e) {
        warn(`could not stamp the pre-${LIVE_SINCE} ${kind.one} ${id}: ${e.message}`);
      }
    }
    log(`${liveStamp.length} posting(s) from before ${LIVE_SINCE} were stamped ` +
        'without thanking anybody.');
  }

  if (!all.length && !live.length) return 0;

  const tx = await transport();
  if (!tx && !DRY) {
    warn('SMTP is not configured — the submissions stay unannounced, the posters ' +
         'unthanked, and both are mailed once it is. See _SETUP-EMAIL.md');
    return 0;
  }

  await announceToMaintainer(db, tx, all, revealAt);
  await thankPosters(db, tx, live);
  return 0;
}

/**
 * The maintainer's announcement — a digest for a batch, one card each
 * otherwise.
 *
 * A batch is one message. `at` is computed ONCE so the whole batch shares a
 * mark, and a stamp that fails is warned about rather than thrown: the e-mail
 * has gone, and leaving the rest unstamped would send it again.
 */
async function announceToMaintainer(db, tx, all, revealAt) {
  if (!all.length) return;

  if (all.length > BURST) {
    const { subject, html } = renderSubmissionDigest(all);
    if (DRY) {
      /* The subject and the ids only: the body carries every poster's
         address ("Posted by: …") and every held candidate's name, and a
         dispatched dry run prints into a public Actions log. */
      log(`--dry-run: ${all.length} submissions would go as ONE digest`);
      log('subject: ' + subject);
      log('for: ' + all.map((x) => `${x.kind.one} ${x.entry.id}`).join(', '));
      return;
    }
    try {
      await send(tx, { from: fromAddress(), to: TO, subject, html, text: toPlain(html) });
    } catch (e) {
      warn(`could not e-mail the digest: ${e.message}`);
      return;
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
    return;
  }

  for (const { kind, entry } of all) {
    const { subject, html } = renderSubmissionEmail(kind, entry, { revealAt });

    if (DRY) {
      log(`\n--- would send to the maintainer about ${kind.one} ${entry.id} ---`);
      log('subject: ' + subject);   // the body names the poster — see the digest branch
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
}

/**
 * …and the poster hears that their posting is on the site.
 *
 * ONE AT A TIME, NEVER A DIGEST. The maintainer's messages are batched above a
 * burst because they are all one person's inbox and one person's decisions;
 * these go to a different person each, so there is nothing to batch — and a
 * poster is written to exactly once, whatever else the run is doing.
 *
 * `Reply-To` is the maintainer, because a poster's natural reply to "your
 * posting is live" is a question about it, and the send address is a mailbox
 * nobody reads.
 *
 * SENT FIRST, STAMPED AFTER, like every other mark here — the failure that
 * matters is a poster who is never told, and a duplicate after a crash between
 * the two is the lesser one.
 */
async function thankPosters(db, tx, live) {
  if (!live.length) return;

  let sent = 0;
  for (const { kind, entry } of live) {
    const { subject, html } = renderLivePostingEmail(entry);

    if (DRY) {
      /* The DOCUMENT, never the address. A dispatched --dry-run prints into
         the Actions log of a PUBLIC repository, and this is the one line here
         that holds a real person's e-mail — the same "nothing public may carry
         an address" rule the served files are held to. */
      log(`\n--- would send to the poster of ${entry.id} ---`);
      log('subject: ' + subject);   // the body is the served row, which is public
      continue;
    }

    try {
      await send(tx, { from: fromAddress(), to: entry.to, replyTo: CONTACT,
                       subject, html, text: toPlain(html) });
    } catch (e) {
      /* Unstamped on purpose: the next run tries again. */
      warn(`could not tell the poster of ${entry.id} that it is live: ${e.message}`);
      continue;
    }

    try {
      await db.collection(kind.collection).doc(entry.id)
        .set({ [LIVE_MAILED_AT]: new Date().toISOString() }, { merge: true });
    } catch (e) {
      warn(`told the poster of ${entry.id} but could not stamp it (${e.message}) — ` +
           'they may be told twice');
    }
    sent++;
  }

  if (DRY) log(`--dry-run: would have told ${live.length} poster(s).`);
  else log(`told ${sent} poster(s) their posting is live.`);
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
      source: 'oa-form', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.edu',
      institution: 'Tulane University', school: 'A. B. Freeman School of Business',
      unit: 'Management Science', country: 'United States', type: 'Business School',
      levels: ['Assistant Professor'], applyBy: 'Until filled.', untilFilled: true,
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
    { site: 'https://x.test', revealAt: '2026-10-11', now: new Date('2026-10-11T13:59:59Z') });
  ok(/Ada Lovelace/.test(held.subject), 'a profile is named in its subject');
  ok(/11 October 2026/.test(held.html) && /14:00 UTC/.test(held.html) && /held until/i.test(held.html),
    'and a held profile SAYS it is held, naming the instant (14:00 UTC on the day): the ' +
    'reveal gate is why it cannot be seen on the site');
  ok(!/already live/.test(held.html), 'so it never claims to be live');
  ok(/post-a-candidate\.html\?edit=c1/.test(held.html), 'and links to its own form');
  /* the clock is injected, so the boundary is pinned to the second rather
     than read off the calendar the day this runs */
  const out = renderSubmissionEmail(cand, { ...candDoc, row: cand.row(candDoc.data) },
    { site: 'https://x.test', revealAt: '2026-10-11', now: new Date('2026-10-11T14:00:00Z') });
  ok(!/held until/i.test(out.html) && /already live/.test(out.html),
    'from the instant on a profile is live like any posting, and the e-mail stops saying held');
  /* no date announced at all: the build holds every profile, so the e-mail
     must say held, never live (it said live, once) */
  const undated = renderSubmissionEmail(cand, { ...candDoc, row: cand.row(candDoc.data) },
    { site: 'https://x.test', revealAt: '', now: new Date('2026-10-11T14:00:00Z') });
  ok(/held until/i.test(undated.html) && /the reveal date is announced/.test(undated.html),
    'with no reveal date announced a profile is held until one is, as the build holds it');
  ok(!/already live/.test(undated.html), 'and is never called live');
  const undatedJob = renderSubmissionEmail(job, { ...jobDoc, row: job.row(jobDoc.data) },
    { site: 'https://x.test', revealAt: '' });
  ok(/already live/.test(undatedJob.html) && !/held until/i.test(undatedJob.html),
    'a job posting with no reveal date is live: the gate is for candidates only');

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

  /* --- WHO posted it (owner, 2026-08-29) --------------------------------- */
  ok(/Posted by:/.test(one.html), 'the maintainer is told who posted it');
  ok(/Ada Lovelace/.test(one.html) && /ada@x\.edu/.test(one.html),
    'by name and by the address they gave');
  ok(/mailto:ada@x\.edu/.test(one.html), 'as a mailto, so replying is one click');
  const crawled = renderSubmissionEmail(job, {
    id: 'm1',
    data: { ...jobDoc.data, source: 'jobmarket-sheet',
            firstName: '', lastName: '', email: '', authEmail: '' },
    row: null,
  }, { site: 'https://x.test' });
  ok(/auto-crawler from the OM Job Market tracking sheet/.test(crawled.html),
    'and a claimed tracking-sheet mirror reads as the crawler, not as a nameless person');
  ok(/Posted by/.test(digest.html) &&
     (digest.html.match(/Ada Lovelace/g) || []).length === BURST + 1,
    'a digest answers the same question for every row — it is the only thing sent ' +
    'about those');

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

  /* --- the POSTER's own e-mail (owner, 2026-08-29) ------------------------ */

  /* Built the way the mailer builds it: the served row, keyed by id, is what
     decides "publicly shown" AND what the message prints. */
  const liveDoc = {
    id: 'j7',
    data: { ...jobDoc.data, createdAt: LIVE_SINCE + 'T09:00:00Z',
            firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.edu',
            chairName: 'Grace Hopper', chairEmail: 'grace@x.edu',
            note: 'call me on 555 1234' },
  };
  const liveRow = job.row(liveDoc.data);
  const shown = servedIndex([liveRow]);

  const told = partitionLive(job, [liveDoc], { published: shown });
  ok(told.mail.length === 1 && told.mail[0].to === 'ada@x.edu',
    'a posting the site is showing means its poster is written to, at the address they gave');

  const post = renderLivePostingEmail(told.mail[0], { site: 'https://x.test' });
  ok(/Your job posting is live/.test(post.subject) && /Tulane/.test(post.subject),
    'the subject says what it is and names the posting');
  ok(/Dear Ada,/.test(post.html), 'it greets them by name');
  ok(/live on operationsacademia\.org/.test(post.html),
    'and says the posting is publicly shown, which is the whole trigger');
  ok(/Thank you for using/.test(post.html) && /OperationsAcademia\.org/.test(post.html),
    'it thanks them for using the site, in the owner\'s own words');
  ok(/wish you/.test(post.html) && /fill the position/.test(post.html),
    'and wishes them well filling the position');
  ok(/Management Science/.test(post.html) && /Until filled/.test(post.html),
    'the details of the posting are in it');
  ok(post.html.includes('https://x.test/jobs.html?job=' + liveRow.id),
    'with a link to the posting itself, on the page that carries it');
  ok(/post-a-job\.html\?edit=j7/.test(post.html) && /my-postings\.html/.test(post.html),
    'and a way to correct it');

  /* THE POSTER'S E-MAIL CARRIES NOTHING PRIVATE. It is built from the SERVED
     row, so the fields PUBLIC_FIELDS keeps out of data/ cannot reach it — the
     chair's name and address, the private note, and the poster's own address,
     which tells them nothing and is exactly what a forwarded message should
     not carry. */
  for (const secret of ['grace@x.edu', 'Grace Hopper', '555 1234', 'ada@x.edu']) {
    ok(!post.html.includes(secret),
      `the poster's e-mail never carries ${secret} — it is built from the published row`);
  }

  /* A ROLLED SEASON IS ON THE OTHER PAGE. Linking a 2024 posting to jobs.html
     opens a list that by definition cannot contain it — the exact defect
     oa-jobnav.js was written for. */
  const rolled = { id: 'old-1', year: 2024, years: [2024], posted: '2023-09-01',
                   applyByDate: '2023-11-01', institution: 'Old University' };
  ok(livePostingUrl(rolled, { site: 'https://x.test' })
       .startsWith('https://x.test/previous-markets.html?job='),
    'a posting whose season has rolled is linked on the archive, not the jobs page');

  /* --- and it is sent ONCE ------------------------------------------------ */
  ok(!partitionLive(job, [{ ...liveDoc, data: { ...liveDoc.data, [LIVE_MAILED_AT]: 'x' } }],
    { published: shown }).mail.length,
    'a poster already told is never told again — which is what makes an EDIT safe, ' +
    'since correcting a posting re-publishes it');
  ok(!partitionLive(job, [liveDoc], { published: servedIndex([]) }).mail.length,
    'and a posting the site is NOT showing yet is not announced as live');
  ok(!partitionLive(job, [{ ...liveDoc, data: { ...liveDoc.data, status: 'withdrawn' } }],
    { published: shown }).mail.length, 'a withdrawn posting thanks nobody');
  const noAddress = partitionLive(job, [{ id: 'j8',
    data: { ...liveDoc.data, email: '', authEmail: '' } }], { published: shown });
  ok(!noAddress.mail.length && !noAddress.grandfather.length,
    'a submission with no reachable address is skipped ENTIRELY — never stamped, ' +
    'so an address added by a later correction can still be written to');

  /* --- SAME-DAY SIBLINGS ARE NOT CROSS-WIRED ------------------------------
     The defect this pass shipped with, and the reason the guard below drives
     the REAL assignIds: jobId is (year, institution, posted) with no
     department, so three colleagues posting on one day derive ONE id, the
     build renumbers them -2/-3, and a pass that re-derived the id sent every
     one of them the first poster's posting. The old fixture built its served
     row by calling the very function under test, so assignIds never ran and
     no collision could occur. */
  const TRIO = ['Information Systems', 'Management Science', 'Finance'];
  const sibs = TRIO.map((unit, i) => ({
    id: 'sib' + i,
    data: { ...liveDoc.data, unit, ref: 'OA-JOB-SIB-' + i,
            email: `poster${i}@x.edu`, chairEmail: '', chairName: '', note: '' },
  }));
  const sibRows = assignIds(sibs.map((d) => ({ row: job.row(d.data) })))
    .map((e) => e.row || e);
  ok(new Set(sibRows.map((r) => r.id)).size === 3
     && sibRows.some((r) => /-2$/.test(r.id)) && sibRows.some((r) => /-3$/.test(r.id)),
    'the build really does renumber same-day siblings — the fixture reproduces production');

  const trio = partitionLive(job, sibs, { published: servedIndex(sibRows) });
  ok(trio.mail.length === 3, 'all three siblings are due');
  ok(trio.mail.every((m) => m.published.ref === m.data.ref),
    'and EACH is matched to its OWN row — the reference the form issued is the join key, ' +
    'never a re-derived id that three postings share');
  ok(new Set(trio.mail.map((m) => m.published.id)).size === 3,
    'so no two posters are pointed at one card');
  for (const m of trio.mail) {
    const mail = renderLivePostingEmail(m, { site: 'https://x.test' });
    ok(mail.subject.includes(m.data.unit),
      `poster of "${m.data.unit}" is sent their own posting, not a sibling's`);
    ok(mail.html.includes('?job=' + m.published.id), 'and linked to their own card');
  }

  /* NOT SURE MEANS DO NOTHING — never a guess, and never a stamp, so a
     collision costs a delayed e-mail rather than a wrong one. */
  const orphan = partitionLive(job, [{ id: 'o1',
    data: { ...liveDoc.data, ref: 'OA-JOB-NOT-PUBLISHED' } }], { published: servedIndex(sibRows) });
  ok(!orphan.mail.length && !orphan.grandfather.length,
    'a submission whose reference the served file does not carry is passed over ENTIRELY — ' +
    'not matched to a same-day neighbour, and not stamped either');

  /* `publishedId` — the id the build really published — is the second chance
     for a document with no reference of its own. */
  const byPub = partitionLive(job, [{ id: 'p1',
    data: { ...liveDoc.data, ref: '', publishedId: sibRows[2].id } }],
    { published: servedIndex(sibRows) });
  ok(byPub.mail.length === 1 && byPub.mail[0].published.id === sibRows[2].id,
    'a ref-less document is matched by the publishedId the build stamped on it');

  /* …and the derived id is the last resort, refused the moment it is
     ambiguous or lands on a row that belongs to somebody with a reference. */
  const refless = TRIO.slice(0, 2).map((unit, i) => ({
    id: 'rl' + i, data: { ...liveDoc.data, unit, ref: '', email: `rl${i}@x.edu` } }));
  ok(!partitionLive(job, refless, { published: servedIndex(sibRows) }).mail.length,
    'two ref-less submissions deriving one id are both passed over, never both mailed ' +
    'the same row');

  /* --- a crawled posting thanks nobody ------------------------------------ */
  ok(!partitionLive(job, [{ id: 'mirror',
    data: { ...liveDoc.data, source: 'jobmarket-sheet' } }],
    { published: servedIndex([liveRow]) }).mail.length,
    'a tracking-sheet mirror the maintainer has claimed is never thanked for posting it — ' +
    'it is the crawler\'s row, and they run the site');

  /* --- the grandfather rule, again, and for its own date ------------------ */
  const older = { id: 'j9', data: { ...liveDoc.data, createdAt: '2026-01-05T09:00:00Z' } };
  const back = partitionLive(job, [older], { published: servedIndex([job.row(older.data)]) });
  ok(!back.mail.length && back.grandfather.length === 1,
    'a posting from before the feature shipped is stamped, not mailed — the backlog is ' +
    'not a reason to write to a year of posters');
  ok(LIVE_SINCE !== SINCE,
    'and it has its own date: two features with two ship dates cannot share one');

  /* --- a candidate profile is not a job posting ---------------------------
     THE SERVED SET HERE MUST CONTAIN THE PROFILE'S OWN ROW. Passing an empty
     one made this pass for the wrong reason: with nothing published, no kind
     could produce mail, so the check could not tell "candidates are excluded"
     from "nothing matched" — flipping `tellsPoster: true` onto the candidate
     kind left it green. Everything else it needs is here too (an address, a
     date after LIVE_SINCE, a live status), so the ONLY thing standing between
     this profile and an e-mail is the capability flag. */
  const candLive = { ...candDoc,
    data: { ...candDoc.data, email: 'ada@x.edu', ref: 'OA-CAND-1',
            createdAt: LIVE_SINCE + 'T09:00:00Z' } };
  const candRow = cand.row(candLive.data);
  ok(candRow && candRow.ref === 'OA-CAND-1',
    'the fixture really produces a matchable candidate row');
  ok(!partitionLive(cand, [candLive], { published: servedIndex([candRow]) }).mail.length,
    'candidate profiles are held until the reveal date, so nothing here claims one is live — ' +
    'and this is measured against a served set that WOULD match, so only tellsPoster stops it');
  ok(partitionLive({ ...cand, tellsPoster: true }, [candLive],
    { published: servedIndex([candRow]) }).mail.length === 1,
    '…proved by the capability alone flipping the answer');

  console.log(fails.length
    ? `submissions-mailer selftest: ${pass} passed, ${fails.length} FAILED\n  ` + fails.join('\n  ')
    : `submissions-mailer selftest: ${pass} checks passed.`);
  return fails.length === 0;
}

if (isMain(import.meta.url)) {
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
