#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — tell the maintainer a posting is waiting for them.

       jobReviews (Firestore)  ->  THIS  ->  one e-mail per queued posting
                                                       |
                                          the maintainer approves it at
                                          operationsacademia.org/admin-area

   ONE E-MAIL PER POSTING, by the owner's choice: a queued posting is a single
   decision to make, and a digest of six turns six decisions into one thing to
   scroll. `mailedAt` on the document is the high-water mark, so nothing is
   ever announced twice and a run that dies half-way resumes rather than
   repeats.

   WITH ONE EXCEPTION, ABOVE `BURST`. That choice was made about six postings,
   and the queue does not always arrive six at a time: the morning the sheet's
   "2026 Jobs" tab was first read properly it had eighty-nine postings on it,
   and a whole workbook in scope holds several hundred. One e-mail each would
   be a mail bomb from the site's own address, and the provider would rate-limit
   it half way through — so a burst is announced ONCE, as a list, with the
   count in the subject. Everything else is unchanged: the same high-water
   mark, stamped per document, so a burst digest and the per-posting e-mails
   can never announce the same posting twice.

   IT IS A NO-OP UNTIL IT IS CONFIGURED, exactly like alerts-mailer.mjs and
   feedback-mailer.mjs: without FIREBASE_SERVICE_ACCOUNT there is no queue to
   read, and without SMTP_* there is nowhere to send. Both states say so and
   exit 0, so the workflow can be scheduled before either exists.

   THE WRITE ORDER IS DELIBERATE: the e-mail is sent FIRST and `mailedAt`
   stamped after. The failure that matters is a posting nobody hears about; a
   duplicate e-mail after a crash between the two is a nuisance, and the
   nuisance is the right way round.

   Modes:
     --scan       list what would be mailed, send nothing, write nothing
     --dry-run    render the e-mails and print them, send nothing
     --selftest   offline checks, no network, no credentials
   --------------------------------------------------------------------------- */

import { isMain } from './_main.mjs';
import { COLLECTION, needMail, applyEdits } from './jobreview.mjs';
import { longDate } from './jobs-model.mjs';
import {
  shell, esc, send, transport, toPlain, firestore, fromAddress, SITE, CONTACT,
} from './_mail.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const SCAN = has('--scan');
const DRY = has('--dry-run');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/** Where "a posting is waiting" goes. The maintainer's own address, which is
    also the one the review page is gated on. */
const TO = process.env.JOBREVIEW_ALERT_TO || CONTACT;

/** More than this many waiting at once is a batch arriving, not the market
    ticking over, and is announced as one list. Twelve: comfortably above a
    busy morning's trickle, far below the eighty-nine a single tab can bring. */
export const BURST = Number(process.env.JOBREVIEW_BURST) || 12;

/* ---------------------------------------------------------------- rendering */

/** The row as it would be published, so the e-mail shows what approving would
    actually put on the site rather than the raw sheet row. */
function shown(doc) {
  return applyEdits(doc.row || {}, doc.edits);
}

function line(label, value) {
  if (!value) return '';
  return '<tr><th style="text-align:left;padding:3px 12px 3px 0;vertical-align:top;' +
    'font-weight:600;color:#5a5f6b;white-space:nowrap">' + esc(label) +
    '</th><td style="padding:3px 0;vertical-align:top">' + esc(value) + '</td></tr>';
}

/** The possible duplicates the sync found — postings ALREADY on the site this
    crawled one may repeat. Said in the e-mail because the decision it informs
    is exactly the one the e-mail asks for. */
function dupHtml(doc) {
  const dups = Array.isArray(doc.dup) ? doc.dup : [];
  if (!dups.length) return '';
  const items = dups.map((d) =>
    '<li>' + esc([d.institution, d.department].filter(Boolean).join(' — ') || d.id) +
    (d.posted ? ' <span style="color:#5a5f6b">(posted ' + esc(d.posted) + ')</span>' : '') +
    '</li>').join('');
  return '<p style="background:#fff8e6;border:1px solid #e6c866;border-radius:6px;' +
    'padding:10px 14px">&#9888; <strong>Possibly already on the site</strong> — this ' +
    'looks like it may duplicate:</p>' +
    '<ul style="margin:6px 0 14px;padding-left:22px">' + items + '</ul>';
}

/** The business-school flag the sync computed — the posting's text says
    "business", so it arrived typed Business School, and the site's own
    directory is asked which school that IS at this university. Said in the
    e-mail for the dupHtml reason: it informs exactly the decision the e-mail
    asks for. */
function bizHtml(doc) {
  const biz = doc && doc.biz;
  if (!biz) return '';
  const school = String(biz.school || '');
  return '<p style="background:#eef4fb;border:1px solid #b8cbe4;border-radius:6px;' +
    'padding:10px 14px">&#127891; <strong>Business school posting</strong> — its text ' +
    'mentions the business school, so it is flagged under Type: Business School. ' +
    (school
      ? 'The site lists <strong>' + esc(school) + '</strong> as this university’s ' +
        'business school.'
      : 'The site’s directory does not list a business school for this university.') +
    '</p>';
}

/** What the posting's OWN advertisement says — read off the linked page by
    adverts-verify.mjs and stored on the document as `ad`. Said in the e-mail
    for the dupHtml reason: the closing date, and whether the listing is even
    still up, inform exactly the decision the e-mail asks for. `listedUntil`
    is deliberately not repeated here — on a board it is when the AD comes
    down, not the deadline, and the card labels it properly. */
function advertHtml(doc) {
  const ad = doc && doc.ad;
  if (!ad) return '';
  const gone = ad.status === 'gone';
  const bits = [];
  if (ad.title) {
    bits.push('it advertises <strong>' + esc(ad.title) + '</strong>' +
      (ad.institution ? ' at ' + esc(ad.institution) : ''));
  }
  const place = ad.place || null;
  if (place && (place.institution || place.school || place.unit)) {
    bits.push('the site’s vocabulary files it as <strong>' +
      esc([place.institution, place.school, place.unit].filter(Boolean).join(' — ')) +
      '</strong>');
  } else if (ad.school || ad.department) {
    bits.push('the page files it under <strong>' +
      esc([ad.school, ad.department].filter(Boolean).join(', ')) + '</strong>');
  }
  if (ad.applyByDate) bits.push('it closes on <strong>' + esc(ad.applyByDate) + '</strong>');
  else if (ad.applyByProse) bits.push('about its deadline it says “' + esc(ad.applyByProse) + '”');
  if (!gone && !bits.length) return '';
  return '<p style="background:#eef7ee;border:1px solid #a8cba8;border-radius:6px;' +
    'padding:10px 14px">&#128196; <strong>What the advertisement says</strong> — ' +
    (gone ? 'the linked advertisement is <strong>no longer up</strong>' +
      (bits.length ? '; while it was up, ' : '.') : '') +
    bits.join('; ') + (bits.length ? '.' : '') +
    '</p>';
}

export function renderReviewEmail(doc, { site = SITE } = {}) {
  const r = shown(doc);
  const title = [r.institution, r.department].filter(Boolean).join(' — ');
  const reviewUrl = site + '/admin-area';

  const ad = /^https?:\/\//i.test(String(r.adUrl || '')) ? r.adUrl : '';

  const bodyHtml =
    '<p>A job posting has been read from your tracking sheet and is waiting for ' +
    'you to approve it. <strong>It is not on the site yet.</strong></p>' +
    dupHtml(doc) +
    bizHtml(doc) +
    advertHtml(doc) +
    '<table style="border-collapse:collapse;font-size:14px;margin:14px 0">' +
      line('Institution', r.institution) +
      line('School / dept', r.department) +
      line('Type', r.type) +
      line('Entry level', (r.levels || []).join(', ')) +
      line('Country', r.country) +
      line('Advertised', r.posted) +
      line('Market year', r.year ? String(r.year) : '') +
      line('Suggested apply by', r.reviewDate ? longDate(r.reviewDate) : '') +
      line('Final apply by', r.applyBy) +
      line('Comments', r.comments) +
    '</table>' +
    (ad ? '<p><a href="' + esc(ad) + '">Open the advertisement</a></p>' : '') +
    '<p><a href="' + esc(reviewUrl) + '" style="display:inline-block;background:#426394;' +
      'color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:600">' +
      'Review it on the site</a></p>' +
    '<p style="color:#5a5f6b;font-size:13px">You can correct any field before ' +
    'approving. Approving publishes it within a couple of minutes; ' +
    'rejecting keeps it off the site for good.</p>';

  return {
    subject: 'Job posting to approve: ' + (title || r.id || 'untitled'),
    html: shell({ title: 'A posting is waiting for you', bodyHtml, manageUrl: reviewUrl }),
  };
}

/**
 * One e-mail for a batch: what arrived, in a list, with the count in the
 * subject.
 *
 * Deliberately NOT the per-posting card repeated — a hundred of those is not a
 * digest, it is the same mail bomb in one message. It is a list of what is
 * waiting, and the decision is made on the page, where every field is editable
 * anyway.
 */
export function renderDigestEmail(docs, { site = SITE } = {}) {
  const reviewUrl = site + '/admin-area';
  const rows = docs.map((d) => {
    const r = shown(d);
    const title = [r.institution, r.department].filter(Boolean).join(' — ');
    const dup = Array.isArray(d.dup) && d.dup.length;
    return '<tr>' +
      '<td style="padding:3px 12px 3px 0;vertical-align:top;white-space:nowrap;' +
        'color:#5a5f6b">' + esc(r.posted || '') + '</td>' +
      '<td style="padding:3px 0;vertical-align:top">' + esc(title || r.id || 'untitled') +
        (r.country ? ' <span style="color:#5a5f6b">(' + esc(r.country) + ')</span>' : '') +
        (dup ? ' <span style="color:#8a6d1a">&#9888; possible duplicate</span>' : '') +
      '</td></tr>';
  }).join('');

  const bodyHtml =
    '<p><strong>' + docs.length + ' job postings</strong> have been read from your ' +
    'tracking sheet and are waiting for you to approve them. ' +
    '<strong>None of them is on the site yet.</strong></p>' +
    '<p>They came in together, so they are listed here rather than sent one by one.</p>' +
    '<table style="border-collapse:collapse;font-size:14px;margin:14px 0">' + rows + '</table>' +
    '<p><a href="' + esc(reviewUrl) + '" style="display:inline-block;background:#426394;' +
      'color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:600">' +
      'Review them on the site</a></p>' +
    '<p style="color:#5a5f6b;font-size:13px">Every field is editable there before you ' +
    'approve, one at a time or the whole page at once. Approving publishes within a ' +
    'couple of minutes; rejecting keeps a posting off the site for good.</p>';

  return {
    subject: docs.length + ' job postings to approve',
    html: shell({ title: docs.length + ' postings are waiting for you',
                  bodyHtml, manageUrl: reviewUrl }),
  };
}

/* -------------------------------------------------------------------- main */

async function main() {
  const db = await firestore();
  if (!db) {
    log('no Firebase credentials in this environment — nothing to do.');
    log('(this is the expected state until the project is set up: _SETUP-FIREBASE.md)');
    return 0;
  }

  const snap = await db.collection(COLLECTION).where('status', '==', 'pending').get();
  const docs = snap.docs.map((d) => d.data()).filter((d) => d && d.rowId);
  const due = needMail(docs);

  log(`${docs.length} posting(s) awaiting review, ${due.length} not yet announced.`);

  if (!due.length) return 0;

  if (SCAN) {
    for (const d of due) {
      const r = shown(d);
      log(`  ${d.rowId}  ${r.institution || ''}${r.department ? ' — ' + r.department : ''}`);
    }
    log('--scan: sent nothing, wrote nothing.');
    return 0;
  }

  const tx = await transport();
  if (!tx && !DRY) {
    warn('SMTP is not configured — the postings stay unannounced and will be ' +
         'mailed once it is. See _SETUP-EMAIL.md');
    return 0;
  }

  /* A BATCH IS ONE E-MAIL. Stamped per document all the same, so the two
     paths share one high-water mark and neither can re-announce the other's
     postings. A failure to stamp is reported and the run carries on: the
     e-mail has gone, and leaving the rest unstamped would send it again. */
  if (due.length > BURST) {
    const { subject, html } = renderDigestEmail(due);
    log(`${due.length} postings arrived together — announcing them as one list.`);
    if (DRY) {
      log(`--- digest\nTo: ${TO}\nSubject: ${subject}\n${toPlain(html)}\n`);
      return 0;
    }
    await send(tx, { from: fromAddress(), to: TO, subject, html, text: toPlain(html) });
    const at = new Date().toISOString();
    let stamped = 0;
    for (const doc of due) {
      try {
        await db.collection(COLLECTION).doc(doc.rowId).set({ mailedAt: at }, { merge: true });
        stamped++;
      } catch (e) {
        warn(`announced ${doc.rowId} but could not stamp it (${e.message})`);
      }
    }
    log(`told ${TO} about ${due.length} posting(s); stamped ${stamped}.`);
    return 0;
  }

  let sent = 0;
  for (const doc of due) {
    const { subject, html } = renderReviewEmail(doc);

    if (DRY) {
      log(`--- ${doc.rowId}\nTo: ${TO}\nSubject: ${subject}\n${toPlain(html)}\n`);
      continue;
    }

    try {
      await send(tx, { from: fromAddress(), to: TO, subject, html, text: toPlain(html) });
    } catch (e) {
      /* Left unstamped on purpose, so the next run tries it again — the
         failure that matters is a posting nobody hears about. */
      warn(`could not e-mail about ${doc.rowId}: ${e.message}`);
      continue;
    }

    try {
      await db.collection(COLLECTION).doc(doc.rowId)
        .set({ mailedAt: new Date().toISOString() }, { merge: true });
    } catch (e) {
      warn(`e-mailed about ${doc.rowId} but could not stamp it (${e.message}) — ` +
           'it may be announced twice');
    }
    sent++;
  }

  if (DRY) log(`--dry-run: would have sent ${due.length} e-mail(s).`);
  else log(`sent ${sent} e-mail(s) to ${TO}.`);
  return 0;
}

/* ---------------------------------------------------------------- selftest */

function selftest() {
  let pass = 0; const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };

  const doc = {
    rowId: 'x', status: 'pending', queuedAt: '2026-08-18T00:00:00Z', mailedAt: '',
    row: {
      id: 'x', institution: 'Example University', department: 'Operations',
      posted: '2026-08-15', year: 2027, applyBy: 'Until filled.', applyByDate: '',
      levels: ['Assistant Professor'], country: 'United States',
      adUrl: 'https://www.higheredjobs.com/faculty/details.cfm?JobCode=1',
    },
    edits: {},
  };

  const mail = renderReviewEmail(doc, { site: 'https://example.org' });
  ok(/Example University/.test(mail.subject), 'the subject names the posting');
  ok(/not on the site yet/i.test(mail.html), 'the body says it is not published');
  ok(mail.html.includes('https://example.org/admin-area'), 'and links to the review page');

  /* The e-mail must show what APPROVING would publish, not the raw sheet row —
     otherwise a correction already typed in the browser is invisible in the
     one place the decision is actually made. */
  const edited = { ...doc, edits: { institution: 'Corrected University' } };
  ok(renderReviewEmail(edited).subject.includes('Corrected University'),
    'an edit already made is what the e-mail shows');

  /* A POSSIBLE DUPLICATE IS SAID WHERE THE DECISION IS ASKED FOR. The sync
     writes `dup` onto the document when a crawled posting looks like a job
     already on the site; the e-mail has to carry it, or the maintainer
     approves a repeat from their inbox that the review card would have warned
     them about. Escaped like everything else — a duplicate entry is built
     from a posting somebody typed. */
  const dupped = { ...doc, dup: [{ id: 'y', ref: 'OA-JOB-1', source: 'oa-form',
    institution: 'Example <b>University</b>', department: 'Operations', posted: '2026-08-10' }] };
  const dmail = renderReviewEmail(dupped);
  ok(/Possibly already on the site/.test(dmail.html), 'a flagged duplicate is warned about');
  ok(!dmail.html.includes('<b>University</b>'), 'and its fields cannot inject markup');
  ok(!/Possibly already on the site/.test(mail.html),
    'a posting with no flag carries no warning');

  /* THE BUSINESS-SCHOOL FLAG IS SAID WHERE THE DECISION IS ASKED FOR, like
     the duplicate one: the sync stamps `biz` on a posting whose text says
     "business", naming the school the site's directory knows — and the school
     name comes from data people typed, so it must render inert. */
  const bizzed = { ...doc, biz: { school: 'Haas School of <b>Business</b>' } };
  const bmail = renderReviewEmail(bizzed);
  ok(/Business school posting/.test(bmail.html), 'a business-school flag is mentioned');
  ok(/Haas School of/.test(bmail.html), 'naming the school the directory knows');
  ok(!bmail.html.includes('<b>Business</b>'), 'with its name escaped, never injected');
  const bizNone = renderReviewEmail({ ...doc, biz: { school: '' } });
  ok(/does not list a business school/.test(bizNone.html),
    'and a directory with no answer says so rather than staying silent');
  ok(!/Business school posting/.test(mail.html),
    'while a posting with no flag carries no mention');

  /* WHAT THE ADVERTISEMENT SAYS IS SAID WHERE THE DECISION IS ASKED FOR,
     like the two flags above: adverts-verify.mjs stamps `ad` with what the
     linked page states, and the closing date — or the listing being down —
     informs exactly the decision the e-mail asks for. The fields come from a
     scraped page, so they must render inert. */
  const advertised = { ...doc, ad: { status: 'ok', url: 'https://x.example/1',
    title: 'Assistant <b>Professor</b>', institution: 'Example University',
    applyByDate: '2026-10-15', applyByProse: '', listedUntil: '2028-02-06',
    checkedAt: '2026-08-23T00:00:00Z' } };
  const amail = renderReviewEmail(advertised);
  ok(/What the advertisement says/.test(amail.html), 'the advertisement\'s reading is mentioned');
  ok(/2026-10-15/.test(amail.html), 'with the closing date it states');
  ok(!amail.html.includes('<b>Professor</b>'), 'its title escaped, never injected');
  ok(!/2028-02-06/.test(amail.html),
    'and the listing\'s own end date is NOT repeated as if it were a deadline');
  const adGone = renderReviewEmail({ ...doc, ad: { status: 'gone', url: 'https://x.example/1',
    title: '', institution: '', applyByDate: '2026-08-01', applyByProse: '',
    listedUntil: '', checkedAt: '2026-08-23T00:00:00Z' } });
  ok(/no longer up/.test(adGone.html), 'a listing that has come down is said to be down');
  const placed = renderReviewEmail({ ...doc, ad: { ...advertised.ad,
    place: { institution: 'Example <b>University</b>',
      school: 'Haas School of Business', unit: 'Operations' } } });
  ok(/vocabulary files it as/.test(placed.html),
    'the vocabulary\'s classification of the advertiser is mentioned');
  ok(!placed.html.includes('<b>University</b>'), 'with its names escaped, never injected');
  ok(!/What the advertisement says/.test(mail.html),
    'while a posting with no ad block carries no mention');

  // only pending-and-unmailed, oldest first
  const queue = [
    { rowId: 'b', status: 'pending', queuedAt: '2026-08-17T00:00:00Z', mailedAt: '' },
    { rowId: 'a', status: 'pending', queuedAt: '2026-08-16T00:00:00Z', mailedAt: '' },
    { rowId: 'c', status: 'pending', queuedAt: '2026-08-15T00:00:00Z', mailedAt: 'x' },
    { rowId: 'd', status: 'approved', queuedAt: '2026-08-14T00:00:00Z', mailedAt: '' },
  ];
  const due = needMail(queue).map((d) => d.rowId);
  ok(JSON.stringify(due) === JSON.stringify(['a', 'b']),
    'only unmailed pending postings are due, oldest first');

  /* A BATCH IS ONE E-MAIL. One per posting is right for the market ticking
     over and is a mail bomb for a tab arriving: eighty-nine postings, eighty-
     nine e-mails, and a provider cutting the run off part-way through. */
  const many = [];
  for (let i = 0; i < BURST + 1; i++) {
    many.push({ rowId: 'r' + i, status: 'pending', queuedAt: '2026-08-18T00:00:00Z',
                row: { id: 'r' + i, institution: 'University ' + i, posted: '2026-08-1' + (i % 10),
                       country: 'United States' }, edits: {} });
  }
  many[1].dup = [{ id: 'z', institution: 'University 1', department: '', posted: '2026-08-01' }];
  const digest = renderDigestEmail(many, { site: 'https://example.org' });
  ok(digest.subject.includes(String(many.length)), 'the subject says how many are waiting');
  ok(/University 0/.test(digest.html) && new RegExp('University ' + BURST).test(digest.html),
    'and every one of them is listed, first to last');
  ok(digest.html.includes('https://example.org/admin-area'), 'with one link to review them');
  ok(!/not on the site yet[\s\S]*not on the site yet/.test(digest.html),
    'said once, not once per posting');
  ok((digest.html.match(/possible duplicate/g) || []).length === 1,
    'the one flagged posting is marked as a possible duplicate, and only it');
  ok(!/half an hour/.test(digest.html) && !/half an hour/.test(mail.html),
    'no e-mail still promises the retired half-hour cadence — approving publishes in minutes');

  console.log(fails.length
    ? `jobreview-mailer selftest: ${pass} passed, ${fails.length} FAILED\n  ` + fails.join('\n  ')
    : `jobreview-mailer selftest: ${pass} checks passed.`);
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
