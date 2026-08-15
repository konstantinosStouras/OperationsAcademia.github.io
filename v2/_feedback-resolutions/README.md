# Closing a feedback ticket from this repository

One file per resolved ticket, named after the ticket: `OA-260815-AB12.md`.

Adding one and pushing it does three things on the next scheduled run of
`v2/_scraper/feedback-mailer.mjs`:

1. finds the ticket in Firestore and marks it **closed**, recording what was done;
2. e-mails the submitter your text **verbatim**, with their original message quoted back;
3. leaves the file here as the public record of the fix.

## The format

```markdown
---
ticket: OA-260815-AB12
url: https://www.operationsacademia.org/jobs
---
The deadline shown on the Duke posting was the internal one. It now reads
1 November, which is the date on the official advertisement. Thank you for
spotting it.
```

- **`ticket:`** is optional — the filename is used when it is absent.
- **`url:`** is optional. It becomes a "See it live" button. It must be an
  `https://` link to `operationsacademia.org`; anything else is dropped with a
  warning, because this is the one place a URL reaches a stranger's inbox
  without anyone reading it first.
- Everything after the front matter is the message. Write it to the person who
  reported the problem, not to yourself.

## Two rules

**Never put the submitter's name or e-mail address in one of these files.**
This repository is public. The mailer looks the person up in Firestore by
ticket number — that is the whole reason the ticket number exists.

**Files stay here once added.** They are the record. An unchanged file is
skipped on every subsequent run (its content is hashed onto the ticket), so
leaving it costs nothing. Editing one re-opens the loop and sends a corrected
e-mail, which is the intended way to fix a resolution you got wrong.
