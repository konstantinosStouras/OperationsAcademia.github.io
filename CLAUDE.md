# Repository conventions

This repo is the source of **operationsacademia.org** (the Operations job
market site), served by GitHub Pages from `master`. No build step — HTML/CSS/JS
are committed and served as-is; the data files under `data/` are written by the
GitHub Actions workflows (`_scraper/` + `.github/workflows/oa-*.yml`) from
Firestore, which is the source of truth for submissions.

`_PLAN.md` is the architecture plan and decision log — consult it before
structural changes (which pages are rebuilt, which are legacy, what is
scheduled for retirement). `_AUDIT.md` records the content audit.

## Three trees, served at once

| Tree | What it is |
|---|---|
| **root** | The live site: the single-page redesign, promoted 2026-08-17. |
| **`/v2/`** | The 2026 vendor-free rebuild — the root between the 16th and the 17th. Archived, working, `noindex`. |
| **`/v1/`** | The 2014-2026 Awesome-Tables site. Archived verbatim, `noindex`. Do not edit: it is a historical record — with the one exception argued under "A link nobody can preview" below, where its pages' own ADDRESSES were re-pointed at themselves. |
| **`/v3/`** | Redirect stubs only. The redesign was previewed here before promotion. |

Three rules hold this together, and **`node _scraper/link-check.mjs` enforces
all of them** (it runs in CI):

1. **No tree navigates into another.** The live site may link an archive's
   FRONT DOOR (`/v1/`, `/v2/`) and nothing deeper; an archived page may point
   back at the live site, which is how a reader who lands on one gets out;
   an archive never reaches into another archive. Break this and nothing 404s
   — the site just quietly becomes two sites, which is precisely what a
   promotion does if the links are not swept.
2. **A tree links to its own pages RELATIVELY.** That is what let the redesign
   be previewed under `/v3/` at all, and what will make the next promotion a
   directory move again.
3. **The shared substrate is absolute and lives at the root**: `/data`,
   `/images`, `/assets/leaflet|css|js|fonts`, `/changelog.json`. Every version
   reads the one copy the workflows write — that is why an archive keeps
   working. A page that moved down a directory with a relative `data/jobs.json`
   would ask for `/v2/data/jobs.json` and render its "could not be loaded"
   state with nothing on screen saying why.

Each archive keeps its OWN frozen `assets/oa-*.js|css` beside it, so the live
site is free to move on. `_scraper/archive-v2.mjs --check` holds `/v2/` to its
archive rules (noindex, a banner with the way back, absolute shared paths, and
no page still claiming through its canonical/og:url to be the home page).

**When you promote a new design, the work is the swap AND the sweep.** Move the
tree, then rebuild every page the new design was borrowing from the old one —
a card on the front page that opens a page in the previous design is the
failure mode, not a missing file.

## Two sources of job postings, and only one of them is the database

`data/jobs.json` is built by `_scraper/build-jobs.mjs` from **both**:

1. **`jobSubmissions` in Firestore** — everything posted through the site's own
   form. The database is the source of truth for these: they are edited,
   withdrawn and hidden there, which is why the old form-sheet sync was retired
   (re-reading a sheet reverted people's edits — see the header of
   `oa-jobs-sheet-sync.yml`).
2. **The maintainer's job market TRACKING SHEET** — one Google workbook per
   market cycle, a tab per kind of position ("2026 Jobs", "2026 NTT/PD"), read
   daily into `data/jobmarket.json` by `_scraper/sync-jobmarket-sheet.mjs`
   (`.github/workflows/oa-jobmarket-sheet.yml`). Setup and behaviour:
   **`_SETUP-JOBMARKET-SHEET.md`**.

The ownership is opposite, and that is the whole design. A posting from the
tracking sheet is **maintained in the sheet**: it is rebuilt from the workbook
on every run, an edit there reaches the site, and a row DELETED there comes off
the site. So those rows are deliberately never copied into Firestore —
`migratable()` in `migrate-to-firestore.mjs` skips them, because a document
would win over the sheet at the next build and a deleted row could never leave.
For the same reason they are excluded from the orphan carry in `build-jobs.mjs`
(a missing `data/jobmarket.json` still removes nothing — only a file that
exists and no longer lists a posting does). Both of those worries are now
answered rather than avoided — see the next section — but they are answered by
the BUILD, on the sheet's own terms, not by a migration; `migratable()` still
skips these rows.

### …and the maintainer can edit both, through the same form

A posting's Edit and Take down controls are drawn only where the page can name
a `jobSubmissions` DOCUMENT for the row (`docIdFor` in `assets/oa-jobedit.js`),
so the tracking sheet's postings — which had none by design — carried no
controls at all: the maintainer could edit every posting on the site EXCEPT the
ones the sheet publishes. **Every workbook row now gets a MIRROR**: an inert
document (`status: 'sheet'`, a value no query in the pipeline reads) created and
refreshed from the workbook by `syncSheetMirrors` in `build-jobs.mjs`, whose
only job is to be an editing handle. `sheetMirrorDoc`/`mirrorDiffers`/
`unclaimedSheetRows` in `jobs-model.mjs` are the pure half.

**Saving an edit is the hand-over, and the status is the whole of it.**
`post-a-job.html` sets `status: 'queued'` on every edit it saves — it always
has — so a mirror simply becomes an ordinary live submission, and a status
other than `sheet` means the maintainer has taken the posting over:
`build-jobs.mjs` then publishes the document and DROPS the workbook's row
(`unclaimedSheetRows`, applied before the merge — left in, the sheet row
arrives last and wins, which would make an edit look saved and change nothing).
The workbook stops maintaining that one posting, and the run says so.

**What the workbook KEEPS is existence.** A row deleted there takes its posting
off the site whether or not a document exists for it — the property that made
copying these rows into the database unsafe in the first place, kept by pinning
each mirror to its row with `sheetId`. So `migratable()` still refuses them:
mirrors are the sheet's own, not a migration.

**Taking a posting down is keyed on the id as well as the reference.** `ref` is
issued by the FORM and by nothing else, so the 94 postings from the legacy
import and the 16 from the workbook have none — today that is every row in
`data/jobs.json`. Keyed on `ref` alone, the takedown removed nothing: the row
was carried on as an ORPHAN, the button said "Taken down", and the posting
stayed on the site for ever. `removalSpecs` (jobs-model.mjs) and the `{ id }` spec in
`mergeRows`/`mergeCandidateRows`/`mergePlacementRows` are the fix, in all three
pipelines. It also decides WHOSE WORD to take: an id is honoured only on a
document the build itself wrote, and a reference only for the account that
published the row — both are printed in `data/jobs.json`, so an unscoped
removal is a signed-in stranger taking down somebody else's posting.

**When the sheet changes shape, fix it in `_scraper/jobmarket-sheet.mjs` —
never by hand-editing `data/`.** That file is rewritten from the workbook every
half hour, so a patched row comes back within the hour, exactly as with the
country spellings below. Columns are matched by header alias and a header it
does not know is REPORTED in the run's log rather than guessed at; add the alias
there.

**It is not the maintainer's workbook.** "OM Job Market" is owned by
`omjobmarket2023@gmail.com` and crowdsourced — contributors add their own
postings and, when a season opens, their own tabs. So a heading cannot be
corrected at the source, and the pipeline has to be able to read a tab that
names a column wrongly.

### A header that names one column wrongly, and the four months it cost

The "2026 Jobs" tab — created by the sheet's contributors when the 2026-2027
market opened — heads its school column **"Location"**, the same word it uses
for the town beside it. Every other tab heads it "School". `institution` is
required and no alias reads "location", so that row was refused as a header;
the scan moved to the next row and took a POSTING as one, because "University
of Hong Kong" begins with an alias of `institution` and a comment reading "an
expected start date of July 1, 2027" contains an alias of `posted`. Both
required fields were satisfied by prose. The date was then read out of a
comment column empty on almost every row, so every row was skipped. The tab
logged `"2026 Jobs": 0 posting(s), 94 row(s) skipped` every morning and the
site simply never showed the season — 22 postings on the jobs page where the
sheet held 89.

Three rules came out of it, and they are separate on purpose:

1. **A row of postings is never a header** (`looksLikeData`), however many
   aliases its prose contains. A link or a date is decisive — a column is not
   NAMED after either — and two long sentences are counted rather than trusted,
   so a wordy label survives.
2. **A header that names most of its columns is repaired, not discarded**
   (`repairColumns`). The one required field it failed to name is settled from
   the DATA — the institution column is the one whose values NAME institutions,
   read with the same `UNIVERSITY`/`BUSINESS_SCHOOL` patterns `typeFromNames`
   uses, as a SHARE of the column (measured on the live tab: 92% of the school
   column, 0% of the two beside it, with "KU Leuven", "ESMT Berlin" and
   "Stanford GSB" among the 8% that name nothing). Then the header is re-read
   AROUND that column, which is what makes the repair minimal: the tab's second
   "Location" becomes the town, and the deadline, the link and the notes — all
   of which whole-tab inference would have lost — are kept. It fires only for a
   field without which nothing publishes, only when the header did not name it,
   and never on a tab whose header is right.
3. **A tab that is read and yields nothing is an error, not a quiet tab.** It
   is a `::error::` annotation AND a `stalenessOf` reason of its own
   (`unread-tab`), checked BEFORE the age test: from outside it looks exactly
   like a quiet market, every other signal says the sheet is healthy, and it is
   the one failure here a person has to go and fix.

**Which season a posting belongs to: the tab is a FLOOR.** The site's roll rule
reads the market year off the posting's date, which is right except for a
school advertising early — 24 of that tab's 89 postings are dated April to June
2026, two saying "an expected start date of July 1, 2027" in their own comment,
and by date alone all 24 file under the season that has just closed, which is
the one page they are of no use on. The tab settles it (`cycleYear`), because
naming the cycle is the whole reason it exists. A floor and never a ceiling: it
can carry a posting forward into the season its tab was made for and can never
push one back into a closed season, so a row added late to an old tab keeps the
later year its date gives it and nothing already published moves.

A sheet that stops being updated looks exactly like a quiet job market from the
site, so it is made visible deliberately: `stalenessOf`/`shouldWarn` e-mail the
maintainer once (then weekly) when the sheet has gained nothing for three weeks,
cannot be read, reads as empty, or has a tab that gave nothing. Nothing already
published is ever removed by one of those failures.

## The HigherEdJobs postings are checked against their own ads

The tracking sheet has no deadline column for most rows, so they reach the site
as "Until filled." — the ingest's default for an empty cell, not something
anyone checked. Where the posting links to **higheredjobs.com** the ad states
its closing date in a field of its own, so it is read:
`_scraper/higheredjobs.mjs` (pure: parse an ad, decide what it changes) +
`_scraper/higheredjobs-verify.mjs` (fetch, cache, apply) +
`.github/workflows/oa-higheredjobs-verify.yml` (daily, after the sheet read).
What each ad said is cached in `data/higheredjobs.json`.

**`validThrough` in the page's schema.org block is NOT the deadline** — it is
when HigherEdJobs stops listing the ad, ~18 months out (a post closing on
20 Aug 2026 carries `2028-02-06`). Only the fields in `DEADLINE_FIELDS` may be
read; two selftests pin that this stays true. When an employer labels the
closing date some new way, **add the label to `DEADLINE_FIELDS` — never
hand-edit `data/`**, exactly as with the country aliases: `jobmarket.json` is
rebuilt from the workbook every morning, so the sheet sync re-applies the cache
on every read and a patched row would come back the next day.

**A deadline the maintainer typed into the sheet is never overwritten.** The
pass only fills a row that had none; a disagreement is reported as a warning
naming both dates, so the sheet is corrected at the source. An ad that cannot
be read changes nothing — this is an enrichment and must never fail a run.

Local runs: `node _scraper/higheredjobs-verify.mjs --apply-only` (re-apply the
committed cache) or `--scan`. A real read needs egress to higheredjobs.com,
which this build environment denies (403), so it happens on the runners.

## …and every OTHER advertisement is read too

HigherEdJobs is 156 of the sheet's 449 postings; the rest link to ~120 other
hosts — Interfolio (36), Chronicle (27), the INFORMS career center (18),
Inside Higher Ed (15), and a long tail of one-per-university applicant
tracking systems (Workday, PeopleAdmin, Cornerstone, Taleo, Oracle…). Those
were never checked at all, so their postings published "Until filled." and
their review cards asked the maintainer to open every advertisement by hand.

    _scraper/adverts.mjs           parse any ad, decide what it changes (pure)
    _scraper/adverts-verify.mjs    fetch, cache, apply — and the queue pass
    .github/workflows/oa-adverts-verify.yml   daily, after the two above

One generic HIGH-PRECISION parser — schema.org JobPosting JSON-LD plus a
labelled-field scan over the three shapes these systems write facts in
(`<strong>Label:</strong>`, `<th>/<td>`, `<dt>/<dd>`) — plus the one adapter a
host actually needs: Workday pages are a JavaScript shell, so they are read
from the tenant's public CXS JSON endpoint (`workdayApiUrl`). A page in a
shape it cannot read parses to `unreadable` and CHANGES NOTHING — that is
what makes a generic parser safe across a hundred hosts (the PDFs some rows
link to, and any bot-walled board, land there too). Google Docs, LinkedIn and
higheredjobs.com are never fetched — the last because that host has its OWN
pipeline, and two caches for one advertisement would disagree silently
(`isAdvertUrl`; one URL, one owner, pinned in the selftest).

**Two lessons from elsewhere in this repo are LOAD-BEARING here.**
`validThrough` — and every label naming the LISTING's end ("End date",
"Expires") — is NEVER read as a deadline anywhere in the module: on a board
it is when the AD comes down, ~18 months out on HigherEdJobs and the paid
listing's end on the Madgex boards. It is recorded separately as
`listedUntil` and shown labelled as what it is. And an ambiguous all-numeric
date ("05/10/2026" — Coventry writes day-first, Salt Lake City month-first)
is REFUSED rather than guessed: unlike the sheet ingest's `deadlineDay`,
which has a cell that must mean something and a posting date to test a repair
against, a scraped page can afford "no date, prose kept".

**What it writes, and where.** For the PUBLISHED postings it is exactly the
HigherEdJobs pass again: what each ad said is cached in `data/adverts.json`,
deadlines fill ONLY rows the sheet left open-ended (both fields move
together), a deadline the maintainer typed is never overwritten — the
disagreement is a warning naming both dates — and `sync-jobmarket-sheet.mjs`
re-applies the cache on every workbook read, or the morning rebuild would
revert every filled deadline. For the PENDING queue it records what the ad
says ON the review document as `ad` (title, institution, closing date,
`listedUntil`, whether the listing is even still up) — never in `data/`,
because a pending posting is not public and everything under `data/` is
served to anyone who asks. The review card and the review e-mail then draw it
beside `dup` and `biz`, and like them it is RAISED, NEVER DECIDED: the
card's "Use this closing date" button only fills the box, and nothing
publishes until the maintainer approves. The queue pass writes the `ad`
block and nothing else — never the decision, never the edits (the selftest
pins the merge as the file's only document write). A pending HigherEdJobs ad
IS read here (via that host's own parser), because the published HigherEdJobs
pass only ever sees approved rows.

**The ad's three names are CLASSIFIED against the site's own vocabulary**
(owner, 2026-08-24: "categorize the University, the Business School Name and
Department correctly"). The parsers also read the school and department a
page states (`SCHOOL_LABELS`/`DEPARTMENT_LABELS` — a value that merely
repeats the organisation's own name is nothing), and `advertPlace` in
`adverts.mjs` turns the stated names into the site's three: a hiring
organisation that is really a SCHOOL — "Harvard Business School", the
Interfolio shape — is filed under its university via
**`universityForSchool`** in `vocab.mjs` (the `businessSchoolOf` discipline
inverted: canonicalised, folded, and only an UNAMBIGUOUS answer given), the
three then go through the posting form's own `canonColumns()`, and an empty
school whose department the directory can place is settled by
`schoolForUnit`. Curated, never guessed — a name the vocabulary has never
seen is offered exactly as stated, and `settlePlace` canonicalises whatever
the maintainer adopts. The review card draws the classification with a
**Use these names** button (the stated school/department get a button each
where the vocabulary had no answer), the review e-mail says the same thing,
and the QUEUE pass now runs BEFORE the published one — the pending postings
are the ones the maintainer is actively deciding, so a run's read budget
goes to their cards first.

**`_ADVERT-HOSTS.md` is the inventory of where the advertisements live** —
the distinct websites carrying this and last market year's postings (the
years from the site's own roll rule, never from whatever stray years the
data holds), drive/docs links excluded as user-uploaded copies whose address
changes every time. A snapshot, regenerated by
`node _scraper/adverts-verify.mjs --hosts --write` over the committed data
(offline); each host names the pipeline that reads it.

**When an employer labels the closing date some new way, add it to
`DEADLINE_LABELS` in `adverts.mjs` — never hand-edit `data/`** (the
HigherEdJobs rule, same reason: the data is rebuilt every morning). The
school/department labels grow the same way (`SCHOOL_LABELS`,
`DEPARTMENT_LABELS`). Local runs: `--apply-only`, `--scan`, `--hosts`,
`--selftest`; a real read happens on the runners (this environment's egress
denies every one of these hosts), and the workflow's `dry_run`/`scan`
dispatch inputs are how a new host's readability is measured before anything
is written. The queue pass needs `FIREBASE_SERVICE_ACCOUNT` and is a clean
no-op without it.
## Two deadlines per posting: suggested and final

Many searches have no fixed closing date yet name the day that matters most —
the first-review / full-consideration date ("First review of applications will
begin on September 8, 2026, and will continue until the position has been
filled"). Those postings read a bare "Until filled." So a posting carries TWO
dates (owner, 2026-08-23): **`reviewDate`**, the SUGGESTED apply-by, and
**`applyByDate`**, the FINAL one — which alone still drives the market roll
(`deadlineOpen`): a review date passing does not close a search. The card shows
"Suggested apply by" (only where known) above "Final apply by"; the jobs page
filters on each (**Suggested deadline**: Review ahead / Review passed / No
review date — its own vocabulary, because "Expired" is the wrong word for a
date that closes nothing; **Final deadline** keeps the vendor page's three
words AND its `deadline` URL key, so every saved link works); the posting form
asks the two dates as two questions, the review card offers the box, and the
alert e-mails + the alerts page's preview name both ("suggested apply by … ·
final apply by …").

**The suggested date is read out of the prose the sources already carry** —
`extractReviewDate` / `extractFinalDate` / `healReviewDate` in
`jobs-model.mjs`, the deadlineDay discipline throughout: every pattern demands
the reviewing/consideration context in the same sentence as a date WITH a
four-digit year, an ambiguous `10/12/2025` is refused rather than guessed, and
a posting the extractor is unsure of keeps reading "Until filled." exactly as
the owner asked. A suggested date ON OR AFTER the final one is dropped
wherever it is set (equal is the deadline said twice — half the corpus; later
contradicts it): in `healReviewDate`, in `applyEdits`, in the form's own
validation, and when the HigherEdJobs verify fills a closing date onto an
open-ended row. `healReviewDate` is pure, idempotent and fill-empty — the
`healPlace` pattern — applied at `rowFromSubmission`, the sheet ingest
(`rowsFromTab`, which also trims the captured sentence so the Kansas card
reads "Suggested apply by: September 8, 2026 · Final apply by: Until
filled."), the sync's `--heal-names`, and the whole merged set in
`build-jobs.mjs` beside `healCountry` — so rows from every writer heal on
every build, and the committed files were healed once with the same function
(17 postings gained their date). `extractFinalDate` reads only an explicitly
LABELLED closing date ("Final date: Thursday, Nov 5, 2026" — UCLA's
application-window cell); a bare "deadline" heading clauses away from a date
is exactly the mislabelled-header mis-read and never fires. And the source's
own labelled WINDOW can settle both fields at once: UCLA reached the site
with its review date recorded as the closing date while its own words on the
row said "Next review date: Oct 5 … Final date: Nov 5" — where the stored
closing date IS the text's stated review date and the same text labels a
final date after it, the stated final date wins and the review date takes
its own field (`window` in healReviewDate; both labels must be explicit and
agree with the stored date, so it can never fire on a date the maintainer
simply typed). `reviewDate` is in
`PUBLIC_FIELDS` (skipped when empty, like `ref`), in the jobSubmissions rules'
`shapeOk` and the jobReviews `edits` list, and `testTwoDeadlines` /
`testTwoDeadlinesWiring` in selftest.mjs pin the extractor, every guard and
every surface. The `/v2/` archive deliberately ignores the new key — its
frozen assets read `applyBy`/`applyByDate` exactly as before.

## The frozen archives, and how the maintainer edits them

`data/past-postings.json`, `data/recent-faculty.json` and
`data/universities.json` are written ONCE by `_scraper/import-legacy-tables.mjs`
from Google Sheets and committed — `.github/workflows/oa-legacy-import.yml` has
no schedule. They have no Firestore backing and never will, so the three pages
that render them (`previous-markets.html`, `recent-faculty.html`, and the
Leaflet map on `universities.html`) were read-only for EVERYBODY, the
maintainer included: correcting a school's name meant editing a spreadsheet and
dispatching a workflow by hand.

**`assets/oa-rowedit.js` corrects a row AT READ TIME**, from a public-read,
admin-write Firestore collection `rowOverrides` (`<dataset>__<rowId>`). It is
the `newsOverrides` pattern already shipped on `/whats-new`, generalised: the
committed JSON stays the source of truth, an override MASKS or REWORDS one of
its rows, the correction reaches every visitor, and **re-running the import
cannot undo it** — the overlay is applied on top of whatever the import
produces. One module serves all three: `apply()` for the rows a page renders,
`onCard()` for an OAList card, `onPopup()` for a map pin (`assets/oa-uni-map.js`
gained `prepare`/`onPopup`/`refresh` hooks for exactly this).

**It is deliberately NOT an add path.** An override only ever changes a row that
already exists. A school the archive does not carry is added upstream, in the
sheet the import reads — two places that can both create the same row is the
parallel bookkeeping `build-jobs.mjs` warns about, and it rots: the import would
later publish the school itself and the site would list it twice.

**Hiding is never a one-way door.** A row the maintainer takes down is hidden
from every visitor but still shown TO THEM, faded and carrying Restore — filter
it out for everybody and there is nothing left on the page to press to bring it
back. `newsOverrides` had exactly that shape (and no `allow delete`, because
`request.resource` is null on a delete so an `allow write` condition errors and
evaluates false); both were fixed together.

**Adding a field to the editor means adding it to the rules in the same
change** — `selftest.mjs` pins every key `oa-rowedit.js` can write against the
`hasOnly` list in `_firestore.rules`, so a field with no rule fails the build
rather than the maintainer's save.

`previous-markets.html` carries TWO kinds of row and therefore two editors: the
postings folded in from `data/jobs.json` are real submissions and get the FULL
form (`oa-jobedit.js`), and it is the ONLY page that reaches them — the jobs
page and the one-pager both filter to the market under way. `oa-rowedit.js`
stands down wherever `oa-jobedit.js` has drawn.

**None of this is live until the rules are deployed.** No workflow runs
`firebase deploy` — it needs an interactive login — so after any change to
`_firestore.rules`, run `firebase deploy --only firestore:rules` from the
repository root. See `_SETUP-FIREBASE.md` §4.

## The Universities directory — one card per university, editable by anyone signed in

`universities.html` is a CARD DIRECTORY since 2026-08-24 (owner: one card per
university — its business school, its engineering/non-business school, each
school's departments inside it), with the Leaflet map kept as the second view
behind a Cards ⇄ Map switch (mounted lazily; the map half is unchanged —
`data/universities.json` + `rowOverrides`).

    _scraper/directory-model.mjs   what merges with what, and why (pure)
    _scraper/build-directory.mjs   writes data/directory.json + directory-meta.json
    assets/oa-directory.js         grouping, the OAList mount, the edit layer
    assets/oa-directory.css        the page's own chrome, theme tokens throughout

**`data/directory.json` is a BUILT file** — offline and deterministic, merged
from the curated archive (`data/universities.json`), the `oa-institutions.js`
seed and BOTH postings files, every name through `canonColumns()`. It is
rebuilt as the last step of `oa-jobs-build.yml`, so **a posting always fits
under a card, and a posting from a place no source lists CREATES its card in
the run that published it** (the owner's rule). Two bounded folds keep the
table clean without guessing: a school-less posting joins the ONE schooled row
carrying its department (the `fillSchoolFromDirectory` discipline), and a bare
acronym department folds into the ONE row whose initials spell it (the
search's own acronym rule). A row's `id` is derived from the folded names
(`rowKey` — `institutionKey` for the university part) and is what an edit is
keyed on, so it never depends on array position.

**`directoryEdits` is the read-time overlay, and ANY REGISTERED USER writes
it** (owner, 2026-08-24) — the `rowOverrides` pattern with the write opened
from the maintainer to every signed-in account. An edit stores only what
differs from the committed file; `add: true` marks a row contributed whole;
every document carries `by` (pinned to the writing uid by the rules, so
attribution cannot be forged), `name` and `t`, and **every card shows "Last
edited by <name> on <date>"**. Renaming a row so its names match another
row's MERGES the two on screen — that plus the maintainer-only `hidden` flag
(the duplicate's takedown, faded-with-Restore for them, never a one-way door)
is the merge tool. The maintainer alone also deletes a document ("Reset to
file") and alone sees the **"Last edited" filter** (an `order`ed, `className`-
hidden OAList filter — two small generic options added to the engine for it),
which exists to drive a review sweep. `testDirectoryModel`/
`testDirectoryWiring` in selftest.mjs pin the merge rules and the
module↔rules field lists BOTH WAYS; page-test.mjs measures who is offered
which control, the attribution line, and the page's mobile gate (it is in
`MOBILE_PAGES` now — the cards are an OAList mount; the map view keeps its own
phone block, which switches views first). **Inert until the rules are
redeployed**: `firebase deploy --only firestore:rules --project
operations-academia`.
## Nothing from the tracking sheet publishes itself

A posting crawled from the job market workbook is **queued for the maintainer,
not published on sight**. It appears at the top of `admin-area.html` — the
maintainer's Admin area, above the feedback inbox (it lived on feedback.html
until the Admin area gathered every review queue) — every field editable;
approving it puts it on the site at the next build, rejecting keeps it off
for good.

The reason is that the pipeline **derives** things the sheet never said — the
market year, the type of institution, the canonical country, the entry level,
and the closing date read off the HigherEdJobs advertisement. Those reached
visitors before anyone had looked at them.

    _scraper/jobreview.mjs         what is publishable, and what an edit is (pure)
    assets/oa-jobreview.js         the panel on admin-area.html
    _scraper/jobreview-mailer.mjs  one e-mail per queued posting
    oa-jobreview-mail.yml          runs it every 15 minutes

**The queue is a Firestore collection (`jobReviews`), never a file under
`data/`.** Everything in `data/` is served by Pages to anyone who asks — CI even
checks that no e-mail address reaches it — so a posting "not yet public" cannot
sit there in any form. `data/jobmarket.json` therefore becomes what it always
claimed to be: the **approved** postings, and nothing else.

Three rules worth keeping:

- **Absence means withhold.** A row with no queue document is never published.
  Expressed that way round — rather than "a rejection means withhold" — so a
  queue that fails to write cannot leak a posting onto the site.
- **An unreachable queue changes nothing.** Without it there is no way to know
  what was approved, and both answers are wrong: publishing everything defeats
  the gate, publishing nothing deletes every posting on the site. So
  `data/jobmarket.json` is left exactly as it is, the same rule the sync
  already applies to a workbook it cannot read.
- **An edit is a correction laid on top, never a rewrite of the row.** The sheet
  stays the source of truth; `edits` is re-applied on every build, so the
  workbook can be re-read every morning without discarding the maintainer's
  work. Same shape as the HigherEdJobs cache and `rowOverrides`.

`EDITABLE` in `jobreview.mjs`, the `FIELDS` list in `oa-jobreview.js` and the key
list in `_firestore.rules` must agree — **selftest.mjs pins all three together,
and BOTH WAYS**: a field the panel offers that the model does not accept is a
tick box that saves and silently does nothing, which is what "Associate
Professor" and "Full Professor" were (the site's five `LEVELS` know only "Other
Ranks"). `id`, `year`, `posted` and `source` are deliberately NOT editable: they
tie the posting to its sheet row, and changing one would make the next sync
queue it again as new. Correct those in the workbook.

**The card asks the posting form's own three name questions, in its words, with
its cascade.** It used to offer FOUR boxes for a place that has three —
`department`, the line the card shows, beside the school and the unit it is
joined from — and nothing kept them in step: correcting the school published a
row whose line still said what the workbook had said, and the selftest's "the
line equals its two parts joined" guard would then stop the whole site
publishing. `department` is DERIVED now (`settlePlace` inside `applyEdits`,
which also puts all three names through the same `canonColumns()` every other
ingest uses — an alias added today reaches a posting queued last week), it
stays in `EDITABLE` and the rules only because an old document may still carry
one (`SHOWN` is what the panel draws), and the card previews the line under the
two boxes exactly as the posting form does. The three boxes mount
**`assets/oa-place-picker.js`** — see the cascade section below — so typing
"University of Chicago" narrows School to Booth and School narrows Department,
the same behaviour the poster gets.

**A crawled posting is checked against the site for DUPLICATES before the
maintainer is asked about it.** A school that advertises through the site's own
form is routinely also entered in the tracking workbook, and the crawled copy
then arrives in the queue as a fresh posting. So the sheet sync runs every
queued row through `duplicatesOf` (jobreview.mjs, pure) against
`data/jobs.json` — same market year, same university (`institutionKey`, so a
"The" cannot hide a match), and either the same advertisement link or the same
department; two rows whose entry levels share nothing are two advertisements
(the Houston lesson), and our own home page in a link column identifies
nothing. The flags are stored on the queue document (`dup`, in `DOC_KEYS` and
the rules' `hasOnly` — pinned both ways by the selftest), re-checked on every
sync so they appear when the duplicate is posted later and clear when it is
taken down, and RAISED, never decided: the review card draws an amber warning
naming the postings it may repeat (measured in page-test.mjs, hostile input
included) and the review e-mail says the same thing. Approve still publishes;
Reject still keeps the crawled copy off.

**The same advertisement twice is not a decision to make** (owner, 2026-08-26:
"check the Link to the advert — if it already exists in a previous posting that
is live or in the queue, then remove that new job from the queue"). A crawled
row whose **advert link** already belongs to a posting the site is showing, or
to one already waiting in the queue, is DROPPED at ingest rather than queued —
`advertRepeat` in `jobreview.mjs` decides it, the sheet sync applies it, and
the maintainer never sees the card.

**Deciding on a shared link is exactly what this repository threw away once**,
so it is scoped by MEASUREMENT rather than by hope. The section below records a
file-level "no two postings name the same advertisement" rule written, measured
and abandoned because City University of Hong Kong links its whole vacancies
page from two market YEARS' postings and UCD links one CoreHR endpoint from
two. Measured over the 542 served postings on 2026-08-26, grouped by (market
year, university, advert link): **481 groups hold exactly one posting and
exactly one holds two** — UCD's endpoint, carrying MIS and Supply Chain
Management. Within a year at one university the link identifies the
advertisement 481 times out of 482, and the one exception is told apart by its
DEPARTMENT. So the three contradictions, each keeping a real posting:

* the market year and the university must match (the CityU case);
* two rows that both name a department, differently, are two advertisements
  behind one endpoint (the UCD case);
* two rows whose entry levels share nothing are two searches from one
  department (the Houston lesson `collapseSameDay` already carries).

Run over the whole served corpus, **none of the 542 is judged a repeat of
another** — the check that says the guards are not merely plausible. Anything
short of a match still gets the amber `dup` flag it got before; this only
removes what it can show is one advertisement twice.

**Dropped means REJECTED, never deleted.** `partition` re-queues a row whose
document is gone, so deleting would re-drop it every sync for ever; a rejection
is the one state that both keeps it off the site and stays out of the pending
list the panel draws. The reason goes in `note` and the posting it repeats in
`dup` — **both already allowed by the rules, so this needed no redeploy**, and
no document is left in a shape the panel is then refused permission to update
(the `sync-user-directory` lesson). The comparison set is what is live PLUS the
rows already queued PLUS the fresh rows the same run has just accepted, so a
workbook listing one advertisement twice queues it once.

It keys on the ADVERT link alone, never on "posted at" — `duplicatesOf` can
afford the wider net because a person reads its answer; this one cannot.
Pinned both ways in `selftest.mjs`, including the UCD and CityU cases and the
sync's own source (rejects, never deletes).

### Every posting under review, and a button to ask again

Dropping a row as it is CRAWLED leaves the queue as it was: every posting
already under review the day that shipped was crawled before the rule existed,
and nothing was ever going to sweep them (owner, 2026-08-26: *"Check ALL jobs
currently under review … apply for all jobs under review"*). So the queue is
swept too — the pending documents FIRST, then the fresh rows measured against
what survived.

**A per-row check cannot sweep a set**, and that is the whole reason
`findAdvertRepeats` exists: two queued rows naming one advertisement are each a
repeat of the OTHER, so checking them independently against the same list drops
BOTH and loses the posting altogether. It keeps what it has already kept, so
exactly one survives — and the rows go in **oldest first** (`queuedAt`), so the
survivor is the one that has been waiting longest.

Three consequences the sweep must carry with it, each pinned: a posting on its
way out is not also **re-flagged** (`dup`/`biz` on a document being rejected),
is not **refreshed** from the sheet, and is not counted among the decisions
still **waiting** on the maintainer. And the write is a TRANSACTION that only
ever moves a document out of `pending` — every other write in that file is
careful never to overwrite a decision made in the browser mid-run, and this one
writes a decision, so it has to look first. A posting approved a second ago is
theirs.

**And the maintainer can ask on demand**: *Check for duplicate adverts*, beside
Approve-all on the crawled tab of `/admin-area`. It is the SAME RULE — the
button and the pipeline read one dual-mode file, `assets/oa-advert-dup.js`,
which `_scraper/jobreview.mjs` re-exports rather than carrying its own copy (the
drift every shared module here exists to prevent; `oa-schools.js`,
`oa-countries.js`, `oa-news.js` are the same shape). Four things it does
deliberately:

* it sweeps the **whole crawled queue**, not the page on screen — a repeat is
  always in the same market year as what it repeats, so no page could show a
  pair the sweep should have left alone;
* it re-reads `data/jobs.json` with **`cache: 'no-cache'`**, because Pages
  serves `data/` with ten minutes of freshness and a stale copy would keep a
  repeat of something published nine minutes ago;
* it **reports before it writes** — every drop is named in the confirmation with
  the posting it repeats, and dismissing it writes nothing;
* it judges the row **as it will publish**, the maintainer's unsaved edits
  included: a link just corrected on the card is the link the check reads.

It is drawn for ONE posting too, unlike Approve-all's `> 1`: a single queued
posting can perfectly well repeat one that is already live, which is the case
that was reported. It is on the crawled tab alone — a user-added posting is
already on the site, and taking it off is its poster's decision or the Take-down
control, never a sweep.

`page-test.mjs` measures the money path in a real browser against its own seeded
pair and its own routed `jobs.json`: dismissing writes nothing, accepting
rejects the two repeats (never deletes them), the OLDER of the pair survives, the
document says why it went, and a second press reports that it found nothing.

**A crawled posting that mentions "business" is flagged under Business School,
and its card NAMES the school** (owner, 2026-08-23). `typeFromNames` used to
read only the employer's name and the field column, so Berkeley advertising a
business-flavoured post filed under "University". It now judges the WHOLE
posting's text — the field column, the advertised title, the notes and the
advertisement's own address — and the bare word "business" (word-bounded, so
"agribusiness" is not it) is evidence enough: the row arrives typed
`Business School`. The sync then asks the site's own vocabulary which school
that IS at that university — `businessSchoolOf` in `vocab.mjs`, the
`schoolForUnit` discipline: answered from the school's own name
(`BUSINESS_SCHOOL_NAME_RX`), through `institutionKey` so any spelling reaches
the entry, and only when UNAMBIGUOUS — and `businessCheck` in `jobreview.mjs`
stores the answer on the queue document as **`biz`** (`{ school }`; `null`
when the posting is not business-typed or its School box already names a
business school). Like `dup` it is in `DOC_KEYS` and the rules' `hasOnly`
(pinned both ways), computed for fresh queue documents AND re-checked on every
sync for pending ones — judged on the row the sheet NOW gives, the refreshed
copy when one is being written that run — and RAISED, never decided: the
review card mentions the school ("The site's directory lists **Haas** …") with
a **Use it as the School** button that only fills the box, the review e-mail
says the same thing, and nothing publishes until the maintainer approves. A
university the directory cannot answer for still gets the flag, saying the
directory has none — the fix is a row in `assets/oa-institutions.js`, the same
rule as everywhere: grow the database, never guess.

**A deadline the pipeline is unsure of publishes as "Until filled."** (owner,
2026-08-23). `sheetDay` guesses US order on an ambiguous all-numeric cell —
right for a date Google itself wrote, wrong for a contributor typing
day-first: "5/10/2026" meaning the fifth of October published as the tenth of
May, a deadline BEFORE the advertisement went up. `deadlineDay` in
`jobmarket-sheet.mjs` now believes a parsed deadline only when it is PLAUSIBLE
against the posting date — on or after it, within `DEADLINE_WINDOW_DAYS`
(730) of it. An ambiguous day/month whose US reading fails that test is
re-read the other way round first (the one honest repair — only one of the
two readings can be a date the advertisement could have meant); a cell
neither reading can save, or that never parsed at all, publishes NO date —
which the page already shows and buckets as "Until filled." — and its own
words are carried onto the card as `Deadline as listed: …` in the comments,
so the maintainer can settle it on review instead of the claim being silently
lost. The HigherEdJobs verify still fills genuinely-known deadlines from the
advertisements themselves, unchanged.

**An approval also DATES the posting from the day it was approved**
(`approvedRow` in jobreview.mjs — applyEdits plus the re-stamp, used by
`partition` AND by build-jobs' direct read of the queue, so the two writers
cannot disagree). `addedAt` is what the e-mail alerts window on, and the
queue's copy carries the day the CRAWLER first saw the row — days before
anyone could read it on the site, so a posting approved after a subscriber's
last digest fell outside every window and was announced to nobody.
Grandfathered documents are exempt, and the discriminator is exact: partition
stamps their `reviewedAt` and `queuedAt` from the same instant, while a real
decision's `reviewedAt` is the browser's own later write.

**A workbook posting is given the school its department sits in** —
`fillSchoolFromDirectory` in `vocab.mjs`, applied by the sheet sync at ingest
(and by its `--heal-names`). The workbook's one hiring-unit column holds the
department, so fifteen of its sixteen postings arrived with a department and NO
school — "University of California, Berkeley" + "Operations and Information
Technology Management", with Haas missing — while `data/vocab.json` (the
Universities directory + the `oa-institutions.js` seed) already knew the
answer. Curated, never guessed: only where the school is EMPTY, only where
exactly ONE school at that university carries the department, and never from a
name the site does not already publish. It is the offline twin of the form's
`inferSchool`. A posting it cannot settle (a programme rather than a
department, a department named differently from the school's own, Rutgers'
school-as-university) is the maintainer's call, made on the review card's
cascade — never a guess. **To make a future posting resolve, add its
(university, school, department) row to `assets/oa-institutions.js`** — the
same rule as everywhere else: grow the database, never hand-edit `data/`.

**It is inert until `_firestore.rules` is redeployed** (`firebase deploy --only
firestore:rules`) — until then the panel says permission-denied — and the
e-mail half is inert until `SMTP_*` is set, which stamps nothing, so the
postings are announced once it exists.

### The gate arriving is not a reason to retract

Sixteen of the sheet's postings were on the site before the queue existed, and
the first morning it answered they would all have had no document and therefore
come DOWN — off the jobs page, after e-mail alerts about them had gone out.
Already public is already reviewed in the only sense that matters here, so
`partition(rows, docs, { published })` takes the ids the site is showing and
enters those rows APPROVED, with the reason written into the document's `note`.
Rejecting one still takes it down. Everything the site is not already showing is
queued pending, which is the whole of the gate for every posting from here on.

### Two sources, one panel

The postings the maintainer reviews come from two places and their jobs
differ (owner, 2026-08-23), so `oa-jobreview.js` draws the panel as two tabs:

* **Auto-crawled jobs** — the tracking sheet's queue above: a GATE, held back
  until approved, every field editable on the card, Approve-all included.
* **User-added jobs** — postings made through the site's own form
  (`jobSubmissions`). These are LIVE within a minute — the form promises as
  much and nothing about this panel changes that — so their tab is a
  dedicated, editable to-do list, never a gate: *Open & correct* opens the
  poster's own form, *Mark reviewed* writes the `reviewedAt` stamp the
  submissions model names. The job half of the "Posted through the site"
  panel moved here (one queue, one surface — the drift rule that swept
  feedback.html); the candidate half stays there, and the submissions MAILER
  still announces both kinds.

The market-year tabs are kept INSIDE each source tab, and every list ranks
the NEXT market's postings first — 2028's before 2027's before 2026's, the
newest advertisement breaking ties within a market — because the market a
posting is FOR is the one its review is urgent for. The "Job postings to
review" tile and the account-menu badge count both tabs (`waitingJobs` in
`oa-adminarea.js`), so the tile and the panel beneath it cannot disagree.
`page-test.mjs` measures all of it against the seeded queue.

### A season is not six postings

The queue's unit of work is a market, not a posting: the "2026 Jobs" tab alone
opens with 89, and a whole workbook in scope holds several hundred across two
seasons. Three things follow, and each of them is what keeps the gate from
becoming the bug it was built to prevent — postings not on the site:

- **The panel approves a page at once.** `approveAll` in `assets/oa-jobreview.js`
  does exactly what the per-card path does, edits included, one write at a time
  with the failures counted rather than thrown. A gate that can only be cleared
  89 times does not get cleared.
- **The queue is split by market year**, newest season first and selected by
  default, which is what makes "approve everything here" safe to press: a
  posting approved from a closed season is correct and lands on Previous
  markets, and is not what someone clearing this queue in September is doing.
- **A burst is one e-mail.** One per posting is the owner's choice and right for
  the market ticking over; 89 of them is a mail bomb from the site's own address
  that the provider would cut off half way. Above `BURST` (12) the mailer sends
  a single list instead, stamping `mailedAt` per document so the two paths share
  one high-water mark.

**Approving publishes at the next BUILD** — build-jobs.mjs reads the approved
queue documents directly (`approvedRow`, ahead of the next sheet read), and
`publishOnReview` in `_functions/index.js` rings the sheet read the moment a
decision lands, with the build chained on its completion. Either way an
approval is on the site in a couple of minutes; the half-hour sheet schedule
is the safety net, not the promise. If any of that changes, change the panel's
and the e-mail's promise with it.

## …and what is posted through the site's own forms is ANNOUNCED

Two queues reach the maintainer and only the sheet's ever said anything: a job
posting or a candidate profile made through `post-a-job.html` /
`post-a-candidate.html` went into Firestore, was published by the next build,
and nobody was told. For candidates that was the worse half — profiles are held
behind the reveal date (`data/candidates-reveal.json`), so they reach no served
file, draw no card anywhere on the site, and there was NO screen that could
show them at all (the only route to one was guessing its document id).

    _scraper/submissions-review.mjs   which submissions are waiting (pure)
    _scraper/submissions-mailer.mjs   one e-mail per submission
    assets/oa-submissions.js          the candidate half of the panel on admin-area.html
    oa-submissions-mail.yml           runs it every 15 minutes

The PANEL half is split since 2026-08-23: `oa-submissions.js` draws the
candidate profiles, while user-added JOB postings are listed by the review
panel's own "User-added jobs" tab (`oa-jobreview.js` — see "Two sources, one
panel" above). Both surfaces read the same LIVE statuses and tick with the
same `reviewedAt` stamp, so a card marked reviewed on either is marked for
the mailer too; the mailer itself still announces both kinds.

**It is a NOTIFICATION, never a gate.** The forms promise "within a few
minutes" and keep it; the e-mail says a posting is already live, and says a
candidate profile is held until the reveal date — which is why the e-mail (and
the panel it links to) is the only place the maintainer will see one. The
bookkeeping lives ON the submission itself, not in a new collection:
`announcedAt` is the mailer's high-water mark (stamped only after a send
succeeds, so a run that cannot send announces the same submission next time),
and `reviewedAt` is the panel's "I have looked at this" tick. Both collections
were already admin-read and admin-write in `_firestore.rules`, so **no rules
redeploy was needed** — selftest.mjs pins that, because a feature that needs
one looks installed and is inert.

**The feature arriving is not a reason to send a hundred e-mails.** Anything
created before `SINCE` that the site is ALREADY showing is stamped without an
e-mail — both conditions, and the date is what makes the pair safe: "already on
the site" alone would swallow a genuinely new posting, because the build
publishes it within a minute of its arrival. A backlog submission the site is
NOT showing is announced — that is exactly the held-candidates case. Above
`BURST` (12) a batch goes as one list, sharing the review mailer's reasoning.

## Nothing on "What's new" publishes itself either

`changelog.json` says WHAT was announced. Firestore `newsOverrides/{changelog
id}` says what the maintainer has DONE about it — and **an entry with no
document is withheld**, exactly as in the job-review queue above.

    status: 'approved'   published — every visitor sees it
    status: 'pending'    not reviewed yet — only the maintainer sees it
    status: 'removed'    taken down — it leaves the list entirely
    title / summary      an optional rewording, applied wherever it is shown

Three rules the owner asked for (2026-08-18), and they only work together:

* **A removed entry LEAVES the list** — for the maintainer too. It used to stay
  on the page struck through, carrying "Hidden — only you can see this", which
  is exactly the clutter Remove was pressed to be rid of.
* **And removing is still not a one-way door.** Filtering it out for everybody
  was what made Remove irreversible before: nothing was left on the page to
  press, and the only way back was the Firestore console. So the removed
  entries go into a **collapsed disclosure below the list**, drawn only for the
  maintainer. The list is clean and the door stays open.
* **A new entry is not public on sight.** `changelog.json` is committed by
  whoever ships a change, and the entry reached visitors AND the e-mail digests
  the moment it landed. Now it waits, flagged for the maintainer, with Publish
  (and **Publish all N** — a change here routinely ships two or three entries,
  and a gate that can only be cleared one at a time does not get cleared).

**The gate arriving is not a reason to retract.** The 35 entries already on the
site have no document, and the whole log would have gone pending on the first
load. An entry dated before `REVIEW_FROM` is approved by default — a DATE
rather than a list of ids, so nothing has to be backfilled and no list has to be
maintained. Back-dating stays safe for the same reason it already was: the
mailer windows by date, so a back-dated entry precedes every subscriber's
window and reaches nobody.

**One file, four consumers: `assets/oa-news.js`** (dual-mode, like
`oa-alert-match.js`). The front page's newest-five list, `whats-new.html`, the
alerts preview and `_scraper/alerts-mailer.mjs` all read the decisions through
it. That is not tidiness: the two pages carried a renderer each and had already
drifted — the front page could edit an entry and the full log could not, one
read the admin address from a literal and the other from `OAFB.adminEmail` —
and the mailer read the raw log, so **an entry taken off the site was still
e-mailed**. `/v2/` keeps its own frozen assets, so rather than carry a copy of
the gate its alerts preview simply stopped reading the live log at all.

**The mailer holds the STREAM at the oldest unreviewed entry**
(`updateWindowEnd`, pure and unit-tested). Each alert's window is a high-water
mark on the DATE of the newest entry sent, so sending an entry dated after one
that is still unreviewed pushes the mark past it — and publishing that older
entry later would then reach nobody, silently and for ever. The digest stops the
day before the oldest entry waiting: publish it or remove it and everything
behind it goes out on the next run, in the order it was written. Delayed, never
lost — including for a subscriber who has never had an update digest, whose
31-day first-window cap is measured back from the END of the window rather than
from NOW, so an entry held longer than a month does not slide out of it while it
waits. **A decision read that FAILS is caught**, not left to reject: it withholds
everything since the gate (the safe direction) rather than killing the job
digests too, which have nothing to do with the update log.

`DOC_KEYS` in `oa-news.js` and the `hasOnly()` list in `_firestore.rules` are
pinned against each other by `testNewsReview()` in `selftest.mjs`, both ways —
a key with no rule is a permission-denied at save time and a maintainer told to
redeploy rules that are already deployed. The browser half (what a visitor sees,
what the maintainer sees, that a removed entry is off the list AND in the panel)
is measured in `page-test.mjs`. **Inert until the rules are redeployed**:
`firebase deploy --only firestore:rules --project operations-academia`.

## The Admin area — one page for everything waiting on the maintainer

`admin-area.html` (owner, 2026-08-23) gathers every review queue in one place:
the job postings to review (drawn by `oa-jobreview.js` in two source tabs —
the `jobReviews` queue held for approval and the user-added `jobSubmissions`,
live but not yet marked reviewed),
**candidate profiles including the ones held for the reveal** — the gap the
page was made to close: the front page said "2 profiles have already been
filed" while the maintainer had no way to SEE them, because held profiles are
kept out of `data/candidates.json` until the reveal date and the candidates
page therefore had nothing to draw its Edit buttons on — the feedback inbox
(`oa-feedback.js`), and "What's new" entries awaiting publication (listed
THROUGH `OANews.partition`, never a second reading of the gate; the publish
controls stay on `whats-new.html`).

The review queue and the inbox MOVED here from `feedback.html`, which is now
purely the public form — the move came with the sweep: `jobreview-mailer.mjs`
points its e-mails at `/admin-area`, and the selftest pins feedback.html clean
of the panels. `oa-feedback.js` serves both pages by mounting the form and the
inbox independently, each only where its markup exists.

**The account menu carries "Admin area N"** — the number of items waiting —
drawn for the maintainer alone (`adminish()` in `oa-accounts.js`: the resolved
session must match `OAFB.adminEmail` verified; the pre-resolve hint's address
alone decides so the menu's first paint is its final form). The count follows
the menu-badge rules above (cache first, refresh once per session, exact where
the data is loaded) and is computed by ONE function for both consumers —
`OAAdminArea.pendingCounts()` in `assets/oa-adminarea.js`, which
`oa-accounts.js` loads on demand (with `oa-news.js`) in the maintainer's
browser only, so the badge and the page's summary tiles can never disagree:
pending `jobReviews` + `heldCount` from `data/candidates-meta.json` (the same
file the front page announces from) + open `feedback` + pending changelog
entries.

**The summary strip ends on one STATISTIC — the Registered-users card**
(owner, 2026-08-23): a `count()` aggregate over `registeredUsers`, the
contentless per-account tally every sign-in already writes (oa-accounts.js).
It is /lit/'s registered-users tile with the visibility inverted — there the
figure is public, here it is **the maintainer's alone**: the collection is
admin-read in `_firestore.rules` (it was public-read, which nothing public
ever consumed) and the Admin area is the one place it is shown. The card is
deliberately NOT a queue: `registeredCount()` in `oa-adminarea.js` is separate
from `pendingCounts()`, so the "Admin area N" badge never counts it (a figure
nobody can clear would inflate it for ever) and no other page's badge refresh
pays a read for it. **The count is of PEOPLE, not sign-ins**: merging two
accounts deletes the duplicate's mark (`runMerge` step 5, while the merge can
still write as that user — the owner-delete the rules allow), so the figure
comes down on its own; a mark orphaned any OTHER way (an account deleted in
the Firebase console) stays until something like /lit/'s registered-users
audit exists here. The tightened read rule is **inert until redeployed**
(`firebase deploy --only firestore:rules --project operations-academia`) —
the card works either way, since the admin passes both rules; only the
public's API access waits on the deploy.

Candidate cards offer **Edit**, which opens the SAME form the candidate used
(`post-a-candidate.html?edit=<docId>` — the rules already let the admin read
and write any profile; no rules change shipped with this page, which
`testAdminArea` in `selftest.mjs` pins), and Take down / Put it back as status
changes (`hidden`/`queued`), never deletes. A withdrawn profile gets no
restore button — the candidate withdrew it themselves.

**The whole path is measured, not trusted**: a block in `page-test.mjs`
drives the badge, the tiles, the panels and the takedown against
`_fake-firebase.js` with a seeded queue — the expected numbers computed from
the same served files the code reads, a held profile asserted onto the
admin's screen with its Edit control, and a hostile submission (markup in a
name, a `javascript:` link) asserted inert. The shim grew chainable
`where().orderBy().limit()` queries for it.

The page is `noindex` (a named exception in `link-check.mjs`) and carries **no
`og:*` block** (`card: false` in share-check's PAGES): nobody shares the
maintainer's desk, and an `og:url` on it would claim an identity for a page
that answers only the admin. Drawing or hiding any of it grants nothing — the
collections are admin-read in `_firestore.rules`, which is the authorisation.

## Who has registered, and messaging them

The Admin area could **count** registered accounts and learn nothing else about
them. That was not an oversight — it was three separate deliberate decisions
meeting: `registeredUsers/{uid}` is contentless by contract (`hasOnly(['t'])`),
`profiles/{uid}` is owner-only with no admin clause, and **the e-mail address is
not in Firestore at all**; it lives in the Firebase Auth record, which no browser
can read for anyone but itself. So the maintainer saw "42" and had no way to know
who they were or to reach any of them.

    userDirectory/{uid}        the roster row — owner-written, maintainer-read
    messages/{uid}             one thread per account, keyed on the uid
    messages/{uid}/items/{id}  the messages themselves

**The address cannot be forged.** `email` must equal `request.auth.token.email`
— the pin-it-to-the-writer trick `directoryEdits.by` already uses — so a roster
row says what the account really signs in as rather than whatever its owner
typed. `first` is **write-once** (`request.resource.data.first == resource.data.first`
on update), which is why the owner may read their own row: the browser has to
send the stored value back, and it costs one read per session to do it.

**Identity could not go into `registeredUsers`, and the reason is the sibling
site.** On `/lit/` the same collection is PUBLIC-read, so a name and an address
there would be world-readable. The two sites are kept in the same SHAPE, so
neither puts identity in the tally.

**`registeredUsers.t` is not a joined date.** It is `set()` once per session, so
it is *last seen*; the roster says "First seen" and "Last seen" and never
"Joined". The true joined date is Auth's own `creationTime`, which only the Admin
SDK can read.

**The threads are TOP-LEVEL, and that is load-bearing.** Firestore ORs every
matching rule, so under the blanket `match /users/{uid}/{document=**} { allow
read, write: if isOwner(uid); }` a narrower rule can only ever GRANT more: the
owner's blanket write could not be taken away, and a user could forge a message
from the maintainer in their own inbox or clear the flag saying they owe a reply.
A top-level collection carrying a `uid` field is the shape `jobSubmissions` uses,
and the only one the maintainer can LIST at all. Keying the thread on the uid
also means the doc id IS its owner's uid, so `isOwner(uid)` on the items
subcollection is the id-composition guard in its strongest form — a stranger
cannot post into someone else's thread.

**It is IN-APP, not e-mail** (owner, 2026-08-24). Nothing here sends mail: there
is no SMTP path, no `List-Unsubscribe`, no delivery to stamp. That is also what
makes "no opt-out" defensible — a message lands in the person's own area on the
site, not in their inbox. The addresses carry `mailto:` links so the maintainer
can write from their own client when e-mail is what they want, and **the Feedback
page remains how a VISITOR starts a conversation**; this direction is the
maintainer's, so a person with no thread sees "no messages" and a pointer to
Feedback rather than a compose box the rules would refuse.

**A reply is a queue; the roster is a statistic.** "Message replies waiting"
joined `pendingCounts()` and the badge's key list (now six), because it is
something the maintainer can clear. The roster did not — the Registered-users
card stays out of every total for the reason its comment gives, that a figure
nobody can clear would inflate the badge for ever. It DID become a link, since
it now has somewhere to go; it was a `<span>` precisely because it opened
nothing.

**The user's badge counts what is UNREAD**, not how many messages the page
lists — the one badge on this site whose number is deliberately not the number
of cards below it, because a read conversation is not an empty one. It is one
`get()` of the person's own thread, so no query and no composite index.

`assets/oa-users.js` is its own file on purpose: `oa-accounts.js` fetches
`oa-adminarea.js` in the maintainer's browser on **every** page to compute the
badge, and roster rendering, sorting and CSV do not belong in that download.
**There was no CSV precedent in this repo**; `csvCell` quotes every field,
doubles internal quotes and defuses a leading `=`, `+`, `-` or `@`, because these
are names people typed and a spreadsheet would otherwise execute one.

The merge deletes the duplicate's roster row (or one person is listed twice for
ever, the bug the `registeredUsers` delete exists to prevent) but deliberately
NOT its thread: only the maintainer may delete one, and nothing here sends
anything, so an orphan costs no e-mail — unlike the alert subscriptions, which is
why those must go. The Admin area lists such a thread under "Threads with no
account". The merge hunk is byte-identical in `/v2/assets/oa-accounts.js`, which
`selftest.mjs` pins, so the collection name is read defensively there
(`(OAFB.col && OAFB.col.userDirectory) || 'userDirectory'`) — the archive's
frozen `col` map does not carry it.

**A reply needs a thread to reply to.** The items rule requires the parent
thread to `exists()` before an owner may write into it. Without that, an owner
could write unbounded documents under their own uid that no thread head points
at — invisible on a page that LISTS threads, and so an unbounded write channel
nobody would ever see. It also makes "only the maintainer opens a conversation"
true in the rules rather than only in the copy, at one billed read per reply.

**A broadcast is not an answer.** Sending to somebody who has replied leaves
`needsAdmin` as it was; only opening the thread and pressing "Mark answered"
clears it. Clearing it on send would drop an unanswered reply out of the queue
silently. The message and its bookkeeping go as ONE batched write, because half
of them landing would leave the recipient holding a message the roster does not
know about and the panel calling it undelivered.

**An account with no e-mail claim still gets a row.** The address is pinned to
`request.auth.token.email` but may be ABSENT — a provider sign-in need not carry
one, and demanding it would silently leave exactly those accounts off the
roster.

The rules publish themselves now (see "…and the FIRESTORE rules publish
themselves" above); both panels say what to press rather than showing a bare
permission-denied, and they say **reload first**, because the copy of the panel
reporting a missing deploy may itself predate it — which is exactly what
happened the morning it went live.

### The roster is seeded from Auth, or it lists whoever happened to come back

"31 Registered users" over a roster listing **one person** (owner, 2026-08-25).
Both numbers were right, which is what made it unreadable: `registeredUsers` is
the contentless mark every sign-in writes, while a `userDirectory` ROW is
written by the BROWSER, once per session — and the rules permitting that write
had been published minutes earlier. So the roster held precisely the people who
had signed in since. A panel whose own copy says "everyone who has signed in
since the roster shipped" is honest and no help to a maintainer who wants to
reach their users today.

**Firebase Auth knows all of them and only the Admin SDK can ask.**
`_scraper/sync-user-directory.mjs` (`.github/workflows/oa-user-directory.yml`,
daily + on demand) reads every account and writes the row the browser would
have — plus the one field CLAUDE.md recorded as unobtainable: the TRUE joined
date, Auth's `creationTime`, in place of "first seen by this site".

Three properties, and the first is the one that could have gone badly wrong:

* **Four keys and no more.** `rowOk()` pins a row to
  `hasOnly(['name','email','first','seen'])`. The Admin SDK bypasses the rules,
  so a fifth key would be written happily — and would then freeze that row
  against **its own owner** for ever, because the browser's merge produces a
  document `hasOnly` refuses. The selftest reads the allowed list out of the
  rules and pins it against `ROW_KEYS` both ways.
* **Dates only move in the safe direction.** `first` takes the earliest known
  (Auth's real joined date corrects a later "first seen"), `seen` the latest, so
  a sync can never contradict what the site itself watched happen.
* **A name the site holds is never overwritten** by Auth's `displayName`: the
  browser writes the name the account shows itself under, which is derived from
  the profile and is the better one where they differ.

An account already current costs no write, so a daily fire commits nothing. The
dispatch exists for the case that created the gap: right after a rules deploy.

### Both review tabs can be cleared a page at a time

`approveAll` was gated to the crawled tab on the reasoning that "approve-the-page
belongs to the GATE alone" — right about approving, wrong about the arithmetic:
the user-added tab opened with **86** postings and no way to clear them (owner,
2026-08-25), which is the same "a gate that can only be cleared 89 times does not
get cleared" that motivated the bulk action in the first place. Both tabs carry
one now; what must never cross over is the VERB. Approving publishes; a
user-added posting is already live, so its button ticks rows off the list and
says exactly that, and `page-test.mjs` pins that the word "approve" never appears
on it. The shared button is re-claimed by whichever tab drew last — wired only on
the crawled path, the user tab would have carried the previous page's handler.

**A filter with one value is still drawn.** The market-year row hid itself unless
a tab held two seasons, and an empty space where a control belongs reads as the
control being MISSING — which is how it was reported.

Tests: `testUsersAndMessages` in `_scraper/selftest.mjs` (the rules against the
module BOTH WAYS for all three key sets, the pinned address, the write-once
`first`, the owner's two narrowed updates, CSV injection, nulls-last sorting,
and the wiring on all four pages) and the roster/messaging block in
`_scraper/page-test.mjs` (the money path in a real browser, hostile input
included, plus the 390px gate).

## What "immediate" costs, and where the waiting used to be

A posting is decided in Firestore and served from `data/` by GitHub Pages, so
publishing is always a pipeline. The rule is that **nothing waits for a
schedule that a decision could have started**.

* **A posting made or edited on the site** — `publishOnChange` in
  `_functions/index.js` dispatches `oa-jobs-changed` and `oa-jobs-build.yml`
  runs at once. About a minute.
* **A posting APPROVED in the review queue** — `publishOnReview` dispatches
  `oa-jobreview-decided` to `oa-jobmarket-sheet.yml`, because
  `data/jobmarket.json` holds the approved rows and only that job writes it,
  and `oa-jobs-build.yml` then runs on that workflow's `workflow_run`
  completion to merge the file. Two workflows, one chain, about two minutes.
  It used to be two independent schedules — up to half an hour, then up to
  twenty minutes more — which is most of an hour after the maintainer had
  already decided.
* **An e-mail alert whose criteria a new posting matches** —
  `oa-alerts-mail.yml` runs on the build workflow's SUCCESSFUL completion as
  well as hourly, so an "as soon as something appears" subscription is served
  minutes after the posting publishes rather than by the top of the next
  hour. Cheap by construction: each alert's high-water mark means a fire with
  nothing new sends nothing, and a failed build (which committed nothing)
  does not fire it at all.

The schedules stay as the safety net and every job is idempotent, so a missed
doorbell costs a delay and never a posting.

**The functions are deployed BY HAND** (`firebase deploy --only functions
--project operations-academia`, from the repository root), and a doorbell that
was never deployed looks exactly like a site that is simply slow — there is no
error anywhere, everything still publishes, just on the schedule. That is worth
checking first whenever "it takes ages to appear" comes up:
`firebase functions:log` should show `build dispatched` / `sheet read
dispatched`. The setup page's paths were stale after the promotion (it said
`cd v2`, where there are no functions any more); they are fixed.

**The last stretch of the delay is the reader's own browser.** Pages serves
`data/*.json` with ten minutes of freshness, so a visitor who had the page open
recently was shown what they already had, however fast the pipeline was. Every
fetch of `data/` and `changelog.json` passes `cache: 'no-cache'`, which
REVALIDATES rather than re-downloads — a 304 with no body when nothing changed.
**A new fetch of a served data file must carry it.**

Copy that promises a time is part of this: the forms and the review panel say
"within a few minutes", and if the cadence ever changes, they change with it.

**And the EDITOR does not wait even that long** (owner, 2026-08-24: "when the
admin edits a posted job, the edits should be shown immediately"). Saving an
edit — or taking a posting down — leaves an ECHO in that browser's
localStorage (`assets/oa-fresh.js`), and every page that renders
`data/jobs.json` overlays it at read time: the jobs page the editor opens
next already shows the correction, while the pipeline publishes it for
everyone else exactly as before. It is the header-hint idea applied to a
posting, and it is honest by construction: PER BROWSER (nothing leaves the
machine, so no visitor can see an unpublished value); echoing ONLY what the
build would publish (a pinned subset of `PUBLIC_FIELDS`, the Apply-by line
composed by a parity-pinned browser twin of `composeApplyBy`, values taken
from the form AFTER `canonColumns()` and the name fixes); and STANDING DOWN
against the build, not against hope — the echo is dropped when the served
row carries every echoed value, when `data/jobs-meta.json`'s `generated`
stamp shows a build begun after the save has published (its sanitisers have
the last word, even where they disagree), or after an hour. The overlay is
hooked into `OAList.load` (one place, every consumer) plus
previous-markets.html's own fetch; the stash is written by the edit form and
by oa-jobedit's takedown. `testFreshEcho` in selftest.mjs pins the parity
twins, the field whitelist and all the wiring; page-test.mjs measures the
echoed card on the rendered jobs page. A posting's identity (`id`, `year`,
`posted`) is deliberately not echoable — an edit does not move a posting,
and the echo must not either.

## The admin change e-mail reports what CHANGED, not what was healed

"[OA] Job postings changed: 22 edited", daily, for postings nobody had touched
(owner, 2026-08-25: *"you are not editing these jobs all the time, right? then
why the emails?"*). Two independent causes, and together they accounted for all
23 of the phantom edits measured against the live data.

**One: the diff was taken against the WRONG SIDE of the pipeline.**
`build-jobs.mjs` computed `collectChanges(existing, freshVisible, …)` —
`freshVisible` being the rows as the DOCUMENTS and the WORKBOOK state them,
while the file it then writes is `rows`: the same postings after the merge, the
collapse, and every heal the build applies on the way out (`healCountry`,
`healReviewDate`, `stripRowEmails`, `healPlace`, and mergeRows' preservation of
`addedAt`). Those heals are the whole point — the source keeps saying what it
always said and the build keeps correcting it — so diffing the served file
against the RAW rows reported every correction as a fresh edit on every write,
for ever. UCLA's suggested/final deadline split, a canonicalised department, a
regenerated "Further info" link: all permanent, none of them an edit.

It is `collectChanges(existing, rows, …)` now, which is the honest comparison —
the previous served file against the one about to replace it — and it fixes a
second symptom of the same slip: the log **overcounted new postings in the
other direction**, announcing `+12 new` on the run that added 3, because nine
of the twelve were duplicates `collapseSameDay` folded away after the count was
taken. The `+ ref` listing under it iterates `rows` for the same reason; it had
been naming postings nobody could then find on the site.

**Two: `addedAt` was diffed at all.** It records when the dataset first saw a
posting, it is the only cursor the e-mail alerts have, and `mergeRows` carries
it over from the previous row precisely so a re-read never re-stamps it. Nobody
edits it. It is skipped in `diffRows` beside `id` and `adPending` now — 17 of
the 23 were this one field, and the block that sends the e-mail already claimed
"bookkeeping writes never produce an e-mail", which is only true with both
halves in place.

**A genuine edit still mails**, which is the point of the feature: if a poster
or the maintainer changes a posting, `rows` differs from `existing` and the
before/after goes out. Measured after the fix: an unchanged rebuild reports 0.

While proving it, a third defect in the same block: the run log's
`N posting(s) healed against the directory or their own deadline prose` counted
by OBJECT IDENTITY (`r !== visible[i]`). `healCountry` returns the row itself
when it changes nothing, but `stripRowEmails` spreads unconditionally — so every
row was a new object, the line reported ALL 541 every run, and then named the
first eight as though they were the healed ones. It compares by value now. A log
line that names innocent rows is worse than no log line: it is what made those
eight postings look like the ones being edited.

Pinned by `testChanges` in `selftest.mjs` — the `addedAt` skip, an unchanged
rebuild reporting nothing, a collapsed row never counted as new, and the
build's own source read back to check it diffs `rows` and never `freshVisible`
again (reproducing it for real needs Firestore and the workbook).

## A text search holds SEVERAL terms

Every `type: 'text'` filter in `assets/oa-list.js` takes more than one term:
typing filters live as it always did, and **Enter banks the term as a chip** so
the next one can be typed straight away. `sel[key]` is a `Set` for text filters
and pickers alike, with the half-typed word kept beside it in `drafts[key]`.

**The terms are OR'd, and that is the only reading that returns anything.** A
posting has ONE institution, so "columbia" AND "insead" is empty by
construction; a reader typing both means "either". A single term behaves
exactly as before, which is what keeps every saved link working.

The URL carries **one parameter per term** (`?institution=utah&institution=princeton`),
so a multi-term search is shareable, and a legacy `?filterA=` deep link — the
universities map still emits one per school — lands as a chip the reader can
see and remove rather than as bare text in the box.

**Chips must never move the control above them.** The v3 bar is a grid; its
items were bottom-aligned, so a filter carrying chips was a taller cell and
pushed its own control upwards, leaving "2 selected" floating above the boxes
beside it. The items are top-aligned instead, and the Clear button — which has
no label of its own — gets that height back from an empty `.oa-label-spacer`
styled by the same rule as a real label, rather than from a pixel value that
would silently drift when the type changes. `page-test.mjs` measures the
baseline per row and fails if any control leaves it.

## A guard that fires on a legitimate posting stops the whole site publishing

`oa-jobs-build.yml` rebuilds `data/`, runs `selftest.mjs` over what it is about
to commit, and commits nothing if that is red. That is right — a broken dataset
must not ship — and it has one failure mode worth knowing, because it happened:
a posting sat in Firestore marked **Live**, the maintainer's page said so, and
it was never on the site, because every build for hours had gone red and
therefore committed nothing. Nothing was broken in the pipeline; nothing was
published either, and the two look identical from outside.

Both red guards were pinning a PAST repair over the WHOLE of a live file:

* "every Houston posting names its college and department the one way" — a new
  Houston posting that named its college and no department failed it. Naming
  no department is allowed;
* "every Tulane posting names one school" — a posting arrived with an empty
  School field and `Freeman School of Business` in the Department one.

So: **a guard about specific rows names those rows** (the Houston pair is keyed
on its own date now), and **a guard over a whole file asserts a RULE that any
legitimate row satisfies** — that the names are canonical, which `canonPlace`
already pins over every row. An empty field is not a second spelling.

The Tulane shape was a real ingest gap and is fixed as one: `assemble()` in
`oa-schools.js` moves a **school typed into the department box** across into
the school field, the mirror of the fused-school-field split it already did,
and **curated, never guessed** — the value must be a name `SCHOOL_LIST` or its
aliases already know, so a real department is never promoted for carrying a
school-ish word, and a row that named both is untouched.

The build now also prints a `::error::` saying publishing has stopped when the
re-check is what failed, so the log names the consequence rather than just the
assertion.

It happened a third time on 2026-08-24, twice in one morning, and both were
the same shape again. (1) One posting arrived from Firestore with a contact
e-mail address in its text, and the served-file guard — right that nothing
under `data/` may carry one — stopped every build from 03:14. The address is
now removed AT INGEST (`stripEmails`/`stripRowEmails` in jobs-model.mjs,
applied in `rowFromSubmission`, the review queue's `applyEdits`, the sheet
sync, and over build-jobs' whole merged set — the healCountry pattern; a
marker says something was removed, and stored URLs are never rewritten).
(2) The two advert-verify passes wrote jobmarket.json's copy of EVERY sheet
row back into jobs.json, reverting heals only the build applies — UCLA's
suggested/final deadline split — and the mirror guard stopped their commits.
They now patch ONLY the deadline fields of ONLY the rows they filled
(`patchDeadlines` in jobs-model.mjs). `testGuardRepairs` pins both, wiring
included.

### It happened again, at the scale the queue was built for

The morning the maintainer approved a season — **449 postings in one sitting** —
both halves of the pipeline went red and the site's data stopped moving. The
sheet read failed on ONE row and therefore wrote none of the 449 to
`data/jobmarket.json`; the build, reading the approved queue documents directly
behind it, then failed on eight guards and committed nothing either. Everything
was working. Nothing published.

Five separate faults, and the shape of each is worth keeping:

* **Two boxes for one fact.** The review card offered "Apply by" beside
  "Closing date", one posting was approved with the line emptied and the date
  left behind, and `selftest.mjs` asserts over the served file that *the date
  shown and the date filtered on are the same date*. That is precisely the
  `department` bug one section down, on the deadline — so the same remedy:
  `settleDeadline` in `applyEdits` DERIVES the line (`derived: true`, out of
  `SHOWN`), the card previews what will be published under the date box, and
  words about a search with no closing date go in the comments.
* **A guard about two rows, keyed on their date.** The Houston pair guard
  matched `/houston-20250923/` and caught three new legitimate postings of the
  same day. A guard about specific rows NAMES those rows.
* **A guard asserting on a tie-break.** The `RULED` rulings look a university
  up in `data/vocab.json`, which is keyed by whichever spelling has the most
  postings — `pickForm` calls that "a tie-break, not a policy" — and one new
  posting under "University of Texas at Dallas" moved the entry off "The
  University of Texas at Dallas". Anything asserting about a PLACE asks
  `institutionKey` (`uniEntry` in selftest.mjs), never the current spelling.
  `AWAITING_OWNER` is keyed the same way.
* **An exemption narrower than the thing it exempts.** The mirror round-trip
  guard excused a row whose `type` the workbook left blank; the workbook may
  leave ANY of the fields a submission needs blank, and three postings arrived
  short of a different one each. It is keyed on `SUBMISSION_NEEDS` now, pinned
  against `rowFromSubmission` itself so the list cannot drift.
* **A tidiness sweep with a publishing-sized consequence.** Sixteen pairs of
  department names — the workbook writes the FIELD where the site asks for a
  department, so "OM" arrives beside "OM/SCM" and "SCM/OM" — stopped the whole
  site. Two of them were not pairs at all: `similarNames` matched its substring
  tier against raw text, so "IS" was found inside "Decision". That check is
  word-aligned now, which also stops the posting form offering the same
  nonsense as a "did you mean".

**And the last of those changed a rule.** `selftest.mjs` has two jobs with very
different costs: as the PR check (`oa-checks.yml`) red means somebody reads the
failure and nothing on the live site moves; as a data writer's re-check red
means that workflow commits NOTHING — not the offending row, everything. So the
two duplicate-NAME sweeps, which are about tidiness rather than about the data
being right, now report in the second role and fail in the first.
`node _scraper/selftest.mjs --publishing` selects it, every workflow that
writes `data/` passes it (both its precondition run and its re-check), and
`oa-checks.yml` deliberately does not — pinned both ways, because the flag
missing from a writer is this outage and the flag creeping into the PR check
would leave nothing enforcing it anywhere. The pairs are named in the run log
either way.

**Two sources can mint one id, and the later writer wins.** A posting's id is
(market year, institution, date) plus an ordinal for the same day, and ids are
how `mergeRows` joins — so when the workbook's three Houston rows of 2025-09-23
were approved they took `2026-university-of-houston-20250923` and `…-2` from
the two LEGACY rows that held them, and those two went off the site with their
advertisement links. Nothing warned; the only reason it was noticed at all is
that a guard named those ids. Whether that matters is the maintainer's call —
the workbook and the legacy sheet are plainly describing one Bauer hiring
round, so this may be a merge rather than a loss — but the MECHANISM is luck,
not design, and a fix would have to change ids, which are permalinks and the
join key for `rowOverrides`, the review queue, the mirrors and the Edit button.
Not attempted here.

**What is still the owner's to settle.** The fourteen surviving pairs are in
`AWAITING_OWNER`, and every one of them exists because the workbook's
hiring-unit column holds a FIELD ("OM", "BA", "SCM/OM", "IS/OM/SCM/BA") rather
than a department name, which the pipeline then publishes as the department.
Ruling on them one at a time treats the symptom; the remedies are to name the
department in the sheet, or to teach `jobmarket-sheet.mjs` that a field code is
not a hiring unit and carry the sheet's own words onto the card the way an
unbelievable deadline already is (`Deadline as listed: …`). Neither is done
here: it changes what a posting PUBLISHES, and 449 of them were approved as
they stood.

### …and a fourth time, because the flag was only half the fix

The demotion above moved TWO of the three near-duplicate sweeps to `tidy`. The
third — "every OM-list school lands on ONE school group" in
`testDirectoryWiring` — was left on `eq`, and `--publishing` cannot help a
sweep that fails in both roles. On 2026-08-25 somebody posted a job at The
Hong Kong Polytechnic University and named its school **"Faculty of
Business"**, which is what the faculty is called; `oa-omlist.js` and
`oa-institutions.js` both carry it as "Faculty of Business (incl. Logistics
and Maritime Studies)"; the two spellings met in `data/directory.json` — which
`build-directory.mjs` merges FROM THE POSTINGS, so any poster can grow that
list — and the sweep went red. Five consecutive builds committed nothing. The
sibling sweep two thousand lines above reported the SAME pair as a warning and
passed, which is how thoroughly this was a decision about the guard rather
than about the data.

What it cost is the exact thing the owner reported: three user-added postings
and nine the maintainer had just approved sat unpublished, `data/jobs.json`
frozen at 07:24, with the site showing none of them and nothing anywhere a
reader — or the maintainer — could see. Every build's log said
`+12 new … wrote data/jobs.json`, because the build DID all of it; only the
commit was withheld.

Both halves are fixed. The sweep is `tidy` like its siblings. And the rule is
now pinned where it is actually decided rather than in the workflow files: an
assertion whose message says two names are one place must be a `tidy` call,
read out of `selftest.mjs`'s OWN source by `testReviewWiring` (the count is
pinned too, so deleting a sweep cannot be a way to make it quiet). **A new
near-duplicate sweep goes through `tidy`, always** — the PR check is where a
naming duplicate fails, and it is fixed by an alias, never by holding real
postings back.

The pair itself was settled in `SCOPED_SCHOOL_ALIASES`, not in either curated
module: the rule there already covers it ("the longer string is not a fuller
name but a parenthetical acronym, a campus note…"), the parenthetical
annotates a department the same record already carries as its own, and one
alias reaches both hand-compiled sources, survives a regeneration of either,
and canonicalises a posting typed with the annotation too.

## Mobile standards for tables and lists — MUST consult

**Before building or changing ANY table / card-list page (job postings,
candidates, placements, past markets, or a new one), read
`_MOBILE-STANDARDS.md` and follow it.** In short: mount the shared `OAList`
engine (`assets/oa-list.js` + `assets/oa-list.css`) so the mobile rules are
inherited rather than re-implemented, and add the new page to the
`MOBILE_PAGES` list in `_scraper/page-test.mjs` in the same change. When a
new rule is needed, add it to `_MOBILE-STANDARDS.md` in the same change that
first applies it — the file is the living standard, not a snapshot.

## One spelling per country

`assets/oa-countries.js` is the **single definition** of what each country is
called — a dual-mode file (browser `window.OACountries`, Node `require`), like
`assets/oa-alert-match.js`. It holds the canonical `LIST` the posting form
offers, an `ALIASES` table, and `canon()`.

The country is free text on the form and was free text in the spreadsheets the
archive came from, so one country arrived under several names ("USA"/"UK"/"Hong
Kong SAR"/"Shenzhen, China"), each becoming its own entry in the jobs page's
Location filter. Canonical names are the **full** ones: `United States`, not
`USA`.

**When a new variant turns up, add it to `ALIASES` — never hand-edit the data.**
`data/jobs.json` is rebuilt from Firestore every morning, so a patched row comes
back the next day, whereas an alias fixes it permanently and for every past row
at once. `canon()` never invents: a country it does not recognise is published
under the name its poster gave it.

It is applied at every ingest (`jobs-model.rowFromSubmission`,
`import-sheet.mjs`) and on both sides of every comparison in the alert matcher —
that last one matters, because an alert saved under an old spelling would
otherwise stop matching silently.

### A US city is not the country it is named after

`canon()` reads a comma-separated value from the RIGHT, because the last part of
an address is its most administrative one. That is right, and it had one hole:
a part that is a US CITY sharing a country's name won before the state beside it
was ever considered. St. John's University is in **Jamaica, New York**, and the
site published it under the country **Jamaica**.

So `US_STATES` settles the country — the same "most administrative part wins"
rule the reverse scan already expressed, since a state sits below a country and
above a town. **Georgia is the one that needs care**: it is the only US state
that is also a country, so its NAME settles nothing ("Athens, Georgia" still
reads as the country, because guessing is worse than leaving it) while its
ABBREVIATION settles everything — dropping "GA" with the name left Emory's
`Atlanta, GA 30322` unreadable, which is a bug of its own.

### Where a university actually IS, and the nine postings filed under Greece

`country` drives the jobs page's Location filter, so a wrong one **does not look
wrong**: the posting quietly files itself under a country it has nothing to do
with, and nobody filtering by the right one ever sees it. Nine live postings —
American, Canadian and Singaporean universities — were published under Greece.

**The cause was a form field, not a pipeline.** `post-a-job.html`'s country box
carried no `autocomplete` attribute and is called `country`, so a browser filled
it from the EDITOR'S OWN address profile the moment they opened a posting to
correct something else, and saving published it. The institution box had
`autocomplete="organization"` — the poster's own employer, over the university
they are advertising. Both are `autocomplete="off"` now, and the selftest pins
them; the poster's own name and e-mail keep their autofill, which is what those
tokens are for. On the **candidate** form the affiliation genuinely IS the
person's own, so it keeps `organization` — the rule is whether the field
describes the person filling it in or somebody else.

**The authority for repairing what already happened is the site's own
Universities directory.** Every row of `data/universities.json` carries the
campus's postal address, and `countryFromAddress` reads the country off it;
`campusCountries` in `vocab.mjs` turns that into one answer per university.
`healCountry` corrects a row that contradicts it, and `build-jobs.mjs` applies it
to the MERGED set — the fault came from an editor, not from a source, so it must
be repaired whichever writer produced the row. **`sync-jobmarket-sheet.mjs`
applies it too**, on every read of the workbook and in its `--heal-names` mode:
`data/jobmarket.json` is a served file in its own right, so a wrong country
there files a workbook posting under a place it has nothing to do with even
before the build merges it. The selftest asserts over both files, and reads
both writers' source to check each really heals — a heal only one of them
applies is undone by whichever writes next.

Three properties make that safe, and all three are pinned:

* **A university with two countries is never healed.** INSEAD is in France and
  in Singapore, so its rows disagree and it has no answer here at all — the same
  discipline `schoolForUnit` applies to a department two schools both claim.
* **The parser never invents.** An address that is a map-URL fragment or a bare
  postcode returns `''`, and the audit then says nothing about that university
  rather than guessing.
* **The guard asserts only what the publisher guarantees.** The selftest checks
  `data/jobs.json`, which the build heals before writing, so it cannot fire on a
  legitimate new posting — the failure mode this file records twice. The
  ARCHIVE, which has no daily build, is swept by `country-audit.mjs` as its own
  CI step instead.

**A university the directory does not carry** has no address to read, so its
postings cannot be checked — `node _scraper/country-audit.mjs --all` lists them.
Map it in the Universities sheet, or add the campus country to `CAMPUS_COUNTRY`
in `_scraper/vocab.mjs`, which is grown one curated line at a time exactly like
`oa-institutions.js` and only where the country is not in doubt.

## One spelling per university, school and department

`assets/oa-schools.js` is the **single definition** of what each university,
school and department is called — the same dual-mode shape as
`assets/oa-countries.js` (browser `window.OASchools`, Node `require`), and held
to the same rules.

The three names were free text on the old form and packed into ONE column in
the sheets the archive came from, so one department arrived under half a dozen
names. Tulane's was posted as "Freeman School of Business", "Freeman School of
Business, Management Science", "…, Management Sciences Area", "A.B. Freeman
School of Business, Management Science Department" and "A. B. Freeman School of
Business / Management Sciecne" — five entries in every filter for one place.

What is canonical:

* the **full official name** of the university and the school ("A. B. Freeman
  School of Business"), as with countries;
* the **bare field name** of the department — "Management Science", never
  "Management Science Department", "Management Sciences Area", "Department of
  Management Science" or "…group". The wrapper word is how one school happens
  to organise itself and is exactly what differs between two people describing
  the same unit; the school it sits under is the neighbouring field already.

`canonPlace({institution, school, unit})` does all three at once, because WHICH
of the three a name belongs in is part of what it decides: a department fused
into the school field is moved across ("Kelley School of Business - Operations
and Decision Technologies"), and a legacy archive row that packs all three into
the university field is taken apart ("University of Pennsylvania (The Wharton
School), Operations and Information Management (OPIM) Department"). It is pure
and idempotent, so every writer can apply it on every rebuild.

**When a new variant turns up, add it to `INSTITUTION_ALIASES` /
`SCHOOL_ALIASES` / `UNIT_ALIASES` — never hand-edit the data**, for the reason
the country table gives: `data/jobs.json` is rebuilt from Firestore every
morning. `canon()` never invents — a school it has never seen is published
under the name its poster gave it, and a comma that is part of a name is left
alone ("University of California, Berkeley", "The Chinese University of Hong
Kong, Shenzhen", "Bayes Business School, Faculty of Management").

It is applied at every ingest — `jobs-model.rowFromSubmission`,
`import-sheet.mjs`, `jobmarket-sheet.mjs` — and in the posting form itself
(`assets/oa-jobform.js`), so a poster's own preview and their My postings page
read the way the posting will publish. `data/vocab.json`, the list the form
offers, is built from the canonical rows, so the next poster is offered the
spelling the site already uses.

It also has a third level: `byUniversity[uni].bySchool[school]`, and a
top-level `bySchool` for the case where the university is not known yet. See
the next section.

## A list worth opening: which schools EXIST

`assets/oa-schools.js` above says what a place is CALLED. `assets/oa-institutions.js`
says which places exist — a seed of the world's operations and supply chain schools
(178 records: a university, its business school, and the department doing operations
there), in the same dual-mode shape.

**It canonicalises nothing.** Two `canon()`s would be two answers to one question and
the disagreement would be silent, so a spelling that needs fixing is fixed in
`oa-schools.js` and a place that is missing is added to `oa-institutions.js`. Every
seeded row goes through `canonColumns()` on the way into the vocabulary, so a seeded
place and a place that has actually posted land on ONE spelling and ONE entry.

The seed is what the posting forms offer beyond the site's own history: without it
they could only ever list places that had already advertised here — 63 universities
— so a first-time poster from Bilkent, Cranfield, VinUniversity or Kühne Logistics
met a blank list and typed their name from scratch. It joins through the SAME
`directory` argument `data/universities.json` uses (`institutionSeed()` in
`build-jobs.mjs`), so it inherits everything that already applies to those rows,
and the count `n` still counts POSTINGS ONLY: a seeded name nobody has posted from
carries `n: 0` and claims nothing.

**A university's business school and its industrial engineering school are
different schools, not duplicates.** Departments hang off a (university, school)
pair, which is what `byUniversity[u].bySchool` is for. The seed's source is a
BUSINESS-school directory — one university, one school — so a second school comes
from the site's own directory beside it; the selftest asserts the requirement on the
BUILT vocabulary, where it actually has to hold, not on the seed.

**Two hand-compiled sources name one school long and short.** "Sloan School of
Management" and "MIT Sloan School of Management" were two rows in Toronto's, MIT's
and twenty other universities' school lists, with the postings on one and the
departments on the other. That is settled in `SCOPED_SCHOOL_ALIASES` — scoped
because most of these short forms are generic and a global "College of Business"
alias would rename every university's. The name kept is the FULL OFFICIAL one,
except where the longer string is a parenthetical acronym, a campus note or two
names fused with a slash; where a school has been RENAMED, the current name wins.
The selftest pins that no university offers one school under two names, and that
each university is offered once.

**An alias added today reaches yesterday's postings.** A posting with no document
behind it is carried from the previous `data/jobs.json` unchanged, so it never went
back through an ingest to hear about a new alias — the site published one school
under two names for ever, and the selftest's "every posting names its place the one
way" guard went red, which by design stops the build committing anything at all.
`healPlace` (`jobs-model.mjs`) is applied to every carried row in `build-jobs.mjs`;
it is pure and idempotent, so a run with no new alias changes nothing. The `id`
deliberately FOLLOWS the institution name, as it did when Penn State became The
Pennsylvania State University.

`data/past-postings.json` has no daily build to heal it, so it gets a mode of its
own: **`node _scraper/import-legacy-tables.mjs --heal-names`** (offline, no sheets)
— run it after adding an alias; it covers all three files the importer writes.

**A heal mode is not enough on its own, because `data/` is rewritten from the
sheets.** The importer must canonicalise ON WRITE as well, and originally it
canonicalised nothing at all. Healing only `past-postings.json` there was
caught by CI within the hour: the import job ran `--fetch`, wrote 254 raw
`universities.json` rows, and the selftest's "the map names every place the way
the site does" guard went red on 213 of them. All three write paths are now
healed and pinned by name in `selftest.mjs` — a heal that the next dispatch
undoes is not a fix.

The picker (`assets/oa-combo.js`, dual-mode so its ordering is unit-tested) opens
**alphabetically** — accents folded onto their base letter, so École sits between
Duke and Emory — and narrows as you type. The usage count still labels a row but no
longer orders one: count-first reads as no order at all once the list is three
hundred names long, where the reader knows the name they want and is looking for
it. The render cap went with it (60 → 400 → 1000, the last when the 2026-08-23
bulk approval took the vocabulary past 400 universities and VinUniversity fell
off the end): an alphabetical list cut short ends mid-alphabet and tells the
reader to keep typing without their being able to tell whether their
university is there at all.

**Anything that paints its own ground must name its own ink.** The picker's panel
set `background: #fff` and no colour, so under the dark theme it inherited `--ink`
and drew near-white names on white — 1.65:1, an invisible list rather than a
contrast near-miss. Its surfaces are theme tokens now, each keeping its old light
value as a fallback for the frozen archives, and `page-test.mjs` measures the
rendered ratio in BOTH themes (a fix that only darkened the panel would trade one
broken theme for the other).

**Where a school names its own unit, that name wins.** The bare-field-name rule
above is right in general — "Department", "Area" and "group" are exactly what
differs between two people naming one unit — and wrong for six schools the owner
ruled on (2026-08-18), where the wrapper IS the name: UT Dallas has an Operations
Management **Area**, Purdue a Supply Chain and Operations Management **Faculty**,
Yale an Operations **Department**, Emory an Information Systems **&** Operations
Management. `SCOPED_UNIT_ALIASES` keys them by university (safe for the same
reason the school table is: no other school at those six carries the name, which
the selftest asserts) and the answer is **TERMINAL** — returned exactly as
written, never put back through the rule that would undo it, and never through
`spell()`, which turns " & " into " and ". The lookup asks three ways — as
written, as `spell()` rewrites it, and as the generic rule would leave it —
because listing every wrapper a source might use is the losing game the bare-name
rule exists to avoid. Everywhere else the generic rule is untouched, which is the
whole safety argument for scoping it. `canonUnit(v, institution)` takes the
university, so `assemble` and the posting form's picker both pass it; a
`canonUnit` asked without one still answers the generic way, which is why
`isCanonicalUnit` consults the scoped names directly.

**A substring check is blind to a reordering, and it cost two duplicates.**
"Michael Smurfit Graduate Business School" and "UCD Michael Smurfit Graduate
School of Business" contain neither one another, nor do "Olin Business School"
and "Olin School of Business" — so both went on being offered twice through a
green suite. The selftest now compares names TWO ways: substring, and the
DISTINCTIVE WORDS as a set, dropping the generic ones ("school", "of",
"business") and the university's own name and initials. Department pairs that
are one group or two — only the owner can say — are named in `AWAITING_OWNER`
in `selftest.mjs` rather than silently tolerated: a new pair fails the build, a
listed one is reported by `node _scraper/selftest.mjs --open`, and an entry is
deleted when it is ruled on (the answer going into `SCOPED_UNIT_ALIASES`).
An entry may be listed AHEAD of its pair reaching the committed vocabulary —
it has to be: the posting that introduces the pair sits in Firestore until the
next green build, and demanding the entry and the pair arrive together made
that build impossible (red before the entry, red after it). The selftest
reports such an entry instead of failing on it; one still reported after its
pair has shipped or been settled is stale and should be removed.

**One spelling per place means EVERY dataset, not just the postings** (owner,
2026-08-18: "let's use the same consistent University Name, School Name,
Department Name, across the entire website"). `data/jobs.json` and
`data/past-postings.json` had been canonical for a while; the two datasets
`import-legacy-tables.mjs` writes had never been canonicalised at all — 213 of
the map's 254 rows and 9 faculty placements named their place some other way,
and the map is where a reader LANDS from every posting's "Further info" link.
So `--heal-names` covers all three files it writes, and `sync-jobmarket-sheet.mjs`
has a mode of the same name for the workbook's own postings. Each is offline and
idempotent; the selftest asserts all four datasets together.

Two rules the map heal follows: its `name` and `schoolDept` are DERIVED (the
three names joined) and are rebuilt with them, unless the sheet said something
of its own ("TBC"); and its **`id` never moves**, because the maintainer's
read-time corrections are stored against it (`rowOverrides`,
`<dataset>__<rowId>`) and a renamed id orphans every correction already made.

**A duplicate key in an object literal is silent.** Adding a second
`'Stanford University'` to `SCOPED_SCHOOL_ALIASES` did not merge or warn —
JavaScript kept the last and dropped the earlier rule, so an alias that had
worked for weeks stopped and the only symptom was Stanford listed twice.
`testNoDuplicateKeys` reads the tables from the SOURCE, because by the time the
module has evaluated the evidence is gone.

## The posting form's three name fields cascade

`post-a-job.html` asks for the university, the school and the department
separately, and the three are connected: choosing a university narrows the
school list to that university's schools, and choosing a school narrows the
department list to that school's departments. The lists come from
`data/vocab.json` (`byUniversity[uni].bySchool[school]`, plus a top-level
`bySchool`), and the picker renders a scope under its own heading —
`setScope()` in `assets/oa-combo.js`.

**The cascade is ONE file, `assets/oa-place-picker.js`, and two pages mount
it** — the posting form and the review queue's cards on `admin-area.html`, which
ask the maintainer the same three questions about the same three names. It used
to live inside `oa-jobform.js`, bound to three ids on one page; a copy for the
review panel would have been the drift every other shared module here exists to
prevent. `OAPlacePicker.wire({institution, school, unit}, {onChange})` returns
`{destroy}`, and a caller that re-renders its markup MUST call it: every picker
adds a `document`-level listener (the only way to see a click land outside its
own list), so `OACombo` grew a `destroy()` for exactly this, and the review
panel unmounts before each redraw. The module memoizes the `vocab.json` fetch
(one request per page, however many cards mount it; a failed read is not
remembered), and the selftest pins all of it.

**The vocabulary has a second source: `data/universities.json`**, the site's
own Universities directory. Its 254 curated (institution, school, department)
rows are what let the cascade work for a university that has never posted here
— they add names and, more importantly, they say which department sits in
which school. They carry NO posting count (the "4 postings" note stays a count
of postings), and they are put through `canonPlace()` like everything else,
since a directory row has never been through an ingest. `data/past-postings.json`
is deliberately NOT a source: its legacy rows never separated the institution
from the school and the department, so feeding it in would put the very mess
the vocabulary ends into the university picker.

**A scope is a HINT, never a restriction.** Typing searches the whole site
under a second heading, and a name nobody has posted before is still offered as
a new one — a school that opens a department tomorrow must stay postable. Two
rules follow, both pinned in `page-test.mjs`:

- changing the university **re-scopes the lists, never clears the fields**.
  What the poster typed is theirs;
- a NEAR MISS still finds the university: on leaving the field, text that can
  only be the beginning of one university becomes that university ("tulane" →
  "Tulane University"). Without it the cascade quietly went away — the school
  list opened at every school on the site and the posting was filed under a
  name nobody else uses — and the only thing on screen that said so was the
  absence of a heading. Text that could be several universities, or none, is
  left exactly as typed;
- the fields are put into the published spelling as the poster leaves them, by
  the same `canonPlace()` the submission goes through — so what they read back
  is what everybody else will read. The one exception: a lone institution with
  no school or department yet is canonicalised on its own, because
  `canonPlace()` reads a lone institution as one of the archive's fused
  one-column values and takes it apart.

Two smaller conveniences: a department the site has only ever seen in one
school fills that school in above it, and `assets/oa-combo.js` takes its idea
of "the same name" from its caller (`key`), so the picker itself needs no name
rules of its own.

**Grouping is not publishing.** `institutionKey()` in `assets/oa-schools.js`
answers "is this the same university?" — a trailing acronym and a leading "The"
folded away — and is used ONLY where names are grouped: `data/vocab.json` and
the form reading it back. `canonInstitution()` goes on publishing each posting's
own name, because its id and its permalink are built from it, and "Baruch
College, The City University of New York (CUNY)" is deliberately published
whole. The directory lists one university under several names; the picker must
not offer half its schools from one entry and half from the other.

**A slight respelling is offered a MERGE before it can become a second
entry.** The picker's "new name" row is what lets a school that opens a
department tomorrow stay postable — and it is also how one place quietly
becomes two ("Operation Managment" beside "Operations Management", each with
half the postings). So when the typed name is probably a respelling of one the
site already lists, the picker draws **"did you mean" rows pointing at the
existing entry directly above the add-new row** (`oa-combo.js`, fed by
`similar()` closures in `oa-place-picker.js`). A suggestion, never a
restriction: the add row stays, because only the poster knows whether their
department genuinely is new. The judgement is ONE function —
`similarNames(a, b, {university, fuzzy})` in `assets/oa-schools.js` — with two
strictnesses that must not be swapped: the STRICT tier (substring either way,
or identical distinctive-word sets) is what the selftest's duplicate sweep
holds the built vocabulary to, so it must never fire on two genuinely
different places; the FUZZY tier adds singular/plural, a one-letter slip in a
long word, and containment ("Management" inside "Operations Management") —
right for a waveable suggestion, and exactly what a build-failing assertion
must not use. The selftest's `samePair` reads the module, so the guard at the
door and the audit behind it cannot disagree.

**The Type of institution follows the chosen names.** `typeGuess()` in
`oa-schools.js` is the browser twin of the pipeline's `typeFromNames`
(`jobmarket-sheet.mjs`) — the selftest pins the two against each other over
one fixture list — and the cascade (which now takes the `f-type` select as an
optional fourth field) fills it the moment the names state the answer: "Lee
Business School" is a Business School, "Clarkson University" a University,
INSEAD states neither and fills nothing. Only ever an EMPTY select or its own
earlier guess (`data-oa-auto-type`); a value the poster picked is never
overruled, exactly like the three names.

**A name the site publishes WRONGLY can be corrected by the people who know
— and nothing renames itself.** `oa-schools.js`'s alias tables fix a wrong
spelling permanently, but only the maintainer can edit code. A signed-in
poster can now press **"Suggest a correction"** on `post-a-job.html`
(`assets/oa-namefix.js` → Firestore `nameFixes`, `status` pinned to
`'pending'` by the rules; `from` must be a name the vocabulary actually
offers, because a correction renames something that exists — a NEW place is
simply typed into the posting). The maintainer decides on `admin-area.html`
(a fifth queue, counted in the "Admin area N" badge; the card shows what the
target will PUBLISH as, and the correction itself can be corrected before
approving). The jobs build then reads the APPROVED ones, writes them into the
served **`data/name-fixes.json`** (names only — nothing under `data/` may
carry an e-mail) and applies them through `fixPlace()`:

* **an overlay AFTER canon, never a second canon.** `normalizeFixes()` puts
  every TARGET through `canon*()` first, so a fixed row is still canonical
  under the built-in rules and the "every posting names its place the one
  way" guard stays green without the selftest knowing a fix exists;
* applied at every point the build touches a row: fresh submissions
  (`rowFromSubmission`), carried orphans (`healPlace`), the tracking sheet's
  rows at publish time (their **ids are put back** — a sheet id is
  jobId-shaped and it is the join key to the workbook, the review queue, the
  mirror and the Edit button), and the vocabulary (`buildVocab`), so the
  pickers stop offering the old spelling on the next build;
* the browser loads the same file and applies the same two functions
  (`oa-place-picker.js`, and `collect()` in `oa-jobform.js`), so the poster's
  preview and the published posting cannot disagree;
* **an unreachable queue changes nothing**: the committed file stands, in
  both directions — no fix nobody approved, and no regression of a fix
  already in force;
* the FROZEN ARCHIVES are deliberately not touched — `rowOverrides` and
  `--heal-names` remain their repair paths — and a fix that keeps earning its
  keep is **promoted into the alias tables**, which reach everything.

`DOC_KEYS`/`ADMIN_EDIT_KEYS` in `oa-namefix.js` are pinned against the rules'
`hasOnly()` lists both ways, and against what the form and the panel actually
write, read from the source (`testNameFixes` in `selftest.mjs`). **Inert until
the rules are redeployed**: `firebase deploy --only firestore:rules --project
operations-academia`.

**Three names already in three columns go through `canonColumns()`, never
`canonPlace()`.** `canonPlace` takes apart a value that names more than one
thing — right for the archive's single column, and a guess anywhere else. Over
the posting form's three boxes it read "University of California, Los Angeles
(UCLA)" as a university and a department, publishing under "University of
California" (Berkeley, one word shorter, was left alone); over the Universities
directory's columns it made departments called "Camden, Operations Management"
out of Rutgers' campus and "Computing and Applied Sciences, Industrial
Engineering" out of half of Clemson's college. `canonColumns` keeps the
CURATED fused pairs — a name somebody wrote down as naming both really does —
and drops the separator guesswork, which across every name in the data fires
three times and is wrong twice.

**The site's own links follow the name.** Every posting carries a "Further
info" link into the Universities page, built from its institution
(`jobs-model.universitiesLink`). Canonicalising a name left six of them asking
for the spelling the posting was made under, four landing on nothing — so a
STORED link that is one of ours is regenerated (`ownUniversitiesLink`), while a
link the poster actually gave is never touched. `jobmarket-sheet.mjs` builds it
from the canonical name for the same reason.

**A rename can move a name a saved e-mail alert watches for.** An alert holds
free text, not a name, so nothing can canonicalise it the way `canonCountry`
does. Instead the site's own text search (`assets/oa-list.js`) and the alert
matcher (`assets/oa-alert-match.js`) — and the Universities map
(`assets/oa-uni-map.js`), where those links land — fold punctuation, read "&"
as "and", try
the needle's own canonical form ("SCM" → "Supply Chain Management") and match an
ALL-CAPS needle against the initials of the words in the field ("IEOR" finds
"Industrial Engineering and Operations Research", whose acronym the canon
dropped). THE SAME RULES IN BOTH FILES, pinned by the selftest: an alert that
matched what the site shows must go on matching it, and "what I see on the site"
and "what I am e-mailed" cannot mean different things.

## The posting form pre-fills from the site's records — and keeps them honest

Beside the cascade, `post-a-job.html` mounts **`assets/oa-uniinfo.js`** (owner,
2026-08-24: "when a user enters e.g. INSEAD, the rest fields should be
immediately filled matching what we have in the database"): a dual-mode module
that reads `data/directory.json` — the SAME table universities.html displays,
WITH the community's `directoryEdits` overlaid at read time, so a correction
made there (or through this very form) is the record the next poster is
offered — and fills, per typed name, everything the records answer
DEFINITELY: the university's one school, the one department in scope, a
unanimous type, a single-campus country, and — once the three names identify a
directory row — its `deptUrl` and its `characteristics` checklist (research
seminars, PhD programme, …), which the directory rows now carry from each
place's NEWEST posting (latest wins whole, so unticking a box is how a school
that stopped a programme says so). **Only a definite answer is ever filled**:
INSEAD lists two departments so the department stays empty, and its campuses
sit in three countries so the country does too — the directory model publishes
a multi-campus row's campus countries as a `countries` LIST with NO single
`country` (the `campusCountries` discipline; a posting-vote majority must
never dress that ambiguity up as an answer), and the cards list every one, so
a reader filtering the directory by Singapore finds INSEAD. Every fill lands
in an EMPTY field or over this module's own earlier fill (`data-oa-auto-*`,
the maybeFillType discipline), a fill the poster then CLEARS is a decision and
never refilled, and in EDIT mode the name fields are left entirely alone — a
posting whose owner left the school off must not gain one because the form was
opened.

**The write-back is one bounded thing.** The form's "The department's own
page" field (`f-deptUrl`) pre-fills from the record with a note asking the
poster to VERIFY it; it is never part of the submission document (the
jobSubmissions rules pin that field set — the selftest checks no `out.deptUrl`
ever appears), and after the posting is accepted a CHANGED link is filed as a
`directoryEdits/{rowId}` MERGE (deptUrl + attribution only, so a document
holding somebody's other corrections keeps them; an empty field never erases;
a hidden row is never written). Every OTHER pre-filled field travels with the
posting itself and reaches the directory through the ordinary pipeline — the
build re-reads the published rows. The row id is
**`OASchools.directoryRowKey`, the ONE definition** — directory-model.mjs
re-exports it — so the browser and the build cannot disagree about where a
correction files, including for a place posting here for the first time,
whose row the very build that publishes the posting creates. Pure halves
(`facts`, `overlay`, `deptUrlPatch`) and the rules/field parities are pinned
by `testUniInfo` in selftest.mjs; who actually SEES the fills — INSEAD's
school and type in, its department and country left, the overlaid link, the
filed correction — is measured in page-test.mjs.

## The account menu counts what it links to

"My postings" and "E-mail alerts" read the same whether you had none or a
dozen, so each carries its number now — the shape `/lit/`'s account menu uses.

A menu is on EVERY page of a static site, so a read per page per visitor is a
real cost. Three rules keep it cheap, and `testAccountCounts` pins all three:

* **Paint from the cache first.** The count is remembered per account in
  `localStorage` beside the name hint, so the badge lands with the menu.
* **Refresh once per SESSION, not per page** (`sessionStorage`), using a
  `count()` aggregate — one read whatever the collection holds.
* **An exact count is free where the data is already loaded.** `oa-myjobs.js`
  and `oa-alerts.js` call `OAAccounts.setCount()` from the list they just
  fetched, which costs nothing and is what keeps the badge honest the moment a
  posting is taken down.

**A count we do not KNOW shows nothing** — no badge is honest, a `0` is not —
and zero shows nothing either, since an empty pill beside "My postings" reads
as a fault rather than as "none yet". The cache is keyed to its own uid, a read
that lands after a sign-out is dropped, and signing out forgets it: a shared
machine must not show the next person the last one's numbers.

## A same-day collapse is keyed on the ADVERTISEMENT, not just the day

`collapseSameDay` folds repeat submissions of one posting together — same
market year, institution, department and date, keeping the fullest. That key
assumes a department advertises at most one post a day, and Houston's Bauer
College disproves it: two rows on 2025-09-23, one for Assistant/Associate/Full
"until filled" and one for Assistant only closing 15 October, each with its own
ad link.

They had survived only BY ACCIDENT — one of them omitted its school, so the two
`department` lines differed. The moment canonicalisation put both under the
same department, the collapse silently dropped a real advertisement, exactly
the failure `normKey`'s own comment records from a truncated key.

So a row joins an existing slot only when it does not CONTRADICT it about which
advertisement it is (`adKey`/`sameAdvertisement`). A missing link contradicts
nothing, which keeps the repeat-submission case the function exists for; and a
row pointing only at our own home page — what a sheet row carries when it names
no ad — names nothing. **Anything that makes two postings' names agree can turn
them into one, so a naming change is also a check on the row count.**

## The header paints its FINAL form on the first frame

Owner, 2026-08-18: reloading any page "blinks for a moment and shakes my user
name picture to the green default and then loads my current correct picture."
Both halves were measured in a real browser before anything was changed, with
the Firebase SDK stubbed SLOW rather than dead (a refused request collapses the
very window the bug lives in):

* `#oa-account` was **empty and 0px wide for ~130ms** — oa-accounts.js cannot
  run until the page has parsed — and when the chip landed the row re-flowed
  around it: the nav moved 62px, the theme toggle 185px. That is the shake.
* the chip then painted the **initials disc at 134ms and the photograph at
  796ms**, because the localStorage hint (`oaAuthHint`) carried the name but not
  the picture, so the photo could not arrive until Firestore answered.

The fix is the same idea the theme flash was already solved with — decide it
before the first paint, from what the last visit remembered:

1. **the hint carries the photo** (a profile photo is a 192×192 JPEG data URL,
   ~10–25 KB, capped at 96 KB) **and the chip's measured width**;
2. `profilePhoto()` may fall back to it **only while the profile has not
   loaded**, and only for the same uid — a loaded profile with no photo is an
   account with no photo, and falling through there would resurrect a picture
   the user had just removed, while a uid check is what stops the merge dialog
   wearing this account's face on another account's row;
3. **the inline snippet in every page's `<head>`** — the theme one, extended —
   stamps `data-oa-auth` on `<html>` and hands the stylesheet `--oa-chip-w`, so
   `v3.css` holds the chip's space open **before the browser draws anything**;
4. the width is re-measured **after `document.fonts.ready`**, because the name
   is set in Inter and a chip measured in the fallback face is the wrong width;
   and only where the name is SHOWN (≥901px — the narrow header's chip is an
   avatar and its padding, and storing that would under-reserve the wide one).

`page-test.mjs` drives it: it samples the header every animation frame through
a whole load and fails if the nav or the toggle moves, or if any painted state
is anything but the photograph. **Anything new in the header must keep both
properties** — a control that appears late must have its space reserved from
the head, and anything painted from a remembered value must be painted in its
final form or not at all.

## What the page does before the reader sees anything

The site is static and every page is served whole, so "fast" here is entirely
about what the browser is made to do BEFORE it can paint, and what it is made
to wait for afterwards. Measured on the home page in a real browser
(`_scraper/page-test.mjs` drives the same paths), the rules that came out of it:

* **Nothing on screen waits for Firebase.** The SDK is ~700 KB of third-party
  JavaScript; it used to be `rel=preload`ed in every `<head>`, competing with
  the page's own stylesheet at exactly the moment the first paint is assembled.
  The account chip is painted from the hint, so nothing needs it early. The
  `preconnect` stays — it warms the connection at no bandwidth cost.
* **One request per file per page.** `OAList.load(url)` memoizes by URL and is
  how anything reads a served dataset. The home page was fetching
  `data/jobs.json` twice (117 KB each) because the launcher card's selects and
  the ten-most-recent list each fetched it for themselves, and `placements.json`
  the same way. A failed read is not remembered, so one flaky request is not
  inherited by every list on the page.
* **The scripts are `defer`red.** They were plain classic scripts, so they
  serialised in front of DOMContentLoaded — and therefore in front of every
  list mount, every reveal and the account paint. The trailing inline block on
  the pages that have one is wrapped in a DOMContentLoaded handler in the same
  breath, because a deferred external runs BEFORE an inline script that reads
  what it defines. **Adding a script tag means adding `defer` to it**, and
  putting anything inline that reads `OAList`/`V3`/`OAAccounts` means waiting
  for that event.
* **Content is not held hostage to the whole script chain.** `.v3-reveal`
  blocks are hidden by the stylesheet until v3.js claims them, and that claim
  (`wireReveals`) happens at PARSE time — its first call, before anything that
  could throw — not in `boot()` on DOMContentLoaded behind seven other files.
  The hidden-by-default state is deliberate: a class added by a script at the
  end of the body arrives after the browser has painted, so opting IN to the
  animation would show the page and then hide it again.
* **A figure already at its target is not animated from zero.** The hero's
  counters read their own text; `now === target` used to fall through to 0, so
  the first paint said "0+ universities".

## The phone header carries the site's NAME

The wordmark used to be hidden below 640px (`.v3-header .v3-logo span + span {
display: none }`) because at full size it pushes the burger off a 390px screen.
Hiding the site's name on the devices most people arrive on is the wrong half
of that trade (owner, 2026-08-18), so the lockup is **scaled** instead: smaller
mark, smaller words, tighter gaps, `min-width: 0` so the logo is what gives when
the row is short. `page-test.mjs` measures 320/360/390/430 and fails if the
words are missing, if they run into the menu button, if the burger stops being
the topmost element at its own centre, or if the page scrolls sideways.

## Anything that paints its own ground must name its own ink

Three reports in one morning (2026-08-18) were all the same fault: the
vocabulary dropdown drew near-white names on a white card, the "Your changes
have been saved" panel showed a heading and then two invisible lines, and the
"Choose a file…" button was white on white. Each was a rule that set a
`background` and left `color` to be inherited — fine when it was written,
because there was only one theme, and wrong the moment `[data-theme='dark']`
put a near-white `--ink` on the page around it.

`assets/oa-ui.css` predated the palette and hardcoded ~130 light values.
They are now theme tokens, each **keeping its old value as the `var()`
fallback** — that is what lets `/v1/` and `/v2/`, which define none of them,
go on rendering exactly as they did. Only the semantic panels keep fixed
colours (success green, warning amber, the status pills), and those name a
colour for everything inside them.

Two things this turned up beyond the reports:

* **`--mut` missed AA on every surface it is used on** — 4.03:1 on `--bg-3`,
  4.29:1 on `--bg` — so the footer, the result counts and every hint on the
  site were a hair under readable. It is `#646c78` now, the smallest change
  that clears 4.5:1 everywhere.
* **The map's vendored Leaflet chrome**: the attribution box kept a near-white
  ground in dark theme under our flipped link colour (1.56:1), and the cluster
  badge wrote white on its own pale circles (1.36–2.24:1, in BOTH themes).
  Leaflet's stylesheets stay verbatim copies, so both corrections live in
  `oa-ui.css`, specific enough to win despite loading first.

Two traps this hit, both worth knowing before adding a rule:

* **Specificity AND load order.** The Leaflet attribution override sat in
  `oa-ui.css` at the same specificity as Leaflet's own rule
  (`.leaflet-container .leaflet-control-attribution`), and `leaflet.css` loads
  AFTER it — so the fix silently did nothing and the guard went on reporting
  1.6:1. Map chrome belongs in `assets/oa-uni-map.css`, which loads after all
  three Leaflet stylesheets.
* **`--on-brand`, not `#fff`, on anything filled with `var(--brand)`.** The
  checkbox tick and radio dot were fixed white on a brand-filled box, and
  `--brand` is LIGHT in dark theme — a white tick on a near-white box.
* **One rule naming input, select and textarea can still reach only two of
  them.** `.oa-rv-field` (the review card) set 13px on all three, but
  `.oa-form input[type='text']` — a class, an ATTRIBUTE and a type — outranks
  `.oa-rv-field input`, which has a class and a type. So every typed box on the
  card took the site's form styling at 15px while the select and the textarea
  sat at 13px beside them, measured at 40px against 34px tall; the owner saw it
  and asked why the fonts were smaller. The card sets no size or padding at all
  now — `.oa-form` styles all three, exactly as it styles the posting form the
  maintainer is correcting a posting to match — because the fix for an override
  that can only reach part of what it names is usually to DELETE it, not to
  out-specify it. **Writing a font-size or a padding for a form control means
  measuring all three kinds**, which `page-test.mjs` now does on that card.
* **`background` is a shorthand and blanks a background-IMAGE.** The same rule
  painted the card's controls with `background:`, which wipes the chevron
  `.oa-form select` draws (the browser's own is off under `appearance: none`).
  It is `background-color` there now. Worth knowing: `body.v3 .oa-form select`
  in v3.css does the same thing at a higher specificity, so **no select on the
  v3 site draws that chevron** — a pre-existing, site-wide condition, and
  restoring it needs a theme-aware arrow (the vendored SVG is a fixed `#555`,
  which would be near-invisible on dark).

**`page-test.mjs` measures it, and measuring is the point.** It walks one page
per kind of chrome in BOTH themes and reads what the browser actually paints,
compositing backgrounds rather than taking the first painted layer — a pill on
`rgba(198, 204, 212, 0.13)` is not light, it is 13% light over near-black, and
reading that layer alone reports a perfectly readable button at 1:1. Nothing is
exempt. **When you add a rule that paints a background, give it a colour in the
same change.**

**And it waits for the theme to be PAINTED, not for a stopwatch.** Every page
links a Google Fonts stylesheet that cannot load in CI, and until the cascade
settles the body shows a default grey that is neither theme; measured then,
every muted line reads as a dark-theme failure. A fixed delay reported 14 of
them, all artefacts, with the numbers moving between runs — which is what a
transient looks like. Waiting for `body.v3` does not help either: that class is
in the HTML. The wait asserts the thing itself — the body is painting the
theme's own `--bg` — and nothing downstream may be measured before it does.

## A link nobody can preview is a link nobody clicks

Somebody pasted this site's address into WhatsApp beside `stouras.com/lit`. The
other one drew a card — picture, title, a sentence. This one drew the hostname
twice and nothing else. Both are static sites on GitHub Pages and both had a
complete Open Graph block in the home page's `<head>`, which is why it had gone
unnoticed for months: **a preview that fails reports nothing to anybody.**

Two defects, and the second is the interesting one.

**Twenty-four of the twenty-five live pages carried no preview metadata at
all** — including `jobs.html`, the page people actually send each other. That
was a REGRESSION: before the rebuild, sixteen sub-pages carried `og:*` tags.
They were defective tags, but nothing noticed them leaving.

**And sixty-eight served files that were NOT the home page declared the home
page's address.** Facebook's crawler family — which serves WhatsApp, Messenger,
Facebook, LinkedIn and Viber — keys a preview on **`og:url`, not on the address
that was pasted.** Seventeen archived pages under `/v1/`, every one of them
`noindex,nofollow`, gave `og:url` as `https://www.operationsacademia.org`; and
fifty-one old copies under a directory called `back up` gave it as
`http://operationsacademia.org`, the plain-http apex form of the same place.
Sixty-nine served files, counting the real one, for one address.

Both halves of that had a cause worth remembering:

* **A directory is served unless its name starts with an underscore.** Pages
  runs Jekyll, Jekyll publishes anything not prefixed `_`, and `back up` was
  therefore a public, un-noindexed, fully-crawlable copy of the site — while
  `link-check.mjs` skipped it under a comment calling it "a directory with
  nothing served in it". It is `_backup/` now, which is the entire fix, and the
  belief the comment expressed is true for the first time. **Do not add a
  `.nojekyll` file to this repository.** It is the one change that would undo
  this silently: it turns Jekyll off, and with it the underscore rule that is
  the only thing keeping `_backup/`, `_scraper/` and `_functions/` off the web.
  `share-check.mjs` would still catch the duplicate `og:url` on the next push,
  which is the point of having it — but nothing would catch the rest.
* **`archive-v2.mjs`'s rule 5 was never backported to `/v1/`.** That rule —
  "no page still CLAIMS to be the root", re-pointing an archived page's
  canonical and `og:url` at its own address — was written on promotion day for
  the archive made *that* day. The archive made two days earlier never got it.
  `archive-v1.mjs` is retired and cannot be re-run, so the rule is recorded in
  its `archivePage()` for a future revival and the committed archive was
  patched to what the rule produces. **That is not a breach of "do not edit
  `/v1/`":** the verbatim promise is about a page's CONTENT. An address is not
  content, and a copy under `/v1/` that still calls itself the root is not a
  faithful record — it is a broken one.

### What every live page carries now, and why each tag is there

One block, directly under the `<title>` and **above every stylesheet,
preconnect and script** — Slackbot reads the first 32 KB of a document and
WhatsApp's parser gives up sooner, so a fat head above the tags is a documented
way to lose a card. Every word of it is DEFINED in the `PAGES` table in
`_scraper/share-check.mjs` and the check fails any page that disagrees with
it — so the table is the single source of truth by ENFORCEMENT rather than
by generation: nothing writes the pages from it, and a page edited by hand
goes red until the table agrees.

* `og:*` is read by Facebook, Messenger, WhatsApp, LinkedIn, Telegram, Slack,
  Discord, Signal, Viber and iMessage. It is RDFa: **`property=`, never
  `name=`** — backwards, it is invisible and nothing warns.
* `twitter:card` is the one preview tag with **no Open Graph equivalent**, so
  `og:*` alone can never yield X's large card. `twitter:*` is `name=`.
* `og:image:width` / `height` decide whether the **first** person to share a
  link sees the big card: Meta lays the card out from the declared numbers
  before it has finished downloading the file. They must match the file's real
  pixels, which is why `share-check.mjs` reads the JPEG's own SOFn header
  rather than trusting the tag.
* **Exactly one `og:image`.** Several are legal Open Graph and WhatsApp
  handles them badly.
* Under 300 KB, absolute `https`, no redirect, a file this repository actually
  has. WhatsApp silently drops a heavier thumbnail and the card degrades to
  plain text.
* `<meta name="description">` as well as `og:description`, because WeChat and
  Google read that one and not the Open Graph one.
* `og:locale` is **`en_GB`**, not `en_IE`. Facebook honours only the locales on
  its own published list and `en_IE` is not one of them — an unsupported value
  is ignored rather than rejected, so it fails silently, which is this whole
  section's theme. `stouras.com` uses the same value.
* `<link rel="image_src">` + the `itemprop` trio hand the **square** thumbnail
  to the clients that centre-crop to 1:1 (QQ in practice, WeChat's desktop
  client and WeCom possibly). See `_scraper/make-share-images.mjs`: one asset
  cannot serve both shapes, because a 1200×630 card centre-cropped to a square
  keeps the middle of the logo and none of the tagline.

**The six section stubs deliberately carry NOTHING** — so "every page previews" means every page a reader would send, not literally every file.

**The six section stubs deliberately carry NOTHING.** `candidates.html`,
`placements.html`, `faqs.html`, `contact.html`,
`directors-and-contributors.html` and `resources-for-candidates.html` are
`noindex` meta-refreshes whose canonical is a *fragment* of the home page. Any
`og:url` they carried would resolve to the home page's Open Graph identity —
the sixty-eight-claimants defect, recreated six times over. `card: false` in
`PAGES`, each with its reason. That is the shape `stouras.com`'s redirect
stubs have, and the reason its cards never broke.

**Two things went with it.** `/v2/` had the same defect one layer down: sixteen
of its pages gave `og:image` as `/images/OA_logo_1200x294.png` — a PATH, which
Open Graph does not accept and a crawler therefore ignores — and one gave
`OA_logo_1200x294`, with no directory and no extension, inherited from the 2014
site. That is now rule 3b of `archive-v2.mjs`, which is not retired and was
simply re-run. And **`sitemap.xml` listed every page extensionless** while its
canonical and `og:url` named the `.html` form; Pages serves both, so nothing
404'd — it was just two addresses for one page, which is the same split as the
main defect wearing different clothes. The sitemap now names what the pages
name, and `share-check.mjs` fails if the two part company again.

**robots.txt now names the preview crawlers explicitly.** They were already
allowed by the wildcard; the Sharing Debugger has a bug — 2014, and back in
2024 — where it answers 403 and blames `robots.txt` on a site whose only rule
is a permissive wildcard. Naming them removes that failure mode for nothing.

### What the check cannot see, and what to do about it

`share-check.mjs` proves the tags are right. It cannot prove a crawler can
REACH the page, and three things that produce **exactly** this symptom live
outside the repository:

1. **the Pages edge answering `facebookexternalhit` with a 403** — a
   documented, recurring, per-host GitHub Pages failure, which is precisely the
   shape of "one Pages site works and another does not";
2. **a Meta-side domain flag** — a job-board-shaped domain that mails postings
   is exactly the profile their integrity systems over-trigger on;
3. **a cached FAILED scrape** — Facebook keys the object on `og:url` and holds
   it until something re-scrapes; a URL nobody reshares can hold a failure
   indefinitely, and WhatsApp then pins it per device for days.

**All three are answered by one paste** into
<https://developers.facebook.com/tools/debug/>: read **Response Code** and
**Time Scraped**, then press *Scrape Again* two or three times. Do that after
any change here, and do it before concluding that a fix did not work — testing
on a handset that has already cached the old card proves nothing.

### WeChat, honestly

Mobile WeChat **does not unfurl a pasted link at all**, whatever the `<head>`
says. Tencent withdrew that in April 2017 for any page without a signed JS-SDK
integration, which needs a WeChat-verified Official Account and an ICP-filed
domain — neither available to a GitHub Pages site on a `.org` hosted outside
China. What DOES read these tags: the **desktop** WeChat client, **WeCom**, and
"share to WeChat" from a mobile browser. Those are what the square thumbnail
and the `<title>` are for — WeChat's fallback leans on `<title>` and drops
`og:description` even where it crawls, which is why every page's `<title>` was
made to stand on its own. There is no WeChat sharing debugger and no cache
purge; the only reliable way to force a re-read is to change the URL
(`?v=2`). Worth knowing separately: for readers **inside** mainland China,
GitHub Pages is unreliable and the Google Fonts these pages load are blocked,
so a card is not the binding constraint there.

## Deploying Firebase rules — ALWAYS name the project

    firebase deploy --only firestore:rules --project operations-academia

The Firebase CLI resolves its target from, in order: `--project`, the
`FIREBASE_PROJECT` env var, **the "active project" it remembers PER DIRECTORY
in its own global config**, and only then the default alias in `.firebaserc`.
The remembered one wins over `.firebaserc`, is invisible in the repository, and
survives between sessions.

**That is not hypothetical here.** `firebase deploy --only firestore:rules` run
in this folder published THIS repository's rules into the `stouras-answerarena`
database and printed "Deploy complete!". These rules end in a deny-all
catch-all and name none of that app's collections, so every read and write in
it was refused until its own rules were re-published. Nothing warned, at either
end. (The sibling `konstantinosStouras.github.io` holds six more Firebase
projects; the same thing had already happened once from `lab/search-v2`.)

So `check-project.mjs` runs as a **`predeploy` hook on every deployable section
of `firebase.json`** — `firestore`, `storage` and `functions`, because
`firebase deploy` with no `--only` runs all three. The CLI exports
`GCLOUD_PROJECT` to a predeploy hook, so the target is knowable before anything
is uploaded; a mismatch exits non-zero, which aborts the deploy. Run it
standalone to see where this folder would deploy: `node check-project.mjs`.

It reads the expected project from `.firebaserc`, never a literal, so there is
one place for that truth. `selftest.mjs` fails if a deployable section is left
un-hooked or if the guard starts hardcoding an id — and the guard is the net,
not the practice: **pass `--project` yourself.**

### …and the FIRESTORE rules publish themselves

"Nothing in CI deploys rules — it needs an interactive login" is what this file
said for months, and it was **half true and expensive**. `firebase deploy` does
need a login. Releasing a ruleset does not: the Admin SDK's Security Rules API
(`securityRules().releaseFirestoreRulesetFromSource`) publishes with a SERVICE
ACCOUNT, and `FIREBASE_SERVICE_ACCOUNT` has been a secret here all along —
eight workflows use it.

The cost of the belief was six features shipped INERT behind rules that were
committed and never published: the review queue, the news gate, the name fixes,
the directory edits, and the roster and messaging threads. That last one is how
it surfaced (owner, 2026-08-24) — an Admin-area panel whose code, page and rules
were all in the repository, listing nobody, under a red line telling the
maintainer to go and run a command. **A feature that needs a manual step to
become real looks installed and is not**, which is the failure shape this
repository names everywhere else.

    _scraper/deploy-rules.mjs                 publish _firestore.rules (pure guards + the release)
    .github/workflows/oa-deploy-rules.yml     after every green check on master, or one button

Four properties, and each is load-bearing:

* **It cannot reach another project.** The credential names its own project and
  the script refuses unless that equals `.firebaserc`'s default — this folder's
  rules have twice been published into `stouras-answerarena`, so the CLI guard's
  rule is applied to this road too, by `projectMismatch`.
* **It cannot publish the wrong FILE.** `sourceProblem` refuses an empty or
  truncated read, anything without `rules_version`, and — by name —
  `_storage.rules`, which declares a different service and sits one argument
  away.
* **It runs behind the checks, never on a raw push.** `workflow_run` on
  "OA — checks" succeeding on master: the offline guards are what pin the rules
  against the modules that write those collections, and publishing is the one
  action here the next run cannot undo. Same discipline as "a red selftest stops
  publishing", applied to the rules.
* **It is cheap to fire.** The live ruleset is read first and an identical one is
  a no-op, so a push that touched no rules mints nothing.

**Storage rules and the Functions still go through the CLI**, deliberately —
doubling what a bad run can reach, for a file that changes once a year, is not a
trade worth making. The one thing that can still stop a run is IAM: if the key
cannot release rulesets the script says so and names the role
(`roles/firebaserules.admin`) rather than failing obscurely.

So the rule for this repository is now: **change `_firestore.rules`, let the
checks pass, and it is live.** Both panels that report a permission-denied name
the workflow rather than a terminal.

## Tests that must stay green

    node _scraper/selftest.mjs      # offline model/pipeline checks
    node _scraper/share-check.mjs   # every page previews properly when shared:
                                    # the whole block present, og:url agreeing
                                    # with the canonical, exactly one og:image
                                    # whose declared size matches the file's
                                    # real pixels, and NO TWO SERVED FILES
                                    # claiming one og:url
    node _scraper/higheredjobs-verify.mjs --selftest   # its own round trip
    node _scraper/jobreview-mailer.mjs --selftest      # the review-queue e-mail
    node _scraper/selftest.mjs --publishing   # the same, in a data writer's
                                    # role: a duplicate NAME is reported rather
                                    # than stopping the site publishing
    node _scraper/country-audit.mjs # every posting names the country its
                                    # university is in, against the addresses
                                    # in the site's own Universities directory
                                    # (--all lists the ones it cannot place)
    node _scraper/link-check.mjs    # every internal link resolves, and no
                                    # version of the site reaches into another
    node _scraper/archive-v2.mjs --check   # /v2/ still holds the archive rules
    node _scraper/page-test.mjs     # Playwright browser checks, incl. the
                                    # 390px mobile gate over every list page,
                                    # the picker's alphabetical order and its
                                    # measured contrast in BOTH themes
                                    # (PW_CHROMIUM=<path> pins the browser)

All five run in CI on every push (`.github/workflows/oa-checks.yml`); the jobs
build also runs the selftest AFTER writing `data/` and refuses to commit on
a failure, so a red selftest silently stops publishing — fix it promptly.

`page-test.mjs` skips itself with a friendly message when Playwright is not
installed, which is right on a laptop and wrong in CI — there it exits 1
instead (`process.env.CI`), because the workflow installs the browser two
steps earlier and the only thing a skip could mean is that the install broke.
A guard that reports green while running none of its checks is worse than no
guard. For the same reason the CI step does not use `playwright install
--with-deps`: that runs `apt-get` on every run whether or not the browser is
cached, and on 2026-08-18 a failing-over Ubuntu mirror hung it until the job
cap killed three runs of the same commit. The libraries ship with the runner
image; the apt call is kept bounded and best-effort, and the browser launch is
what proves it.

`page-test.mjs` drives BOTH served designs: the checks that assert on the old
chrome (`#nav`, `#header-wrapper`, `#titleBar`, `#navPanel`, `window.ga`,
jQuery) run against `V2 + 'page.html'`, and the rest against the root.
