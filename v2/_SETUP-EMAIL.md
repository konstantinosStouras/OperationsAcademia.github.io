# Switching on the e-mail side

Two scheduled jobs send mail:

| | what it sends | cadence |
|---|---|---|
| `v2/_scraper/alerts-mailer.mjs` | e-mail alert digests to subscribers | hourly |
| `v2/_scraper/feedback-mailer.mjs` | new feedback to you, a receipt to the submitter, and the "your feedback is resolved" e-mail | twice an hour, and on any push adding a resolution file |

Both are **no-ops without credentials**, and both print exactly what they would
have sent instead. So you can run them today and read the output.

```bash
node v2/_scraper/alerts-mailer.mjs --selftest     # 21 offline checks
node v2/_scraper/feedback-mailer.mjs --selftest   # 20 offline checks
node v2/_scraper/alerts-mailer.mjs --scan         # which alerts are due
node v2/_scraper/alerts-mailer.mjs --dry-run      # render every message, send none
```

---

## 1. Choose a mailbox to send from

Anything that speaks SMTP works. Two sensible options:

**A Gmail account with an app password.** Free, and you already have
`operations.academia@gmail.com`. Turn on 2-step verification, then create an
app password (Google Account → Security → App passwords). Limit: ~500
recipients a day, which is fine at this size and *not* fine if the alert list
grows into the thousands.

- `SMTP_HOST` `smtp.gmail.com`, `SMTP_PORT` `587`
- `SMTP_USER` the full address, `SMTP_PASS` the 16-character app password

**A transactional provider** (Postmark, Mailgun, SES, Resend). Worth moving to
the moment alerts have real volume: they handle bounces, complaints, and the
DNS records below, and they will tell you when you are being filtered. Free
tiers are typically 100–3,000 messages a month.

## 2. Set the repository secrets and variables

Settings → Secrets and variables → Actions.

**Secrets** (hidden):

| Name | Value |
|---|---|
| `SMTP_HOST` | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | `587` (or `465` for implicit TLS — the code switches on this) |
| `SMTP_USER` | the mailbox |
| `SMTP_PASS` | the app password or API key |
| `FIREBASE_SERVICE_ACCOUNT` | already set in `_SETUP-FIREBASE.md` step 5 |

**Variables** (visible, and fine to be):

| Name | Value | Default if unset |
|---|---|---|
| `MAIL_FROM` | `Operations Academia <no-reply@operationsacademia.org>` | `Operations Academia <SMTP_USER>` |
| `FEEDBACK_TO` | where feedback lands | `kstouras@gmail.com` |
| `CONTACT_EMAIL` | the human address in every footer | `kostas.stouras@ucd.ie` |
| `SITE_URL` | absolute site root | `https://www.operationsacademia.org` |

## 3. Make the mail actually arrive

This is the part that gets skipped and then costs a term of silent
non-delivery. If you send from an `@operationsacademia.org` address, publish
these DNS records:

- **SPF** — a `TXT` record on the domain listing who may send as you, e.g.
  `v=spf1 include:_spf.google.com ~all`.
- **DKIM** — the signing key your provider gives you, as a `TXT` record on the
  selector they name.
- **DMARC** — a `TXT` record at `_dmarc.operationsacademia.org`, starting at
  `v=DMARC1; p=none; rua=mailto:you@…` so you get reports before you enforce.

Without SPF and DKIM, alert digests go to spam for most academic mail systems,
and you will not be told.

If you send from Gmail's own domain instead (`…@gmail.com`), skip this — but
set `MAIL_FROM` to that same Gmail address. A `From:` your SMTP server is not
authorised to send is the single most common reason mail disappears.

## 4. Check it

1. Actions → **OA alerts — send what is due** → Run workflow, with **scan**
   ticked. It lists every subscription and whether it is due, and sends nothing.
2. Run it again with **dry_run** ticked. It renders each message and prints it.
3. Run it for real. Check the mailbox, and check the spam folder — if it landed
   there, go back to step 3.
4. For feedback: submit something on `/v2/feedback.html` with your own address,
   then run **OA feedback — forward and resolve**. You should get two messages:
   the maintainer copy with the screenshot attached, and a receipt.

---

## How an alert decides what to send

Worth understanding, because it explains the two things people ask about.

Each subscription carries its own **high-water mark** (`lastSentAt`), advanced
**only when its own send succeeds**. So:

- a transient SMTP failure retries *that* subscription next hour, rather than
  skipping its window;
- a run that dies halfway does not silently swallow a day of postings for
  everyone after it in the list.

A subscription with nothing new is **not a send**. It advances `lastCheckedAt`
and stays quiet — nobody gets a "no new postings today" e-mail.

Matching uses `v2/assets/oa-alert-match.js`, which is the *same file* the alerts
page loads in the browser. That is deliberate: it means the preview a subscriber
sees while creating an alert and the e-mail they later receive cannot disagree.
Change the matching rules in that one file and both sides move together.

## Closing a feedback ticket

Add `v2/_feedback-resolutions/<TICKET>.md` and push. See the README in that
directory. The mailer closes the ticket in Firestore **first** and then e-mails
the submitter, so a mail failure retries only the notification and can never
lose the record that you dealt with it.

Never put the submitter's name or address in one of those files — the
repository is public, and the mailer looks them up by ticket number.
