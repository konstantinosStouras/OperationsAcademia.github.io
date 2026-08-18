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
stayed on the site for ever. `removeIds` in each build (and the `{ id }` spec in
`mergeRows`/`mergeCandidateRows`/`mergePlacementRows`) is the fix, in all three
pipelines.

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

## Tests that must stay green

    node _scraper/selftest.mjs      # offline model/pipeline checks
    node _scraper/link-check.mjs    # every internal link resolves, and no
                                    # version of the site reaches into another
    node _scraper/archive-v2.mjs --check   # /v2/ still holds the archive rules
    node _scraper/page-test.mjs     # Playwright browser checks, incl. the
                                    # 390px mobile gate over every list page
                                    # (PW_CHROMIUM=<path> pins the browser)

All four run in CI on every push (`.github/workflows/oa-checks.yml`); the jobs
build also runs the selftest AFTER writing `data/` and refuses to commit on
a failure, so a red selftest silently stops publishing — fix it promptly.

`page-test.mjs` drives BOTH served designs: the checks that assert on the old
chrome (`#nav`, `#header-wrapper`, `#titleBar`, `#navPanel`, `window.ga`,
jQuery) run against `V2 + 'page.html'`, and the rest against the root.
