# The job market tracking sheet → the site

The postings you keep by hand in the job-market Google Sheet are published on
the site automatically. This is how it is wired, what you have to do, and what
happens when something goes wrong.

    the tracking workbook
        |  .github/workflows/oa-jobmarket-sheet.yml   (06:40 UTC, daily)
        |  _scraper/sync-jobmarket-sheet.mjs
        v
    data/jobmarket.json
        |  .github/workflows/oa-jobs-build.yml
        |  _scraper/build-jobs.mjs   (merged with the postings in Firestore)
        v
    data/jobs.json  ->  /jobs.html, /v3/jobs.html, /previous-markets.html

Nothing here needs a credential: the workbook is read over the same public
CSV/HTML endpoints your browser uses. SMTP is optional and only affects the
warning e-mail described at the end.

## What you have to do — once

1. **Share the workbook.** In Google Sheets: *Share → General access →
   Anyone with the link → Viewer*. Without this Google answers with a sign-in
   page and the sync reads nothing (it will tell you so; see *When it goes
   wrong*).
2. **Nothing else.** The workbook currently being read is recorded in
   `data/jobmarket-sheets.json`; it starts at the sheet you gave, and the sync
   moves it on by itself (see *Rolling over to next year's workbook*).

Optional, both set under *Settings → Secrets and variables → Actions*:

| Name | Kind | What it does |
| --- | --- | --- |
| `JOBMARKET_ALERT_TO` | variable | where the "this sheet has gone quiet" e-mail goes. Defaults to the site address. |
| `JOBMARKET_STALE_DAYS` | variable | how many days of silence are normal before it says so. Default 21. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | secrets | already set for the other mailers. Without them the message is printed into the workflow log instead of sent. |

## How the sheet is read

**Tabs.** Every tab named for a year is read, and its name says which kind of
position it holds — `2026 Jobs` (tenure-track) and `2026 NTTPD`
(non-tenure-track and post-docs). Tabs are DISCOVERED, never listed in the
code, so next year's tabs need no change here. A tab with no year in its name
(`Intro`, `Interview Questions`) is left alone, and so are `Q&A` and
`Placements` tabs, which are not lists of postings.

The workbook holds **more than one season** — `2025 Jobs` and `2025 NTTPD` are
read too. Their postings do not appear on the jobs page (it shows the season
under way); they fill *Previous markets*. The reach is the site's own
two-season rule, so it moves by itself each July.

**Columns** are matched by their headers, so inserting a column in the middle
is safe. These are understood, by any of several spellings:

| The site's field | Header it looks for |
| --- | --- |
| Institution | University, Institution, School, Employer |
| Town | City, City/State, Location, Town, Location 2 |
| Country | Country |
| Date posted | Date, Date posted, Posted, Date added |
| Field / department | Field, Area, Department, Discipline |
| Rank | Position, Rank, Title, Level |
| Deadline *(optional)* | Deadline, Apply by, Closing date |
| Advertisement | Link, URL, Job ad, Advert |
| Notes *(optional)* | Notes, Comments, Remarks |

A column it does not recognise is **reported in the workflow log and ignored** —
never guessed at. In your workbook that is `Salary`, `Teaching Load`,
`# of Positions` and the whole interview/flyout/offer tracking block, none of
which the site has a field for. If one of them matters, say so and it will be
added to the table above rather than inferred.

**Where the header is ambiguous, the data decides.** Your two tabs head the
institution column differently — `School` in the NTT/PD tab, but `Location` in
the Jobs tab, where the town is `Location 2` — so the word "Location" means the
institution in one tab and the town in the other. No table of aliases can tell
those apart, so when the header does not name the institution, it is found in
the data instead (the country column is the one holding countries; the
institution is the prose column before it). Everything the header *does* name —
the deadline above all — is still taken from the header. The log says when this
happened.

If a tab has no header row at all, the same reading is used for every column.

**A link must be the address itself.** Three postings in `2026 Jobs` and 22 in
`2025 Jobs` have a *hyperlink on words* in the Link column ("Assistant
Professor of Logistics… — HigherEdJobs"). A spreadsheet export carries the
words, not the address, so those postings publish with no advert link and are
counted in the log. Pasting the URL into the cell fixes each one.

**What each posting becomes.** Most of it is a direct copy. Three things are
derived, and it is worth knowing how:

- **Market year** — from the posting's own date, by the site's rule (the season
  rolls on 1 July). A posting dated 20 July 2026 is in the 2026-2027 market,
  whatever the tab is called. Only the current season shows on the jobs page;
  the rest is on *Previous markets*.
- **Entry level** — from the rank you typed. "Visiting Assistant Professor" is
  a *Visiting* post (not an assistant professorship), "Lecturer", "Instructor",
  "Professor of Practice", "Clinical Professor" and "non TTAP" are all
  *Non-tenure track*, "Postdoctoral …" is a *Post-Doc*. A title it cannot place
  becomes *Other Ranks* rather than being dropped.
- **Type of institution** — from the names. "Rutgers Business School" is a
  business school, "Clarkson University" a university. Where neither name says
  ("INSEAD", "Penn State"), the posting simply carries no type and the Type
  filter passes over it. To fix one, name the school in the field column.

**What is kept that the site has no field for**: the job title exactly as you
typed it, and the town, both shown on the card's comments line — so nothing you
record is lost even though the site's own posting form never asked for it.

**A deadline is not invented.** With no deadline column the posting reads
"Until filled.", which is what the site's Deadline filter already calls a
posting with no closing date. Put a date in a `Deadline` column and it is used.

## When the same posting is in both places

A school advertising on a given day is often in your sheet *and* posted through
the site's own form. Where both know a posting, **the site's copy stands and
the sheet's is left alone** — the site's has the full department name, the type
of institution, the teaching characteristics and the uploaded advert, where the
sheet has a one-line note. The log says how many were held back that way (13,
the first time it ran against your workbook).

## Editing, and removing

The sheet is where these postings live. Edit a row and the change reaches the
site at the next run; **delete a row and the posting comes off the site**.
That is deliberate, and it is why these postings are deliberately NOT copied
into the database the way form submissions are — a copy would win over your
sheet at the next build and a deleted row could never leave.

The one exception is `data/jobs-hidden.json`, the maintainer's suppression
list: an id in there is withheld whatever the sheet says.

## Rolling over to next year's workbook

At the end of a cycle your intro tab links to the next workbook. The sync reads
that link out of the sheet (the CSV export cannot see it — it is a hyperlink on
words, so the HTML view is read instead), records the new workbook in
`data/jobmarket-sheets.json`, and starts reading it straight away.

It becomes *the* workbook on **evidence, never on a date**: only once it holds a
posting newer than anything in the one it replaces. A workbook created in
advance and left empty does not take over. The previous workbook keeps being
read afterwards, because the last postings of a season are usually filed into it
for weeks after the new one opens.

Nothing has to be done by hand at the roll. If you ever want to point it
somewhere else immediately, run the workflow by hand with the `sheet` input set
to the new workbook's id (the long string in its URL).

## When it goes wrong

You get ONE e-mail, then not another for a week unless something different
happens:

- **"nothing new for N days"** — the sheet has not gained a posting in three
  weeks (change with `JOBMARKET_STALE_DAYS`). Either the market is quiet or the
  sheet has been forgotten.
- **"could not be read"** — usually the sharing was changed back to private.
- **"read but held no postings"** — the tabs were renamed to something with no
  year in it, or the columns were rearranged past recognition.

In every one of those cases **nothing already published is removed**. The site
keeps what it has and simply stops gaining postings, which is exactly why the
e-mail exists: from the site alone, that is indistinguishable from a quiet
August.

Two more guards, in the workflow rather than the inbox:

- If any workbook in scope cannot be read, **nothing is written at all** — a
  partial read that still wrote would delete every posting that workbook holds.
- A read that comes back with less than half the postings already published is
  **refused** and reported, because that is what a renamed tab looks like.

## Running it by hand

From *Actions → OA jobs — read the job market tracking sheet → Run workflow*:

| Input | What it does |
| --- | --- |
| `scan` | lists the workbooks in scope and stops. Fetches nothing. |
| `dry_run` | reads everything, prints what would change, writes nothing. |
| `no_mail` | prints the warning e-mail instead of sending it. |
| `sheet` | read this workbook id instead of the recorded one. |
| `min_year` | the oldest market year to keep (blank = the site's own rule). |

Locally, the same script — but note that the network in a sandboxed
environment usually blocks `docs.google.com`, so a real read only happens on a
GitHub runner:

    node _scraper/sync-jobmarket-sheet.mjs --scan
    node _scraper/sync-jobmarket-sheet.mjs --dry-run --no-mail

The offline checks, which need no network at all and cover every rule described
above, are part of the main suite:

    node _scraper/selftest.mjs
