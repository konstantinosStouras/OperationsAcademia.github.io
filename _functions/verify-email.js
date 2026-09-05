/* ---------------------------------------------------------------------------
   Operations Academia. The verification e-mail a new account is sent.

   A person who registers with an e-mail address and a password receives this
   message and must press its button before the account can be used. It is
   rendered here, inside the functions directory, because `firebase deploy`
   ships only this directory: the site's other mailers share `_scraper/_mail.mjs`,
   and a deployed function cannot require a file that is not in its upload.
   So this file copies the SHAPE of that module (a 600px table, an escaper, a
   plain-text alternative) and depends on nothing.

   The palette is the live site's, from assets/v3.css: page ground #f8f7f4,
   card #ffffff on a 1px #ccd1d7 border, ink #22272e, secondary #454c56,
   muted #646c78, and the site's charcoal button #3a424d with white text. The
   heading is set in Georgia because the site's Fraunces cannot be embedded in
   an e-mail; the body in Inter with Helvetica and Arial behind it.

   Copy rules for this file: plain English, no em dashes (a comma or a full
   stop instead), and the link written out in full as TEXT as well as behind
   the button, so a reader whose client strips the button can still copy it.
   --------------------------------------------------------------------------- */

'use strict';

const SITE_DEFAULT = 'https://www.operationsacademia.org';
const CONTACT_DEFAULT = 'operationsacademia@gmail.com';

/* The site's own colours, named once. */
const C = {
  ground: '#f8f7f4',
  card: '#ffffff',
  line: '#ccd1d7',
  ink: '#22272e',
  ink2: '#454c56',
  muted: '#646c78',
  button: '#3a424d',
  onButton: '#ffffff',
};

/* The dark inbox: the live site's own dark theme, from assets/v3.css. The
   head declares both colour schemes, so a client that honours the
   declaration expects the message to carry the dark half itself; without
   this block it would show the light card unchanged on a dark inbox. */
const D = {
  ground: '#0d0f12',
  card: '#15181d',
  line: '#363d47',
  ink: '#eef0f2',
  ink2: '#c5cad1',
  muted: '#8d949e',
  button: '#c6ccd4',
  onButton: '#0d0f12',
};

const BODY_FONT = "Inter, Helvetica, Arial, sans-serif";
const HEAD_FONT = "Georgia, 'Times New Roman', serif";

/** How long a first name may be before it is not a name. */
const NAME_MAX = 60;

/** The first name the greeting may use, or nothing. The profile is the one
    document an unverified account may write, and its owner may be somebody
    who registered with a stranger's address: a "first name" that is a
    sentence, a link or an address would then reach that stranger in a
    message from the site's own mailbox. So a name is used only when it looks
    like one: short, on one line, and carrying no address or link. Anything
    else falls back to a bare "Hello,". */
function greetingName(firstName) {
  const n = String(firstName || '').replace(/\s+/g, ' ').trim();
  if (!n || n.length > NAME_MAX) return '';
  if (/https?:|www\.|@|\//i.test(n)) return '';
  return n;
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** A break opportunity after every ? & and % of an ESCAPED address, for the
    copy of the link that is printed as text: Outlook on Windows ignores
    word-break, and a 190-character link with nowhere to break widens the
    card. <wbr> is not copied by any client, so what the reader copies is the
    address unchanged. The `&amp;` is matched whole, so the entity survives. */
function breakable(escaped) {
  return String(escaped || '').replace(/(\?|&amp;|%)/g, '$1<wbr>');
}

/** The host a site address is shown as: "operationsacademia.org", never the
    scheme and never the www. */
function hostOf(site) {
  return String(site || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
}

/** A readable plain-text alternative. Every message must carry one: an
    HTML-only e-mail scores worse with spam filters and is unreadable in a
    text client. Conditional comments go first, so the Outlook copy of the
    button does not print its label twice. */
function toPlain(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
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
    .replace(/&middot;/g, '.')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

/**
 * The chrome every message from this address shares: the page ground, the
 * logo and wordmark, one white card, and the footer naming the site and the
 * contact address. `bodyHtml` goes inside the card as it is.
 */
function brandShell({ title, preheader, bodyHtml, site, contact }) {
  const S = String(site || SITE_DEFAULT).replace(/\/+$/, '');
  const K = String(contact || CONTACT_DEFAULT);
  const host = hostOf(S);

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${esc(title)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  a { color: ${C.ink}; }
  @media (prefers-color-scheme: dark) {
    .oa-ground { background-color: ${D.ground} !important; }
    .oa-card { background-color: ${D.card} !important; border-color: ${D.line} !important; color: ${D.ink} !important; }
    .oa-ink, .oa-card a { color: ${D.ink} !important; }
    .oa-ink2 { color: ${D.ink2} !important; }
    .oa-muted, .oa-muted a { color: ${D.muted} !important; }
    .oa-card .oa-btn { background-color: ${D.button} !important; color: ${D.onButton} !important; }
  }
</style>
</head>
<body class="oa-ground" style="margin:0;padding:0;background-color:${C.ground};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.ground};">${esc(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="oa-ground" style="background-color:${C.ground};">
 <tr><td align="center" style="padding:28px 12px 32px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

   <tr><td style="padding:0 4px 18px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
     <tr>
      <td style="padding-right:12px;vertical-align:middle;">
       <a href="${esc(S)}" style="text-decoration:none;">
        <img src="${esc(S)}/images/OA-logo-solo.png" width="29" height="40" alt="Operations Academia logo" style="display:block;border:0;outline:none;height:40px;width:29px;">
       </a>
      </td>
      <td style="vertical-align:middle;font-family:${HEAD_FONT};font-size:20px;line-height:1.2;color:${C.ink};">
       <a href="${esc(S)}" class="oa-ink" style="color:${C.ink};text-decoration:none;">Operations Academia<span class="oa-muted" style="color:${C.muted};">.org</span></a>
      </td>
     </tr>
    </table>
   </td></tr>

   <tr><td class="oa-card" style="background-color:${C.card};border:1px solid ${C.line};border-radius:14px;padding:32px 36px;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:${C.ink};">
${bodyHtml}
   </td></tr>

   <tr><td class="oa-muted" style="padding:18px 8px 0;font-family:${BODY_FONT};font-size:13px;line-height:1.6;color:${C.muted};">
    Operations Academia, <a href="${esc(S)}" class="oa-muted" style="color:${C.muted};">${esc(host)}</a>, questions to <a href="mailto:${esc(K)}" class="oa-muted" style="color:${C.muted};">${esc(K)}</a>
   </td></tr>

  </table>
 </td></tr>
</table>
</body>
</html>`;
}

/**
 * The verification message itself: one heading, one button, and the link
 * written out. Returns { subject, html, text }.
 *
 *   firstName   what the profile holds, or nothing
 *   email       where it is going (only used in the preheader)
 *   link        the verify-email.html address carrying the code
 *   site        absolute site root, default the live site
 *   contact     the address questions go to
 */
function renderVerifyEmail({ firstName, email, link, site, contact }) {
  const S = String(site || SITE_DEFAULT).replace(/\/+$/, '');
  const K = String(contact || CONTACT_DEFAULT);
  const host = hostOf(S);
  const name = greetingName(firstName);
  const L = String(link || '');

  const subject = 'Verify your e-mail address for Operations Academia';
  const greeting = name ? `Hello ${esc(name)},` : 'Hello,';
  const greetingText = name ? `Hello ${name},` : 'Hello,';
  const label = 'Verify my e-mail address';

  /* The button: a VML roundrect for Outlook on Windows, and for every other
     client a padded link that draws the pill itself. The cell around them
     carries NO colour of its own: Outlook honours bgcolor on a cell and
     ignores border-radius, so a coloured cell the size of the roundrect
     painted a square block behind the rounded one. */
  const button = `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
 <tr>
  <td align="center">
   <!--[if mso]>
   <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(L)}" style="height:48px;v-text-anchor:middle;width:280px;" arcsize="50%" stroke="f" fillcolor="${C.button}">
    <w:anchorlock/>
    <center style="color:${C.onButton};font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;">${label}</center>
   </v:roundrect>
   <![endif]-->
   <!--[if !mso]><!-->
   <a href="${esc(L)}" class="oa-btn" style="display:inline-block;padding:14px 26px;border-radius:999px;background-color:${C.button};color:${C.onButton};font-family:${BODY_FONT};font-size:16px;font-weight:600;line-height:1.25;text-decoration:none;">${label}</a>
   <!--<![endif]-->
  </td>
 </tr>
</table>`;

  const bodyHtml = `
<h1 class="oa-ink" style="margin:0 0 18px;font-family:${HEAD_FONT};font-size:28px;line-height:1.2;font-weight:600;color:${C.ink};">One more step</h1>
<p style="margin:0 0 14px;">${greeting}</p>
<p style="margin:0 0 22px;">Thank you for registering with Operations Academia. Please confirm that this is your e-mail address by pressing the button below.</p>
${button}
<p class="oa-ink2" style="margin:26px 0 8px;color:${C.ink2};font-size:15px;">The button opens ${esc(host)}. If it does not work, copy this link into your browser:</p>
<p class="oa-muted" style="margin:0 0 22px;font-size:13px;line-height:1.5;color:${C.muted};word-break:break-all;">${breakable(esc(L))}</p>
<p class="oa-ink2" style="margin:0;color:${C.ink2};font-size:15px;">You will not be able to sign in until your address is verified. If you did not register, you can ignore this message and no account will be used.</p>`;

  const html = brandShell({
    title: subject,
    preheader: `Confirm ${email || 'your address'} to start using Operations Academia.`,
    bodyHtml,
    site: S,
    contact: K,
  });

  /* Written for text rather than stripped from the HTML: a text client has
     no button, so "pressing the button below" would point at nothing and
     the link would sit two paragraphs away from the words that ask for it.
     Here the label and the address are one line. */
  const text = [
    'Operations Academia',
    '',
    'One more step',
    '',
    greetingText,
    '',
    'Thank you for registering with Operations Academia. Please confirm that this is your e-mail address by opening the link below.',
    '',
    `${label}: ${L}`,
    '',
    'You will not be able to sign in until your address is verified. If you did not register, you can ignore this message and no account will be used.',
    '',
    `Operations Academia, ${host}, questions to ${K}`,
  ].join('\n');

  return { subject, html, text };
}

module.exports = { renderVerifyEmail, brandShell, esc, toPlain, greetingName, breakable, NAME_MAX };
