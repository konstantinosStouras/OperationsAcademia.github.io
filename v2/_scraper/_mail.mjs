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
 * Returns true when it was actually accepted for delivery.
 */
export async function send(tx, msg, { dryRun = false } = {}) {
  const full = {
    from: fromAddress(),
    ...msg,
    text: msg.text || toPlain(msg.html || ''),
  };
  if (!tx || dryRun) {
    console.log(`\n--- ${dryRun ? 'DRY RUN' : 'NO SMTP'}: would send ---`);
    console.log(`To:      ${full.to}`);
    console.log(`Subject: ${full.subject}`);
    if (full.replyTo) console.log(`Reply-To: ${full.replyTo}`);
    console.log(full.text.slice(0, 800));
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

/** The Firebase Admin SDK, or null. Shared so both mailers report the same
    thing when the credential is missing or malformed. */
export async function firestore() {
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
  return app.firestore();
}
