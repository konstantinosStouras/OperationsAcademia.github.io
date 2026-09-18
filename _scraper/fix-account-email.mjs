#!/usr/bin/env node
/**
 * CORRECT A MISTYPED SIGN-IN ADDRESS, one account at a time.
 *
 * An address is typed by a person at registration and nothing on the way in
 * can tell a typo from a real domain: `yh3660@columbia.edi` was accepted,
 * looked exactly like `columbia.edu` on the roster, and only announced itself
 * when the verification campaign's message bounced with "the domain
 * columbia.edi couldn't be found" (owner, 2026-09-17, forwarding the bounce).
 *
 * Such an account is STUCK and cannot get itself out. The address is the
 * account's identity, so the person cannot change it from the site; every
 * write they make is refused because `verified()` reads `email_verified` and
 * it can never become true; and the campaign that would ask them to confirm
 * has already stamped `verifyMail/{uid}.campaignAt`, so it will never write to
 * them again. Only the Admin SDK can correct it, which is why this is a
 * script and not a page.
 *
 * WHAT IT IS NOT. It is not a way to move an account to a different person's
 * address. Four guards make it a CORRECTION rather than a transfer, and the
 * run refuses rather than guessing at any of them:
 *
 *   1. the account is found by its CURRENT address (or its uid), and the
 *      stored address must equal `--from` exactly, so a stale instruction
 *      cannot land on whoever holds that address now;
 *   2. the new address must not already belong to another account, or the
 *      update would fail at Auth anyway and the log would be the only record;
 *   3. the LOCAL PART must be unchanged unless `--allow-local-change` is
 *      passed. A typo worth fixing here is a domain somebody mistyped; a
 *      different mailbox is a different person, and that is the line;
 *   4. nothing is written without `--write`. The default prints the plan.
 *
 * AND A PLAN THAT SAYS NO IS AN ANSWER. A refusal here is nearly always a fact
 * about the world rather than a mistake in the instruction, so without
 * `--write` it is a `::warning::` and the run is GREEN: the owner pressed a
 * button to ask a question and got a true reply. With `--write` it stays an
 * error, because there the owner asked for a change that did not happen.
 * `nextStep` says what to do about each refusal, since “refused” on its own is
 * a red run and a dead end — which is exactly how the reported case read.
 *
 * WHAT IT WRITES. `email` and `emailVerified: false` on the Auth record, and
 * then it DELETES `verifyMail/{uid}` so the campaign's once-only mark and its
 * rate limit are clear and the next press of
 * `.github/workflows/oa-verify-existing.yml` sends that account the site's
 * ordinary verification message. It sends nothing itself: one definition of
 * the verification e-mail (`renderVerifyEmail` + `siteVerifyLink`) already
 * exists and a second sender here would be the drift this repository forbids
 * everywhere.
 *
 * WHAT IT DELIBERATELY LEAVES. `userDirectory/{uid}.email` is corrected by
 * the next roster sync, which reads the address from Auth and drops one Auth
 * no longer has; and `accountKeys/email:<sha256>` still names the account
 * under the OLD address's digest, which the browser re-claims on that
 * account's next sign-in. Both self-heal, and neither is worth a second
 * writer here.
 *
 * THE LOG IS PUBLIC. A dispatched run prints into the Actions log of a public
 * repository, so every line carries the uid and a REDACTED address, never a
 * whole one and never a name.
 *
 *   node _scraper/fix-account-email.mjs --from=a@b.edi --to=a@b.edu
 *   node _scraper/fix-account-email.mjs --from=a@b.edi --to=a@b.edu --write
 *   node _scraper/fix-account-email.mjs --selftest
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMain } from './_main.mjs';
import { firebaseAdmin, redact } from './_mail.mjs';

/** The local part and the domain, or null when it is not one address. */
export function parts(address) {
  const s = String(address || '').trim();
  // one @, something either side, a dot in the domain, no whitespace
  const m = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/.exec(s);
  return m ? { local: m[1], domain: m[2].toLowerCase() } : null;
}

/**
 * Whether this correction is allowed, and why not when it is not.
 *
 * Pure, so the whole decision is testable without Auth: the caller hands in
 * what it read. `holder` is the account that already has the NEW address, or
 * null.
 */
export function check({ account, from, to, holder, allowLocalChange = false }) {
  const f = parts(from), t = parts(to);
  if (!f) return { ok: false, code: 'from', why: '--from is not an e-mail address' };
  if (!t) return { ok: false, code: 'to', why: '--to is not an e-mail address' };
  if (f.local === t.local && f.domain === t.domain) {
    return { ok: false, code: 'same', why: 'the two addresses are the same' };
  }
  if (!account) return { ok: false, code: 'missing', why: 'no account holds that address' };
  if (String(account.email || '').toLowerCase() !== String(from).trim().toLowerCase()) {
    return { ok: false, code: 'stale', why: 'that account’s address is not the one given, so the instruction is stale' };
  }
  if (holder && holder.uid !== account.uid) {
    return { ok: false, code: 'held', why: 'another account already holds the new address' };
  }
  if (f.local !== t.local && !allowLocalChange) {
    return {
      ok: false,
      code: 'local',
      why: 'the local part would change, which is a different mailbox rather than ' +
           'a mistyped domain; pass --allow-local-change if that is really meant',
    };
  }
  return { ok: true, code: '', why: '' };
}

/**
 * What to do about a refusal, in the reader's own terms.
 *
 * A refusal here is usually a fact about the world rather than a mistake in
 * the instruction, and the one that was reported — `held` — is the clearest
 * case: both addresses belong to accounts, so the person registered twice and
 * there is nothing here to correct. Saying only “refused” leaves the owner
 * with a red run, a true answer they cannot read, and no next step. Pure, so
 * the wording is pinned rather than remembered.
 */
export function nextStep(code, { account, holder, from, to } = {}) {
  const f = parts(from), t = parts(to);
  const mine = account && account.uid ? account.uid : 'that account';
  switch (code) {
    case 'held':
      return 'Both addresses belong to accounts, so nothing here can be corrected: ' +
        `${mine} holds the mistyped one and ${holder && holder.uid ? holder.uid : 'another account'} ` +
        'holds the corrected one' +
        (f && t && f.local === t.local ? ', under the same mailbox name, so it is one person who registered twice' : '') +
        '. Keep the account on the corrected address and delete the stuck one from the ' +
        'roster on /admin-area. An unverified password account can do nothing itself, ' +
        'which is why the roster is where it goes.';
    case 'missing':
      return 'Nobody holds the address given, so either it has already been corrected ' +
        '(check the roster on /admin-area) or the address to look for is not the one typed. ' +
        'Press this again with --uid if the roster names the account.';
    case 'stale':
      return 'The account was found but its stored address is something else now, so this ' +
        'instruction is out of date. Read the address off the roster on /admin-area and press again.';
    case 'local':
      return 'A different mailbox is a different person, which is the line this script keeps. ' +
        'Tick allow_local_change only if the new mailbox really is the same person’s.';
    case 'same':
      return 'There is nothing to do: the two addresses are one address.';
    case 'from':
      return 'The address to look for is not an e-mail address. Read it off the roster ' +
        'on /admin-area, or press this again with --uid instead.';
    case 'to':
      return 'The corrected address is not an e-mail address. Check what was typed and press again.';
    default:
      return 'Check the two addresses and press again.';
  }
}

/* ------------------------------------------------------------------ the run */

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

async function main() {
  const from = arg('from');
  const to = arg('to');
  const uid = arg('uid');
  const write = process.argv.includes('--write');
  const allowLocalChange = process.argv.includes('--allow-local-change');

  if (!to || (!from && !uid)) {
    console.log('usage: --to=<new address> with --from=<current address> or --uid=<uid>');
    console.log('       --write to apply it; without it this prints the plan');
    process.exitCode = 2;
    return;
  }

  const admin = await firebaseAdmin();
  if (!admin) {
    console.log('::warning::FIREBASE_SERVICE_ACCOUNT is not set: no account was read.');
    return;
  }
  const { auth, db } = admin;

  const lookup = async (fn) => {
    try { return await fn(); } catch (err) {
      if (err && err.code === 'auth/user-not-found') return null;
      throw err;
    }
  };

  const account = uid
    ? await lookup(() => auth.getUser(uid))
    : await lookup(() => auth.getUserByEmail(from));
  const holder = await lookup(() => auth.getUserByEmail(to));

  const verdict = check({
    account,
    from: from || (account && account.email) || '',
    to,
    holder,
    allowLocalChange,
  });

  if (!verdict.ok) {
    /* A PLAN THAT SAYS NO IS AN ANSWER, NOT A FAILED RUN. Without --write this
       button is a question — can this address be corrected? — and “no, because
       another account already holds it” answers it completely. Exiting 1 there
       turned the Actions tab red over a true answer, with nothing a commit
       could ever make green: the crying-wolf cost this repository has paid
       before, and it read as the tool being broken rather than as the reply it
       was (owner, 2026-09-17, pressing it for `yh3660@columbia.edi`).

       With --write it stays an error, and that asymmetry is the whole rule: the
       owner asked for a change, the change did not happen, and a green run
       there would read as “done”. */
    const how = write ? '::error::' : '::warning::';
    console.log(`${how}refused: ${verdict.why}`);
    console.log(nextStep(verdict.code, { account, holder, from: from || (account && account.email) || '', to }));
    if (write) process.exitCode = 1;
    else console.log('plan only: nothing was written, and nothing is wrong with this run.');
    return;
  }

  console.log(`account ${account.uid}: ${redact(account.email)} -> ${redact(to)}`);
  console.log(`  providers: ${(account.providerData || []).map((p) => p.providerId).join(', ') || 'none'}`);
  console.log(`  verified now: ${account.emailVerified}; after: false, so the address must be confirmed`);

  if (!write) {
    console.log('plan only: nothing written. Pass --write to apply it.');
    return;
  }

  await auth.updateUser(account.uid, { email: to, emailVerified: false });
  console.log('  address corrected in Auth');

  /* The campaign's once-only mark AND its rate limit live here, and the mark
     was stamped by the send that bounced. Left in place, the account can
     never be asked to confirm. */
  try {
    await db.collection('verifyMail').doc(account.uid).delete();
    console.log('  verifyMail cleared, so the campaign can write to them again');
  } catch (err) {
    console.log(`::warning::could not clear verifyMail/${account.uid}: ${(err && err.code) || 'unknown'}` +
      ' — the campaign will skip this account until it is removed by hand');
  }

  console.log('Next: press oa-verify-existing.yml with send ticked to ask them to confirm it.');
}

/* ------------------------------------------------------------- the selftest */

function selftest() {
  let pass = 0, fail = 0;
  const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + what); } };
  const acc = { uid: 'u1', email: 'yh3660@columbia.edi' };

  ok(parts('a@b.edu').domain === 'b.edu', 'parts reads the domain');
  ok(parts('a@b.edu').local === 'a', 'and the local part');
  ok(parts('nope') === null, 'and refuses a non-address');
  ok(parts('a@b') === null, 'and a domain with no dot');
  ok(parts('a b@c.edu') === null, 'and whitespace');

  // the owner's own case
  ok(check({ account: acc, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edu', holder: null }).ok,
    'the reported typo is allowed');
  // case in the stored address must not matter
  ok(check({ account: { uid: 'u1', email: 'YH3660@Columbia.edi' }, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edu', holder: null }).ok,
    'and the stored address is compared without case');

  const refuses = (opts, needle, what) => {
    const v = check(opts);
    ok(!v.ok && v.why.indexOf(needle) !== -1, what + ' (got: ' + v.why + ')');
  };
  refuses({ account: null, from: 'a@b.edi', to: 'a@b.edu', holder: null },
    'no account', 'an address nobody holds is refused');
  refuses({ account: { uid: 'u1', email: 'someone@else.edu' }, from: 'a@b.edi', to: 'a@b.edu', holder: null },
    'stale', 'an account whose address has since changed is refused');
  refuses({ account: acc, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edu', holder: { uid: 'u2' } },
    'already holds', 'a new address another account holds is refused');
  refuses({ account: acc, from: 'yh3660@columbia.edi', to: 'someone.else@columbia.edu', holder: null },
    'local part', 'a different mailbox is refused by default');
  ok(check({ account: acc, from: 'yh3660@columbia.edi', to: 'someone.else@columbia.edu', holder: null, allowLocalChange: true }).ok,
    'and allowed only when that is said outright');
  refuses({ account: acc, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edi', holder: null },
    'the same', 'a no-op is refused');
  refuses({ account: acc, from: 'yh3660@columbia.edi', to: 'not an address', holder: null },
    '--to', 'a junk target is refused');

  /* EVERY REFUSAL CARRIES A CODE, and `nextStep` answers every one of them.
     Pinned BOTH WAYS off the codes `check` can really return, so a refusal
     added without a next step, or a next step for a code nobody returns,
     fails here rather than reaching the owner as a dead end. */
  const CODES = ['from', 'to', 'same', 'missing', 'stale', 'held', 'local'];
  const seen = [
    check({ account: acc, from: 'nope', to: 'a@b.edu', holder: null }),
    check({ account: acc, from: 'a@b.edi', to: 'nope', holder: null }),
    check({ account: acc, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edi', holder: null }),
    check({ account: null, from: 'a@b.edi', to: 'a@b.edu', holder: null }),
    check({ account: { uid: 'u1', email: 'someone@else.edu' }, from: 'a@b.edi', to: 'a@b.edu', holder: null }),
    check({ account: acc, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edu', holder: { uid: 'u2' } }),
    check({ account: acc, from: 'yh3660@columbia.edi', to: 'other@columbia.edu', holder: null }),
  ].map((v) => v.code);
  ok(seen.join(',') === CODES.join(','), 'every refusal carries its own code (got: ' + seen.join(',') + ')');
  ok(check({ account: acc, from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edu', holder: null }).code === '',
    'and an allowed correction carries none');
  const generic = nextStep('something-nobody-returns');
  ok(CODES.every((c) => nextStep(c, { account: acc, holder: { uid: 'u2' }, from: 'a@b.edi', to: 'a@b.edu' }) !== generic),
    'nextStep answers every code with something of its own');

  /* The owner's own refusal: it must name both accounts and where to go. */
  const held = nextStep('held', {
    account: acc, holder: { uid: 'u2' },
    from: 'yh3660@columbia.edi', to: 'yh3660@columbia.edu',
  });
  ok(held.indexOf('u1') !== -1 && held.indexOf('u2') !== -1, 'the held refusal names both accounts');
  ok(held.indexOf('/admin-area') !== -1, 'and sends the owner to the roster');
  ok(held.indexOf('registered twice') !== -1, 'and says it is one person, the local parts being equal');
  ok(nextStep('held', {
    account: acc, holder: { uid: 'u2' },
    from: 'yh3660@columbia.edi', to: 'someone.else@columbia.edu',
  }).indexOf('registered twice') === -1, 'and does NOT say so when the mailbox differs');

  /* THE LOG IS PUBLIC: no line may carry a whole address or a name. Read this
     file's own source, the way the roster sync's suite does. */
  const src = readOwnSource();
  const logs = src.split('\n').filter((l) => /console\.log\(/.test(l));
  ok(logs.length > 0, 'there are log lines to sweep');
  ok(!logs.some((l) => /\$\{(from|to|account\.email)\}/.test(l) && !/redact\(/.test(l)),
    'no log line interpolates a whole address without redacting it');
  ok(!logs.some((l) => /displayName/.test(l)), 'and none prints a name');
  ok(/redact\(account\.email\)/.test(src) && /redact\(to\)/.test(src),
    'both addresses are printed redacted');
  ok(!/--write/.test(src.slice(src.indexOf('await auth.updateUser')))
     || src.indexOf('if (!write)') < src.indexOf('await auth.updateUser'),
    'the plan-only return comes BEFORE the write');

  /* A PLAN THAT SAYS NO EXITS 0, and only --write makes a refusal an error.
     Read from the refusal branch alone, bounded at both ends and its length
     asserted — this file EXPLAINS the exit it no longer takes, so a scan over
     the whole of it would be satisfied by deleting the explanation. */
  const refuseAt = src.indexOf('if (!verdict.ok) {');
  const refuseEnd = src.indexOf('\n  }\n', refuseAt);
  ok(refuseAt > 0 && refuseEnd > refuseAt, 'the refusal branch is where it was');
  const branch = src.slice(refuseAt, refuseEnd);
  ok(branch.length > 200 && branch.length < 1800, 'and the slice is the branch (' + branch.length + ' chars)');
  ok(/if \(write\) process\.exitCode = 1;/.test(branch),
    'a refusal fails the run only when --write was passed');
  ok(!/^\s*process\.exitCode = 1;/m.test(branch), 'and never unconditionally');
  ok(/write \? '::error::' : '::warning::'/.test(branch),
    'and it is an ::error:: only with --write, a ::warning:: otherwise');
  ok(/nextStep\(verdict\.code/.test(branch), 'and every refusal prints its next step');

  console.log(`fix-account-email selftest: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

function readOwnSource() {
  return readFileSync(fileURLToPath(import.meta.url), 'utf8');
}

if (isMain(import.meta.url)) {
  if (process.argv.includes('--selftest')) selftest();
  else main().catch((err) => { console.error(err); process.exitCode = 1; });
}
