/* ---------------------------------------------------------------------------
   Operations Academia — shared e-mail plumbing.

   Used by alerts-mailer.mjs and feedback-mailer.mjs so that every message the
   site sends carries the same chrome: the same header, the same footnote, and
   a standards-based List-Unsubscribe header so a mail client offers its own
   one-click unsubscribe rather than making the reader hunt for a link.

   INERT WITHOUT CREDENTIALS. `transport()` returns null when SMTP_* is unset,
   and every caller treats that as "print what would have been sent". That is
   what lets these be scheduled before the mailbox exists.

   Environment:
     SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS   the mailbox to send from
     MAIL_FROM      display From:              default "Operations Academia <SMTP_USER>"
     CONTACT_EMAIL  address shown in footers   default operationsacademia@gmail.com
     SITE_URL       absolute site root         default https://www.operationsacademia.org
   --------------------------------------------------------------------------- */

export const SITE = (process.env.SITE_URL || 'https://www.operationsacademia.org')
  .replace(/\/+$/, '');
export const CONTACT = process.env.CONTACT_EMAIL || 'operationsacademia@gmail.com';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * A URL fit to be an href in an e-mail we send.
 *
 * Job-ad links and posting links are submitted by strangers and reach a
 * reader's inbox unreviewed, so the SCHEME is checked here: `javascript:` and
 * `data:` hrefs are phishing and script-injection vectors that esc() cannot
 * catch, because escaping quotes leaves the scheme intact. Only http(s) — the
 * only schemes a job advertisement can legitimately use — survive; anything
 * else returns '' and the caller simply omits the link.
 */
export function safeUrl(u) {
  const s = String(u ?? '').trim();
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : '';
}

/**
 * Fold a value down to something that can safely be an e-mail HEADER.
 *
 * A header ends at the first CR or LF, so a subscriber whose alert is named
 * "News\r\nBcc: everyone@example.com", or a submitter whose address carries a
 * newline, would otherwise have the rest read as further headers. Every message
 * passes through send(), so the guard lives there rather than in each caller.
 */
export function headerSafe(v) {
  if (Array.isArray(v)) return v.map(headerSafe);
  return String(v ?? '')
    // CR, LF, NUL and the other C0/C1 controls, plus the two Unicode line
    // separators a JS engine also treats as newlines.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .trim();
}

/** Nodemailer transport, or null when this environment cannot send. */
export async function transport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    console.log('::warning::nodemailer is not installed — no e-mail will be sent');
    return null;
  }
  const port = Number(SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

export function fromAddress() {
  return process.env.MAIL_FROM ||
    `Operations Academia <${process.env.SMTP_USER || CONTACT}>`;
}

/* --------------------------------------------------------------- rendering */

/**
 * The shell every message shares. `manageUrl` is where the reader goes to
 * change what they receive; pass null for a message nobody subscribed to (a
 * feedback receipt), which then carries no unsubscribe language.
 */
/** `a***@example.org` — enough to recognise, never enough to write to. */
export function redact(email) {
  return String(email || '').split(',').map((one) => {
    const m = one.trim().match(/^([^@]{1,2})[^@]*(@.*)$/);
    return m ? `${m[1]}***${m[2]}` : (one.trim() ? '***' : 'no address');
  }).join(', ');
}

/**
 * An SMTP failure's message, with any address in it taken out.
 *
 * A rejection QUOTES THE RECIPIENT: "550 5.1.1 <someone@example.edu>:
 * Recipient address rejected". Every mailer here logs `err.message` from its
 * catch, and those logs are the Actions log of a PUBLIC repository — so the
 * one line printed when a subscriber's or a poster's address fails is the one
 * line that publishes it, which is exactly what `redact` exists to stop
 * everywhere else. The rule is already written down for the verification
 * callable ("neither is an SMTP error's message text, which quotes the
 * rejected address in full"); this is it, shared, so every mailer keeps it.
 *
 * The message is kept otherwise whole — the code and the reason are what a
 * person needs — and bounded, because a server may return a wall of text.
 */
export function safeError(err) {
  const msg = String((err && err.message) || err || '').slice(0, 500);
  return msg.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    (a) => redact(a));
}

export function shell({ title, bodyHtml, manageUrl, unsubUrl }) {
  const foot = manageUrl
    ? `You are receiving this because you asked Operations Academia to tell you about
       new postings.<br>
       <a href="${esc(manageUrl)}">Change what you receive</a> &middot;
       <a href="${esc(unsubUrl || manageUrl)}">Unsubscribe from these e-mails</a> &middot;
       <a href="${esc(SITE)}/feedback">Send feedback</a><br>
       Questions: <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>`
    : `Operations Academia &middot;
       <a href="${esc(SITE)}">${esc(SITE.replace(/^https?:\/\//, ''))}</a> &middot;
       <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f7fa;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;">
 <tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0"
         style="max-width:600px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;
                font-family:'Source Sans Pro',Helvetica,Arial,sans-serif;color:#222;">
   <tr><td style="background:#3B7DBC;padding:18px 24px;">
     <a href="${esc(SITE)}" style="color:#fff;font-size:19px;font-weight:600;text-decoration:none;">
       Operations Academia</a>
     <div style="color:rgba(255,255,255,.85);font-size:13px;margin-top:2px;">
       Matching supply with demand in the Operations job market</div>
   </td></tr>
   <tr><td style="padding:24px;font-size:15px;line-height:1.6;">
${bodyHtml}
   </td></tr>
   <tr><td style="padding:16px 24px 22px;border-top:1px solid #eee;
                  font-size:12px;line-height:1.6;color:#888;">
${foot}
   </td></tr>
  </table>
 </td></tr>
</table>
</body></html>`;
}

/** A readable plain-text alternative. Every message must carry one: an
    HTML-only e-mail scores worse with spam filters and is unreadable in a
    text client. */
export function toPlain(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<li[^>]*>/gi, '\n  - ')
    .replace(/<\/(p|div|tr|h\d)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&middot;/g, '·')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trimEnd()).join('\n')
    .trim();
}

/**
 * Send one message, or print it when there is no transport.
 *
 * RETURNS TRUE ONLY WHEN THE MESSAGE WAS ACTUALLY HANDED TO A TRANSPORT.
 * Both callers key their Firestore bookkeeping on that — a high-water mark, a
 * `forwarded` flag — so a printed message must never be mistaken for a sent
 * one. A real delivery failure throws instead, and is caught per message.
 */
export async function send(tx, msg, { dryRun = false } = {}) {
  const full = {
    from: fromAddress(),
    ...msg,
    text: msg.text || toPlain(msg.html || ''),
  };

  // Addresses and subjects come from subscribers and submitters, so fold them
  // to a single line before they become headers (see headerSafe).
  for (const k of ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject']) {
    if (full[k] != null) full[k] = headerSafe(full[k]);
  }
  if (full.headers) {
    const h = {};
    for (const k of Object.keys(full.headers)) h[headerSafe(k)] = headerSafe(full.headers[k]);
    full.headers = h;
  }

  if (!tx || dryRun) {
    /* REDACTED. This prints into the Actions log of a PUBLIC repository, and
       the alerts mailer runs as a dry run whenever SMTP is unset — so a
       subscriber's, a poster's or a feedback submitter's address printed
       here in full was world-readable. The same rule the served files are
       held to: nothing public carries an address.

       THE `To:` WAS REDACTED AND THE OTHER TWO LINES WERE NOT, which made the
       redaction decorative. `Reply-To` is the FEEDBACK SUBMITTER's own address
       — that is what it is for — and it was printed whole. And the BODY is
       every one of these messages' worst line: the maintainer's announcement
       carries "Posted by: <name> <address>", a held candidate's e-mail carries
       their name and affiliation weeks before the reveal puts either on the
       site, and the poster's carries their own address. On a runner the body
       is not printed at all; a run on somebody's own machine keeps the preview
       that makes a dry run worth doing, with the addresses in it redacted
       anyway. */
    const onRunner = !!(process.env.GITHUB_ACTIONS || process.env.CI);
    console.log(`\n--- ${dryRun ? 'DRY RUN' : 'NO SMTP'}: would send ---`);
    console.log(`To:      ${redact(full.to)}`);
    console.log(`Subject: ${full.subject}`);
    if (full.replyTo) console.log(`Reply-To: ${redact(full.replyTo)}`);
    console.log(onRunner
      ? `(body withheld: ${full.text.length} characters — a public log is not the place)`
      : full.text.slice(0, 800).replace(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, (a) => redact(a)));
    console.log('--- end ---\n');
    return false;
  }
  await tx.sendMail(full);
  return true;
}

/**
 * The header that lets a mail client offer its own unsubscribe control.
 *
 * Deliberately WITHOUT `List-Unsubscribe-Post: One-Click`. That header is a
 * promise that the URL accepts an unauthenticated POST and unsubscribes on the
 * spot. This site is served by GitHub Pages and cannot accept a POST at all, so
 * declaring it would make Gmail and Outlook show a one-click button that
 * silently does nothing — worse than not offering one. The URL given here is a
 * real link that unsubscribes when opened, and the mailto is a genuine
 * fallback. Add the POST header only alongside an endpoint that honours it.
 */
export function unsubHeaders(manageUrl) {
  return {
    'List-Unsubscribe': `<${manageUrl}>, <mailto:${CONTACT}?subject=unsubscribe>`,
  };
}

/* ------------------------------------------------------------------ admin */

/** The Firebase Admin SDK, or null. Shared so every mailer and the roster
    sync report the same thing when the credential is missing or malformed.
    Returns `{ db, auth }`: the Firestore handle every mailer reads, and the
    Auth handle the two jobs that list accounts need (sync-user-directory.mjs,
    verify-existing-users.mjs). ONE definition of "the Admin SDK, or null". */
export async function firebaseAdmin() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !raw.trim()) return null;
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    try {
      creds = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      console.log('::warning::FIREBASE_SERVICE_ACCOUNT is neither JSON nor base64 JSON');
      return null;
    }
  }
  let admin;
  try {
    admin = await import('firebase-admin');
  } catch {
    console.log('::warning::firebase-admin is not installed');
    return null;
  }
  const app = admin.default || admin;
  if (!app.apps.length) app.initializeApp({ credential: app.credential.cert(creds) });
  return { db: app.firestore(), auth: app.auth() };
}

/** THE MAINTAINER'S OWN UIDS, resolved from Auth by the addresses isAdmin()
    is keyed on. The builds need them for one thing: an upload's Storage path
    is `uploads/{the UPLOADER's uid}/...`, and when the maintainer attaches an
    advert or a CV while correcting somebody else's submission, that uid is
    theirs and not the document's. Checked against the document's owner alone,
    the file was cleared with a warning in a log nobody reads and the
    attachment silently never published.

    ANSWERS AN EMPTY SET RATHER THAN THROWING. Without the credential, or with
    an address Auth has never seen, the builds are left exactly as they were
    before this existed: a path that is not the document owner's is refused.
    Nothing here may be a reason a build stops publishing. */
export async function adminUids(emails) {
  const fb = await firebaseAdmin();
  if (!fb || !fb.auth) return new Set();
  const out = new Set();
  for (const email of emails || []) {
    try {
      const rec = await fb.auth.getUserByEmail(String(email));
      if (rec && rec.uid) out.add(rec.uid);
    } catch { /* no such account: the set is simply smaller */ }
  }
  return out;
}

/** Firestore alone, for the mailers that never touch Auth. */
export async function firestore() {
  const fb = await firebaseAdmin();
  return fb ? fb.db : null;
}
