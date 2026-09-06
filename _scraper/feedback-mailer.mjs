#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — forward new feedback, and close resolved tickets.

   Two phases per run, mirroring /lit/'s feedback mailer:

   1. FORWARD. Every submission not yet forwarded is sent to the maintainer
      (screenshots attached, Reply-To the submitter) and, when the submitter
      left an address, a copy back to them as a receipt. Marked `forwarded`
      and `ackSent` independently, so a failed receipt never causes the
      maintainer's copy to be sent twice.

   2. RESOLVE. Every file in _feedback-resolutions/ is matched to its ticket,
      the ticket is CLOSED IN FIRESTORE FIRST, and then the submitter is
      e-mailed what was done. Write-before-send: a send failure retries only
      the e-mail, and can never lose the record that the ticket was resolved.

      Files STAY in place as the public record of what was fixed. An unchanged
      file is skipped forever (its content is hashed onto the ticket); EDITING
      one re-applies and re-notifies.

      Those files live in a PUBLIC repository, so they must never contain the
      submitter's name or address — the mailer looks those up in Firestore by
      ticket number.

   Modes: --dry-run  --scan  --selftest
   --------------------------------------------------------------------------- */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shell, esc, send, transport, firestore, SITE, CONTACT, toPlain,
  safeError } from './_mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLUTIONS = path.join(HERE, '..', '_feedback-resolutions');

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const SCAN = argv.has('--scan');

const TO = process.env.FEEDBACK_TO || 'kstouras@gmail.com';

/** The submitter's address, for the run log. Actions logs of a public
    repository are world-readable, and a feedback address is personal data. */
function redact(email) {
  const m = String(email || '').match(/^([^@]{1,2})[^@]*(@.*)$/);
  return m ? `${m[1]}***${m[2]}` : (email ? '***' : 'nobody');
}

/* -------------------------------------------------------- resolution files */

/**
 * Parse `<TICKET>.md`: optional YAML-ish front matter, then the body that is
 * e-mailed to the submitter verbatim.
 *
 *     ---
 *     ticket: OA-260815-AB12
 *     url: https://www.operationsacademia.org/jobs
 *     ---
 *     The deadline on the Duke posting was wrong. It now reads 1 November.
 */
export function parseResolutionFile(name, raw) {
  const out = { ticket: '', url: '', body: '' };
  let text = String(raw || '').replace(/^﻿/, '');

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const k = m[1].toLowerCase();
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (k === 'ticket' || k === 'doc') out.ticket = v;
      else if (k === 'url') out.url = v;
    }
    text = text.slice(fm[0].length);
  }

  // the filename is the fallback source of the ticket, and the usual one
  if (!out.ticket) out.ticket = path.basename(name, '.md');
  out.body = text.trim();

  // A resolution links to the fix. Only ever to this site, over https —
  // these files are the one place a URL reaches a reader's inbox unreviewed.
  if (out.url && !/^https:\/\/(www\.)?operationsacademia\.org(\/|$)/i.test(out.url)) {
    out.urlRejected = out.url;
    out.url = '';
  }
  return out;
}

export function resolutionHashOf(r) {
  return createHash('sha256')
    .update(`${r.ticket}\n${r.url}\n${r.body}`)
    .digest('hex')
    .slice(0, 16);
}

export function renderResolutionEmail({ ticket, body, url, original }) {
  const parts = [
    `<p>Thank you for writing to us. The thing you reported has been dealt with.</p>`,
    `<p style="margin:14px 0;padding:12px 14px;background:#f2faf5;border-left:3px solid #2e7d5b;">
       ${esc(body).replace(/\n{2,}/g, '</p><p style="margin:8px 0 0;">').replace(/\n/g, '<br>')}</p>`,
  ];
  if (url) {
    parts.push(`<p><a href="${esc(url)}"
      style="display:inline-block;background:#3B7DBC;color:#fff;padding:9px 18px;
             border-radius:3px;text-decoration:none;font-weight:600;">See it live</a></p>`);
  }
  if (original) {
    parts.push(`<p style="margin-top:22px;color:#666;font-size:13px;">
      For reference, this is what you told us:</p>
      <blockquote style="margin:6px 0 0;padding:10px 14px;border-left:3px solid #ddd;
        color:#555;font-size:14px;white-space:pre-wrap;">${esc(original)}</blockquote>`);
  }
  parts.push(`<p style="margin-top:20px;color:#888;font-size:13px;">
    Your ticket was <strong>${esc(ticket)}</strong>.</p>`);

  return shell({ title: `Your feedback (${ticket}) is resolved`, bodyHtml: parts.join('\n') });
}

/* ------------------------------------------------------------- forwarding */

export function renderMaintainerEmail(v) {
  return shell({
    title: `Feedback ${v.ticket}`,
    bodyHtml: `
      <p><strong>${esc(v.ticket)}</strong></p>
      <p style="white-space:pre-wrap;">${esc(v.message)}</p>
      <hr style="border:0;border-top:1px solid #eee;margin:18px 0;">
      <p style="font-size:13px;color:#666;">
        From: ${esc(v.name || '(no name)')} &lt;${esc(v.email || 'anonymous')}&gt;<br>
        Page: ${esc(v.page || '')}<br>
        ${(v.shots || []).length} screenshot(s) attached
      </p>
      <p style="font-size:13px;color:#666;">To close this, add
        <code>_feedback-resolutions/${esc(v.ticket)}.md</code> to the repository.</p>`,
  });
}

export function renderReceiptEmail(v) {
  return shell({
    title: `We have your feedback (${v.ticket})`,
    bodyHtml: `
      <p>Thank you — we have your message, and someone will look at it.</p>
      <p>Your ticket is <strong>${esc(v.ticket)}</strong>. Quote it if you write to us again
         about this. We will e-mail you when it is dealt with.</p>
      <hr style="border:0;border-top:1px solid #eee;margin:18px 0;">
      <p style="font-size:13px;color:#666;">This is what you told us:</p>
      <blockquote style="margin:6px 0 0;padding:10px 14px;border-left:3px solid #ddd;
        color:#555;font-size:14px;white-space:pre-wrap;">${esc(v.message)}</blockquote>`,
  });
}

/** Firestore holds screenshots as JPEG data URLs; turn them into attachments
    so the maintainer's mail client shows them normally.

    The type is checked against a fixed list of raster formats rather than
    `image/*`: the feedback page compresses everything to JPEG, and the one
    image type that is NOT inert — SVG, which is a script-carrying document
    when opened — has no business arriving as a screenshot. */
const SHOT_TYPES = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/gif': 'gif', 'image/webp': 'webp' };

function attachments(shots) {
  return (shots || []).map((u, i) => {
    const m = String(u).match(/^data:([a-z/+-]+);base64,(.+)$/i);
    const ext = m && SHOT_TYPES[m[1].toLowerCase()];
    if (!ext) return null;
    return {
      filename: `screenshot-${i + 1}.${ext}`,
      content: Buffer.from(m[2], 'base64'),
      contentType: m[1].toLowerCase(),
    };
  }).filter(Boolean);
}

/* --------------------------------------------------------------- selftest */

function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, w) => { if (c) pass++; else fails.push(w); };

  let r = parseResolutionFile('OA-260815-AB12.md',
    '---\nticket: OA-260815-AB12\nurl: https://www.operationsacademia.org/jobs\n---\nFixed the deadline.\n');
  ok(r.ticket === 'OA-260815-AB12', 'front matter ticket');
  ok(r.url === 'https://www.operationsacademia.org/jobs', 'front matter url');
  ok(r.body === 'Fixed the deadline.', 'body');

  r = parseResolutionFile('OA-260101-ZZZZ.md', 'Just a body.\n');
  ok(r.ticket === 'OA-260101-ZZZZ', 'the filename is the fallback ticket');
  ok(r.body === 'Just a body.', 'body without front matter');

  // a resolution file must not be able to send a reader anywhere else
  r = parseResolutionFile('t.md', '---\nurl: https://evil.example.com/x\n---\nbody');
  ok(r.url === '' && r.urlRejected, 'an off-site url is rejected');
  r = parseResolutionFile('t.md', '---\nurl: javascript:alert(1)\n---\nbody');
  ok(r.url === '', 'a javascript: url is rejected');
  r = parseResolutionFile('t.md', '---\nurl: http://www.operationsacademia.org/x\n---\nbody');
  ok(r.url === '', 'plain http is rejected — resolutions link over https only');

  // the legacy /lit/ spelling
  r = parseResolutionFile('x.md', '---\ndoc: abc123\n---\nbody');
  ok(r.ticket === 'abc123', '"doc:" is accepted as a ticket key');

  // hashing: unchanged means skip, edited means re-notify
  const a = parseResolutionFile('T.md', 'one');
  const b = parseResolutionFile('T.md', 'one');
  const c = parseResolutionFile('T.md', 'two');
  ok(resolutionHashOf(a) === resolutionHashOf(b), 'an unchanged file hashes the same');
  ok(resolutionHashOf(a) !== resolutionHashOf(c), 'an edited file hashes differently');

  // rendering
  const html = renderResolutionEmail({
    ticket: 'OA-1', body: 'We fixed it.', url: 'https://www.operationsacademia.org/jobs',
    original: 'The link was broken',
  });
  ok(html.includes('We fixed it.'), 'the resolution body is included');
  ok(html.includes('See it live'), 'the link is offered');
  ok(html.includes('The link was broken'), 'the original message is quoted back');

  const evil = renderResolutionEmail({ ticket: 'x', body: '<script>alert(1)</script>' });
  ok(!evil.includes('<script>alert(1)'), 'a resolution body cannot inject markup');

  const m = renderMaintainerEmail({
    ticket: 'OA-2', message: 'x < y & z', email: 'a@b.c', shots: ['data:image/jpeg;base64,AAA'],
  });
  ok(m.includes('x &lt; y &amp; z'), 'the maintainer copy escapes the message');
  ok(m.includes('_feedback-resolutions/OA-2.md'), 'the maintainer copy says how to close it');

  const jpg = 'data:image/jpeg;base64,' + Buffer.from('hi').toString('base64');
  ok(attachments([jpg]).length === 1, 'a data URL becomes an attachment');
  ok(attachments([jpg])[0].filename === 'screenshot-1.jpg', 'the attachment is named sensibly');
  ok(attachments(['not-a-data-url']).length === 0, 'a non-data URL is not attached');
  // an SVG is a script-carrying document, and is never a screenshot from the
  // feedback page, which compresses everything to JPEG
  ok(attachments(['data:image/svg+xml;base64,AAA']).length === 0, 'an SVG is not attached');
  ok(attachments(['data:text/html;base64,AAA']).length === 0, 'a non-image is not attached');

  ok(toPlain(html).includes('We fixed it.'), 'the plain-text alternative carries the body');

  // Actions logs of a public repository are world-readable, and a feedback
  // address is personal data.
  ok(redact('reporter@example.com') === 're***@example.com',
    'the run log does not print a submitter address in full');
  ok(redact('') === 'nobody', 'an anonymous submission still reads sensibly');

  if (fails.length) {
    console.log(`\n${fails.length} FAILED, ${pass} passed`);
    for (const f of fails) console.log('  FAIL  ' + f);
    return false;
  }
  console.log(`feedback-mailer selftest: ${pass} checks passed`);
  return true;
}

/* ------------------------------------------------------------------- main */

async function loadResolutions() {
  if (!existsSync(RESOLUTIONS)) return [];
  const names = (await readdir(RESOLUTIONS)).filter((n) => n.endsWith('.md') && n !== 'README.md');
  const out = [];
  for (const n of names) {
    const raw = await readFile(path.join(RESOLUTIONS, n), 'utf8');
    const r = parseResolutionFile(n, raw);
    if (r.urlRejected) {
      console.log(`::warning::${n}: url "${r.urlRejected}" is not an https operationsacademia.org link — dropped`);
    }
    if (!r.body) { console.log(`::warning::${n} has no body — skipped`); continue; }
    out.push({ file: n, ...r, hash: resolutionHashOf(r) });
  }
  return out;
}

async function main() {
  if (argv.has('--selftest')) process.exit(selftest() ? 0 : 1);

  const resolutions = await loadResolutions();

  const db = await firestore();
  if (!db) {
    console.log('no Firebase credentials — nothing to forward or resolve.');
    console.log(`(${resolutions.length} resolution file(s) are ready and will apply once set up)`);
    return;
  }

  const tx = await transport();
  if (!tx && !DRY && !SCAN) console.log('::warning::SMTP is not configured — running as a dry run');

  /* ---- phase 1: forward ---- */
  const pending = await db.collection('feedback').where('forwarded', '==', false).get();
  console.log(`${pending.size} submission(s) to forward`);

  for (const doc of pending.docs) {
    const v = { id: doc.id, ...doc.data() };
    if (SCAN) { console.log(`  new  ${v.ticket}  ${(v.message || '').slice(0, 60)}`); continue; }

    let forwarded = false;
    try {
      // `forwarded` is stamped ONLY behind a real delivery. send() returns
      // false when it merely printed the message (a dry run, or no SMTP yet):
      // marking it anyway would take the submission out of the pending queue
      // for good, and nobody would ever read it.
      forwarded = await send(tx, {
        to: TO,
        replyTo: v.email || undefined,
        subject: `[${v.ticket}] Operations Academia feedback`,
        html: renderMaintainerEmail(v),
        attachments: attachments(v.shots),
      }, { dryRun: DRY });
      if (forwarded) await doc.ref.update({ forwarded: true, forwardedAt: new Date().toISOString() });
    } catch (err) {
      console.log(`::warning::could not forward ${v.ticket}: ${safeError(err)}`);
      continue;   // leave it unforwarded so the next run retries
    }

    // The receipt is best-effort: its failure must never un-forward the copy
    // the maintainer already has.
    if (v.email && !v.ackSent) {
      try {
        const acked = await send(tx, {
          to: v.email,
          subject: `We have your feedback (${v.ticket})`,
          html: renderReceiptEmail(v),
        }, { dryRun: DRY });
        if (acked) await doc.ref.update({ ackSent: true });
      } catch (err) {
        console.log(`::warning::could not send the receipt for ${v.ticket}: ${safeError(err)}`);
      }
    }
    console.log(`${forwarded ? 'forwarded' : 'would forward'} ${v.ticket}`);
  }

  /* ---- phase 2: resolve ---- */
  console.log(`\n${resolutions.length} resolution file(s) on disk`);

  for (const r of resolutions) {
    const snap = await db.collection('feedback').where('ticket', '==', r.ticket).limit(2).get();
    if (snap.empty) {
      console.log(`::warning::${r.file}: no ticket ${r.ticket} in the database — skipped`);
      continue;
    }
    /* A ticket is CLIENT-CHOSEN (the page generates it, the rules do not pin
       it), so two documents can carry one. A resolution applied to "the
       first" would close and e-mail whichever the index returned — possibly
       a stranger's — so it is applied only when the ticket is unambiguous. */
    if (snap.size > 1) {
      console.log(`::warning::${r.file}: ticket ${r.ticket} names more than one submission — skipped`);
      continue;
    }
    const doc = snap.docs[0];
    const v = doc.data();

    // A resolution is FINISHED only once the submitter has been told, so
    // `resolutionSent` is part of the test and not just the hash. Keyed on the
    // hash alone, a notification that failed — a transient SMTP error, or a run
    // before the mailbox existed — was skipped forever on every later run, and
    // the person who reported the problem never heard that it was fixed. (An
    // anonymous submission has nobody to tell, so the hash alone finishes it.)
    if (v.resolutionHash === r.hash && (v.resolutionSent || !v.email)) continue;

    if (SCAN) { console.log(`  resolve  ${r.ticket}  ${r.body.slice(0, 60)}`); continue; }

    // CLOSE FIRST. If the send then fails, the ticket is still recorded as
    // resolved and only the notification retries — so the guard is "not
    // already closed at this hash", which makes a retry write nothing.
    // A run with no transport writes nothing at all: it is a dry run (see the
    // warning above), and closing a ticket nobody can yet be told about is
    // exactly the premature bookkeeping this whole file now avoids.
    if (v.resolutionHash !== r.hash && !DRY && tx) {
      await doc.ref.update({
        status: 'closed',
        resolution: r.body,
        resolutionUrl: r.url || '',
        resolutionHash: r.hash,
        resolvedBy: 'repo',
        resolvedAt: new Date().toISOString(),
      });
    }

    if (!v.email) { console.log(`closed ${r.ticket} (anonymous — nobody to tell)`); continue; }

    try {
      const told = await send(tx, {
        to: v.email,
        subject: `Your feedback (${r.ticket}) is resolved`,
        html: renderResolutionEmail({
          ticket: r.ticket, body: r.body, url: r.url, original: v.message,
        }),
      }, { dryRun: DRY });
      if (told) await doc.ref.update({ resolutionSent: true });
      console.log(told
        ? `resolved ${r.ticket} and told ${redact(v.email)}`
        : `would resolve ${r.ticket}`);
    } catch (err) {
      console.log(`::warning::closed ${r.ticket} but could not e-mail: ${safeError(err)}`);
    }
  }
}

main().catch((err) => {
  console.error('feedback-mailer failed:', err);
  process.exit(1);
});
