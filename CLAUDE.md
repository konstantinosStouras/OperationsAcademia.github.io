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
| **`/v1/`** | The 2014-2026 Awesome-Tables site. Archived verbatim, `noindex`. Do not edit: it is a historical record. |
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
morning, so a patched row comes back the next day, exactly as with the country
spellings below. Columns are matched by header alias and a header it does not
know is REPORTED in the run's log rather than guessed at; add the alias there.

A sheet that stops being updated looks exactly like a quiet job market from the
site, so it is made visible deliberately: `stalenessOf`/`shouldWarn` e-mail the
maintainer once (then weekly) when the sheet has gained nothing for three weeks,
cannot be read, or reads as empty. Nothing already published is ever removed by
one of those failures.

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
## Nothing from the tracking sheet publishes itself

A posting crawled from the job market workbook is **queued for the maintainer,
not published on sight**. It appears at the top of `feedback.html` (admin-only,
above the feedback inbox), every field editable; approving it puts it on the
site at the next build, rejecting keeps it off for good.

The reason is that the pipeline **derives** things the sheet never said — the
market year, the type of institution, the canonical country, the entry level,
and the closing date read off the HigherEdJobs advertisement. Those reached
visitors before anyone had looked at them.

    _scraper/jobreview.mjs         what is publishable, and what an edit is (pure)
    assets/oa-jobreview.js         the panel on feedback.html
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
list in `_firestore.rules` must agree — **selftest.mjs pins all three together**.
`id`, `year`, `posted` and `source` are deliberately NOT editable: they tie the
posting to its sheet row, and changing one would make the next sync queue it
again as new. Correct those in the workbook.

**It is inert until `_firestore.rules` is redeployed** (`firebase deploy --only
firestore:rules`) — until then the panel says permission-denied — and the
e-mail half is inert until `SMTP_*` is set, which stamps nothing, so the
postings are announced once it exists.

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
it. The render cap went with it (60 → 400): an alphabetical list cut at 60 ends in
the C's and tells the reader to keep typing without their being able to tell
whether their university is there at all.

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

**Nothing in CI deploys rules.** It needs an interactive login, so a rules
change committed here is not live until someone runs that command by hand.

## Tests that must stay green

    node _scraper/selftest.mjs      # offline model/pipeline checks
    node _scraper/higheredjobs-verify.mjs --selftest   # its own round trip
    node _scraper/jobreview-mailer.mjs --selftest      # the review-queue e-mail
    node _scraper/link-check.mjs    # every internal link resolves, and no
                                    # version of the site reaches into another
    node _scraper/archive-v2.mjs --check   # /v2/ still holds the archive rules
    node _scraper/page-test.mjs     # Playwright browser checks, incl. the
                                    # 390px mobile gate over every list page,
                                    # the picker's alphabetical order and its
                                    # measured contrast in BOTH themes
                                    # (PW_CHROMIUM=<path> pins the browser)

All four run in CI on every push (`.github/workflows/oa-checks.yml`); the jobs
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
