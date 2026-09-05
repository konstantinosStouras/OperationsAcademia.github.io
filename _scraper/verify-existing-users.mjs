#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia: ask every existing password account to confirm its
   address, ONCE.

   THE GAP THIS CLOSES. Registration verifies the e-mail address since
   2026-09-04: a new password account is sent one message and does nothing
   until the link in it is pressed (_functions/index.js sendVerificationEmail,
   _SETUP-EMAIL-VERIFICATION.md). Every password account that registered
   BEFORE that day is gated by the same rules and was never sent anything,
   because none of them registered through the path that sends. Until this
   job existed the only way out was for each person to sign in, meet the
   "Check your inbox" card, and press Send the e-mail themselves. The owner
   asked (2026-09-05) for the site to write to them instead.

   WHO IS WRITTEN TO, and it is a pure function (`campaignTarget`): an account
   whose EVERY sign-in provider is `password`, whose address is not verified,
   which is not disabled, and which has an address. A Google or ORCID sign-in
   is verified by its provider (the rules' own `verified()` says so) and is
   skipped, and the run's summary counts those separately and says why; an
   account that has linked Google AND a password is a Google account for this
   purpose and is skipped too.

   ONCE, HOWEVER OFTEN THE BUTTON IS PRESSED. A successful send stamps
   `verifyMail/{uid}.campaignAt`, the same document the callable rate-limits
   with and one no client may read or write, so no rules change. An account
   carrying the stamp is never mailed again; a failed send stamps nothing and
   is retried by the next press. The callable's own bookkeeping leaves the
   stamp alone: its `releaseSlot` restores the document WHOLE, so a failed
   send there cannot erase a campaign mark.

   THE SAME MESSAGE, WORDED FOR A MEMBER. The link is built by
   `siteVerifyLink`, the one helper the callable uses too, so the two senders
   cannot put the code on different pages; the message is `renderVerifyEmail`
   with `existing: { since }`, which changes the heading and the first
   paragraph and nothing else.

   WHAT A PUBLIC LOG MAY CARRY. This prints into the Actions log of a public
   repository. --scan prints counts and nothing else; --dry-run prints the
   account ids and the day each registered, never an address and never a
   link, and it mints NO code, because _mail.mjs's dry-run printer shows the
   first 800 characters of a message's text and the text carries the link.
   The real send names an account by its id and a REDACTED address only, and
   an SMTP error's message text is never printed (it quotes the rejected
   address in full). Without SMTP nothing is minted at all: a code minted
   for a message that cannot go out is a code that expires unused.

   Paced at one message a second (`PACE_MS`), so a roster of a few hundred
   goes out in minutes without tripping the mailbox's own limits.

   Modes:
     --scan       counts only: total, password-unverified, already mailed, to send
     --dry-run    the ids that would be written to, nothing minted or sent
     --selftest   offline checks, no network, no credentials
     (none)       the campaign: mint, render, send, stamp
   --------------------------------------------------------------------------- */

import { isMain } from './_main.mjs';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { send, transport, firebaseAdmin, redact, SITE, CONTACT } from './_mail.mjs';
import { stamp } from './sync-user-directory.mjs';

/* The deploy-local renderer the callable ships with, required rather than
   copied, so the message an existing member receives IS the message a new
   registration receives, apart from the words `existing` changes. */
const V = createRequire(import.meta.url)('../_functions/verify-email.js');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const SCAN = has('--scan');
const DRY = has('--dry-run');

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('::warning::' + a.join(' '));

/** The callable's rate-limit collection: closed to every client already, so
    the campaign mark needs no rules change. */
export const VERIFY_MAIL = 'verifyMail';
/** The once-only mark: an ISO timestamp, written after a send succeeded. */
export const CAMPAIGN_AT = 'campaignAt';
/** One message a second. */
export const PACE_MS = 1000;
/** The provider the gate applies to; anything else arrives verified. */
export const PASSWORD = 'password';

/* ------------------------------------------------------------- pure halves */

/**
 * Why an Auth record is, or is not, written to:
 *   'send'        a password-only account, unverified, enabled, with an address
 *   'provider'    signs in through Google or ORCID (alone or linked with a
 *                 password): verified by the provider, so skipped
 *   'verified'    a password account whose address is already confirmed
 *   'disabled'    a disabled account is not written to
 *   'no-address'  a password account with no address (cannot happen in
 *                 practice, refused rather than assumed)
 */
export function campaignTarget(user) {
  const u = user || {};
  const providers = (Array.isArray(u.providerData) ? u.providerData : [])
    .map((p) => (p && p.providerId) || '').filter(Boolean);
  if (!providers.length || providers.some((p) => p !== PASSWORD)) return 'provider';
  if (u.emailVerified !== false) return 'verified';
  if (u.disabled) return 'disabled';
  if (!String(u.email || '').trim()) return 'no-address';
  return 'send';
}

/** A fresh tally, every key present so the summary never prints undefined. */
export function emptyCounts() {
  return { total: 0, send: 0, provider: 0, verified: 0, disabled: 0, 'no-address': 0,
    mailed: 0, toSend: 0 };
}

/** What a run found, in one sentence, counts only. */
export function summarise(c) {
  return `${c.total} account(s) in Auth: ${c.provider} sign in through Google or ORCID ` +
    'and are verified by the provider (skipped), ' +
    `${c.verified} password account(s) already verified, ${c.disabled} disabled, ` +
    `${c['no-address']} with no address, ${c.send} password account(s) unverified; ` +
    `of those ${c.mailed} already mailed by this campaign, ${c.toSend} to send.`;
}

/** The day an account registered, as the renderer prints it, or '' when the
    record carries no usable creation time (the lead then omits the day). */
export function registeredDay(user) {
  const t = stamp(user && user.metadata && user.metadata.creationTime);
  return t ? V.longDay(t) : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------- main */

async function main() {
  const fb = await firebaseAdmin();
  if (!fb) {
    log('no Firebase credentials in this environment: nothing to do.');
    log('(this is the expected state until the project is set up: _SETUP-FIREBASE.md)');
    return 0;
  }

  /* NO SMTP, NO MINTING. The check comes before the account list is even
     read: a real run without a mailbox would otherwise mint a code for every
     account and send none of them. */
  const tx = SCAN || DRY ? null : await transport();
  if (!SCAN && !DRY && !tx) {
    warn('SMTP is not configured: nothing was minted and nothing was sent. ' +
         'Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS and press the button again ' +
         '(_SETUP-EMAIL-VERIFICATION.md).');
    return 0;
  }

  const counts = emptyCounts();
  const targets = [];
  let token;
  do {
    // 1000 is the Admin SDK's maximum page
    const page = await fb.auth.listUsers(1000, token);
    for (const user of page.users) {
      counts.total++;
      const why = campaignTarget(user);
      counts[why]++;
      if (why === 'send') targets.push(user);
    }
    token = page.pageToken;
  } while (token);

  /* The once-only mark, read per account: the collection is small (one
     document per account that has ever been sent a verification message). */
  const queue = [];
  for (const user of targets) {
    const doc = (await fb.db.collection(VERIFY_MAIL).doc(user.uid).get()).data() || {};
    if (doc[CAMPAIGN_AT]) counts.mailed++;
    else queue.push(user);
  }
  counts.toSend = queue.length;
  log(summarise(counts));

  if (SCAN) {
    log('--scan: counts only. Nothing minted, nothing sent, nothing written.');
    return 0;
  }

  const subject = V.renderVerifyEmail({ link: '', existing: { since: 0 } }).subject;
  if (DRY) {
    /* THE DOCUMENT, NEVER THE PERSON, and NO CODE: an id and a day per line.
       A rendered message would carry the link, and the dry-run printer in
       _mail.mjs prints the text, so nothing is rendered and nothing minted. */
    for (const user of queue) {
      log(`  would send: ${user.uid}  registered ${registeredDay(user) || '(day unknown)'}`);
    }
    log(`--dry-run: ${queue.length} message(s) would go out, subject "${subject}". ` +
        'Nothing minted, nothing sent, nothing written.');
    return 0;
  }

  let sent = 0;
  let failed = 0;
  for (const user of queue) {
    const email = String(user.email || '').trim();

    /* Firebase mints the one-time code; the site's own page is what the
       reader lands on. EXACTLY the callable's rewrite, through the one
       shared helper. */
    let generated = '';
    try {
      generated = await fb.auth.generateEmailVerificationLink(email, {
        url: SITE + '/account.html',
      });
    } catch (e) {
      failed++;
      warn(`${user.uid}: no verification message could be minted (${e.code || 'error'})`);
      await sleep(PACE_MS);
      continue;
    }
    const link = V.siteVerifyLink(generated, SITE);
    if (!link) {
      failed++;
      warn(`${user.uid}: the minted address carried no verification token`);
      await sleep(PACE_MS);
      continue;
    }

    /* The greeting, from the profile, exactly as the callable takes it; a
       missing profile only costs the first name. */
    let firstName = '';
    try {
      const prof = (await fb.db.collection('profiles').doc(user.uid).get()).data() || {};
      firstName = String(prof.firstName || '').trim();
    } catch {
      firstName = '';
    }

    const msg = V.renderVerifyEmail({
      firstName, email, link, site: SITE, contact: CONTACT,
      existing: { since: stamp(user.metadata && user.metadata.creationTime) || null },
    });

    let ok = false;
    try {
      ok = await send(tx, { to: email, subject: msg.subject, html: msg.html, text: msg.text });
    } catch (e) {
      /* The SMTP error's own text can quote the rejected recipient in full,
         so only its code and response number are printed. */
      failed++;
      warn(`${user.uid}: not sent to ${redact(email)} (${e.code || e.responseCode || 'error'})`);
    }
    if (ok) {
      /* Stamped ONLY after the transport took the message: a printed or a
         failed one leaves the account eligible for the next press. */
      await fb.db.collection(VERIFY_MAIL).doc(user.uid)
        .set({ [CAMPAIGN_AT]: new Date().toISOString() }, { merge: true });
      sent++;
      log(`  sent: ${user.uid}  ${redact(email)}`);
    }
    await sleep(PACE_MS);
  }

  log(`${sent} message(s) sent and stamped, ${failed} failed; ` +
      'a failed one is not stamped and goes out on the next press.');
  return 0;
}

/* ---------------------------------------------------------------- selftest */

async function selftest() {
  let pass = 0;
  const fails = [];
  const ok = (c, what) => { if (c) pass++; else fails.push(what); };
  const eq = (got, want, what) => ok(JSON.stringify(got) === JSON.stringify(want),
    `${what}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  const noDash = (s) => !/—/.test(String(s));
  const count = (hay, needle) => String(hay).split(needle).length - 1;

  /* --- the selection rule --------------------------------------------------- */
  const pw = (over) => Object.assign({
    uid: 'u1', email: 'a@b.edu', emailVerified: false, disabled: false,
    providerData: [{ providerId: 'password' }],
    metadata: { creationTime: 'Wed, 05 Mar 2025 10:00:00 GMT' },
  }, over || {});
  eq(campaignTarget(pw()), 'send', 'a password-only, unverified, enabled account with an address is written to');
  eq(campaignTarget(pw({ providerData: [{ providerId: 'google.com' }] })), 'provider',
    'a Google sign-in is verified by Google and skipped');
  eq(campaignTarget(pw({ providerData: [{ providerId: 'oidc.orcid' }] })), 'provider',
    'an ORCID sign-in carries no e-mail claim and is skipped');
  eq(campaignTarget(pw({ providerData: [{ providerId: 'google.com' }, { providerId: 'password' }] })),
    'provider',
    'an account that linked Google AND a password is a Google account here, and is skipped');
  eq(campaignTarget(pw({ emailVerified: true })), 'verified', 'an already-verified password account is skipped');
  eq(campaignTarget(pw({ disabled: true })), 'disabled', 'a disabled account is not written to');
  eq(campaignTarget(pw({ email: '' })), 'no-address', 'a password account with no address is refused, not assumed');
  eq(campaignTarget(pw({ providerData: [] })), 'provider', 'an account with no provider at all is not a password account');
  eq(campaignTarget(undefined), 'provider', 'and garbage is skipped rather than thrown on');

  const c = emptyCounts();
  for (const u of [pw(), pw({ providerData: [{ providerId: 'google.com' }] }), pw({ emailVerified: true }),
    pw({ disabled: true })]) { c.total++; c[campaignTarget(u)]++; }
  c.mailed = 0; c.toSend = 1;
  const line = summarise(c);
  ok(/^4 account\(s\) in Auth: 1 sign in through Google or ORCID/.test(line)
     && /1 password account\(s\) already verified, 1 disabled/.test(line)
     && /1 password account\(s\) unverified; of those 0 already mailed by this campaign, 1 to send\./.test(line),
    'the summary counts every reason separately and says why a provider sign-in is skipped');
  ok(!/@/.test(line) && noDash(line), 'and carries no address and no em dash');

  /* --- the message, worded for a member ------------------------------------ */
  const site = 'https://www.operationsacademia.org';
  const link = `${site}/verify-email.html?mode=verifyEmail&oobCode=AbC123xyz` +
    `&continueUrl=${encodeURIComponent(site + '/account.html')}`;
  const fresh = V.renderVerifyEmail({ firstName: 'Ada', email: 'ada@example.edu', link });
  const member = V.renderVerifyEmail({ firstName: 'Ada', email: 'ada@example.edu', link,
    existing: { since: '2025-03-05T10:00:00Z' } });
  eq(member.subject, fresh.subject, 'the subject is the one the callable sends');
  ok(/Please confirm your e-mail address/.test(member.html) && /^Please confirm your e-mail address$/m.test(member.text),
    'the heading reads for a member, in both halves');
  ok(!/One more step/.test(member.html) && !/Thank you for registering/.test(member.html)
     && !/Thank you for registering/.test(member.text),
    'and the newcomer\'s heading and thanks are gone');
  ok(/You registered with Operations Academia on 5 March 2025\./.test(member.html)
     && /You registered with Operations Academia on 5 March 2025\./.test(member.text),
    'the first paragraph names the day they registered, as day month year');
  ok(/Every address is now confirmed once before signing in: one click, and nothing else about your account changes\./.test(member.html),
    'and says every address is confirmed once, one click, nothing else changes');
  ok(count(member.html, 'Verify my e-mail address') === count(fresh.html, 'Verify my e-mail address')
     && count(member.text, 'Verify my e-mail address') === 1,
    'the same button');
  ok(count(member.html, V.esc(link)) === count(fresh.html, V.esc(link)) && count(member.text, link) === 1,
    'the same printed link, the same number of times');
  ok(/questions to <a href="mailto:operationsacademia@gmail\.com"/.test(member.html)
     && /questions to operationsacademia@gmail\.com/.test(member.text),
    'the same footer');
  ok(/Hello Ada,/.test(member.html) && /^Hello Ada,$/m.test(member.text), 'the same greeting');
  ok(!/If you did not register/.test(member.html) && /If you no longer use your account/.test(member.html),
    'the closing sentence does not tell a member of years that they may not have registered');
  ok(noDash(member.html) && noDash(member.text), 'no em dash in the member variant');
  const noDay = V.renderVerifyEmail({ link, existing: { since: null } });
  ok(/You registered with Operations Academia\. Every address/.test(noDay.html),
    'with no usable creation time the lead omits the day rather than printing 1970');
  ok(/One more step/.test(fresh.html) && /Thank you for registering with Operations Academia\./.test(fresh.html)
     && /If you did not register, you can ignore this message and no account will be used\./.test(fresh.html)
     && !/Please confirm your e-mail address/.test(fresh.html) && !/You registered with/.test(fresh.html),
    'and a render WITHOUT existing is the newcomer\'s message, unchanged in shape');
  eq(V.longDay('2025-03-05T10:00:00Z'), '5 March 2025', 'longDay prints day month year');
  eq(V.longDay(Date.parse('Mon, 01 Jan 2026 23:59:00 GMT')), '1 January 2026', 'read in UTC, from epoch ms too');
  eq(V.longDay('junk'), '', 'and nothing for a non-date');
  eq(registeredDay(pw()), '5 March 2025', 'registeredDay reads the Auth creation time through stamp()');
  eq(registeredDay({ metadata: {} }), '', 'and is empty for a record without one');

  /* --- the shared link helper ----------------------------------------------- */
  const minted = 'https://operations-academia.firebaseapp.com/__/auth/action?mode=verifyEmail' +
    '&oobCode=AbC%2F123&continueUrl=https%3A%2F%2Fwww.operationsacademia.org%2Faccount.html&lang=en';
  eq(V.siteVerifyLink(minted, site),
    `${site}/verify-email.html?mode=verifyEmail&oobCode=AbC%2F123&continueUrl=${encodeURIComponent(site + '/account.html')}`,
    'siteVerifyLink moves the code onto the site\'s own page with the account page as continueUrl');
  eq(V.siteVerifyLink('https://x.test/?mode=verifyEmail', site), '', 'and answers nothing when there is no code');
  eq(V.siteVerifyLink('not a url', site), '', 'or no address at all, rather than throwing');
  ok(V.siteVerifyLink(minted, site + '/').indexOf(site + '/verify-email.html') === 0,
    'a trailing slash on the site root is folded');

  /* --- the file's own source: the guards that keep the log clean ------------ */
  const src = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const mainAt = src.indexOf('async function main()');
  const mainEnd = src.indexOf('/* ---------------------------------------------------------------- selftest */');
  ok(mainAt > 0 && mainEnd > mainAt, 'main() was found');
  const body = src.slice(mainAt, mainEnd);
  ok(body.length > 1500, 'and is the right size, or the checks below are vacuous');

  const sendAt = body.indexOf('ok = await send(tx,');
  const stampAt = body.indexOf(`.set({ [CAMPAIGN_AT]:`);
  const ifOk = body.indexOf('if (ok) {');
  ok(sendAt > 0 && stampAt > sendAt && ifOk > sendAt && ifOk < stampAt,
    'campaignAt is written AFTER send() and only inside the branch where it returned true');
  ok(/\{ merge: true \}/.test(body.slice(stampAt, stampAt + 200)),
    'and merged, so the callable\'s own sentAt/day/count survive');
  ok(!/\.set\(\{ \[CAMPAIGN_AT\]/.test(body.slice(0, ifOk)), 'nothing stamps the mark before a send');

  const mintAt = body.indexOf('generateEmailVerificationLink(');
  const dryAt = body.indexOf('if (DRY) {');
  const scanAt = body.indexOf('if (SCAN) {');
  const noTx = body.indexOf('if (!SCAN && !DRY && !tx) {');
  ok(mintAt > 0 && dryAt > 0 && dryAt < mintAt && scanAt < mintAt,
    'the --scan and --dry-run branches return BEFORE any code is minted');
  ok(noTx > 0 && noTx < body.indexOf('listUsers('),
    'and a run with no SMTP returns before the account list is read, so nothing is minted for a message that cannot go');
  ok(/url: SITE \+ '\/account\.html'/.test(body), 'the link is minted with the account page as its continue URL');
  ok(/V\.siteVerifyLink\(generated, SITE\)/.test(body), 'and rewritten by the shared helper, never inline');
  ok(!/oobCode/.test(body) && !/verify-email\.html/.test(body),
    'no inline copy of the rewrite exists here');
  ok(/existing: \{ since: stamp\(user\.metadata && user\.metadata\.creationTime\) \|\| null \}/.test(body),
    'the message is rendered for a member, dated from Auth\'s creationTime');
  ok(/await sleep\(PACE_MS\)/.test(body) && PACE_MS === 1000,
    'one message a second');

  /* Every log and warning line in main(): an address reaches it through
     redact() or not at all, and never an error's message text. */
  const calls = body.match(/\b(log|warn)\(([\s\S]*?)\);\n/g) || [];
  ok(calls.length >= 8, 'the log lines were really found');
  ok(calls.every((l) => !/\bemail\b/.test(l.replace(/redact\(email\)/g, ''))
      && !/user\.email/.test(l) && !/e\.message/.test(l) && !/\blink\b/.test(l)
      && !/generated/.test(l) && !/msg\.(html|text)/.test(l)),
    'no log line names an address (redact() only), a link, a minted code or an error\'s message text');
  ok(calls.some((l) => /redact\(email\)/.test(l)), 'and the redact exemption is exercised, so the check is not vacuous');
  ok(!/console\.log\(msg/.test(body) && !/send\(null/.test(body) && !/dryRun: true/.test(body),
    'the dry run never hands a rendered message to the printing path');

  console.log(fails.length
    ? `verify-existing-users selftest: ${fails.length} FAILED, ${pass} passed\n\n  ${fails.join('\n  ')}`
    : `verify-existing-users selftest: ${pass} checks passed`);
  return fails.length === 0;
}

if (!isMain(import.meta.url)) {
  // imported: the pure halves above are the whole of it
} else if (has('--selftest')) {
  process.exit((await selftest()) ? 0 : 1);
} else {
  main().then((code) => process.exit(code)).catch((e) => {
    console.log('::error::verification campaign failed: ' + e.message);
    process.exit(1);
  });
}
