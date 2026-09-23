# The POMS job postings page → the review queue

The POMS Society keeps a public list of job postings at
<https://www.poms.org/opportunities>. The site now reads that page once a
day and puts every posting it has not seen before into your review queue on
`/admin-area`, beside the ones the tracking sheet contributes. This is how
it is wired, what you have to do, and what to expect.

    https://www.poms.org/opportunities
        |  .github/workflows/oa-poms-crawl.yml   (daily, 08:35 UTC, and on demand)
        |  _scraper/poms-crawl.mjs
        |    reads each new posting's own advertisement:
        |      a PDF on poms.org (most of them)   -> the PDF's text
        |      a Workday or HigherEdJobs page     -> the readers the site already has
        |      any other web page                 -> the page, and if it is a
        |                                            JavaScript shell (Interfolio),
        |                                            the page as a browser shows it
        v
    Firestore `jobReviews`  ->  the "Auto-crawled jobs" tab on /admin-area
        |  Approve
        v
    _scraper/build-jobs.mjs publishes the approved posting  ->  /jobs

Nothing here needs a credential you do not already have: the page and the
advertisements are public, and the queue is behind the same
`FIREBASE_SERVICE_ACCOUNT` every other job uses.

## What you have to do

Nothing, once it is merged. The workflow runs every morning. The first run
queues the postings of the last 30 days that the site does not already
know; after that only what is new since the previous run.

If you want more of the page's history, run the workflow by hand with the
`since` input set to a day (for example `2026-07-01`). Rows already on the
site, already in the queue, or already in the tracking sheet are never
queued twice: a posting is known by its advertisement link.

## What each card carries, and what it will not

The crawler fills in as much of the posting form as the advertisement lets
it, and leaves the rest for you:

| Field | Where it comes from |
| --- | --- |
| University | The page's University column, matched to the site's own spelling. "University of Oklahoma (OU)" becomes "University of Oklahoma". |
| School, Department | The advertisement: an Interfolio page's "University: College: Division" line, a "Department of X" or "X School of Business" in the text, or the field the title names ("Assistant Professor **of Supply Chain Management**"). Then the site's own directory fills the school a known department sits in. |
| Type of institution | From the names, the same rule as the tracking sheet. |
| Position type | From the title, the same rule as the tracking sheet. "Professional Track Faculty" reads as non-tenure-track. |
| Closing date, suggested apply-by | From the advertisement's own words ("Application deadline: October 15, 2026", "Review of applications will begin on…"). A date the crawler cannot read with confidence is not invented: the posting says "Until filled." and the advertisement's own sentence is kept in the comments. |
| Country | From a location the advertisement states ("Norman, OK"), else from the site's Universities directory. |
| Comments | The advertised title, the deadline as worded when no date could be read, the first sentences of the description, and a note saying it was read by the crawler and when. |
| Link to the advert | The View Posting link. Posted at: the POMS page. |

What it cannot fill: the contact person (the chair or coordinator) and their
address, the school's characteristics, and anything the advertisement does
not say. The card says when the advertisement could not be read at all, and
tries again a week later.

Each card says where it came from ("from the POMS job postings page") and
warns when the posting looks like one the site already lists or one already
under review from the tracking sheet. The two crawlers see the same
advertisements days apart, so expect that warning often; Reject keeps the
copy off.

## The Interfolio question

The Interfolio page you looked at (`apply.interfolio.com/193265`) is an
Angular application: the HTML the server sends carries the title "Apply -
Interfolio", the scripts, and nothing about the position. That is why every
Interfolio advertisement the site had read before (42 of them) is recorded
as unreadable. The position is fetched by the page's own scripts after it
loads, from Interfolio's internal API.

There is no public API for it. Interfolio's documented "Faculty Search"
API is for institutions and needs an institution's own credentials, so it
cannot list other universities' positions. What can be done, and what the
crawler does, is read the page the way a person does: it opens it in a
headless browser on the runner, waits for it to draw, and reads the text
that appears. From that text it takes the title, the "University: College:
Division" line, the location, the open date, the description, and the
closing and review dates written in it. The same fallback serves any other
job board that is a JavaScript shell.

If the browser cannot be installed on a run, the posting still queues with
what the POMS table said (title, university, date, link) and its comments
say the advertisement could not be read; the next run tries again.

## PDFs

A PDF's text is read with pdf.js, the engine Firefox uses. A scanned PDF
with no text layer cannot be read, and neither can a Word file (one row on
the page links one); those postings queue with the table's data and a note.

## Running it by hand

From *Actions → OA jobs — crawl the POMS job postings page → Run workflow*:

| Input | What it does |
| --- | --- |
| `scan` | lists the new postings and stops. Reads no advertisement. |
| `dry_run` | reads everything, prints each document, writes nothing. |
| `since` | queue postings dated on or after this day (blank = the last 30 days). |
| `limit` | read at most this many advertisements in one run (blank = 40). |
| `no_render` | never start a browser. |

Locally the page and the advertisement hosts are usually blocked by a
sandbox's network policy, so a real read happens on a runner. The offline
checks run anywhere:

    node _scraper/poms-crawl.mjs --selftest
    node _scraper/selftest.mjs

## When it goes wrong

- **The run is red with "could not be read"**: the page moved, or poms.org
  refused the request. Nothing was queued; nothing already queued or
  published is touched.
- **The run is red with "no posting table was found"**: the page's layout
  changed. The table reader is `parseOpportunities` in `_scraper/poms.mjs`.
- **A card is empty apart from the title**: the advertisement could not be
  read (a scanned PDF, a Word file, a page that refuses automation). Open
  the link and complete it, or wait: an unreadable advertisement is tried
  again after a week.
- **A posting was queued that is not a job at all**: the page occasionally
  lists a contractor's vacancy. Rows from something that is not a
  university, college or school, advertising no academic post, are skipped
  and named in the log; anything else is yours to reject.

Approving a POMS posting publishes it within a couple of minutes, exactly
as a tracking-sheet approval does, and gives it the same Edit and Take-down
controls on the jobs page. It is not in the tracking sheet and never will
be: taking it down is done on the site.
