# Mobile standards for tables and card lists

Every data table on this site — job postings, candidates, confirmed
placements, past job markets, and whatever comes next — must work with a
thumb on a small phone. These are the standards, set 2026-08-16 after the
jobs list shipped unusable on a 390px screen (filters edge-to-edge, 14px
inputs iOS zoomed into, mouse-sized targets).

**Consult this file before building any new table or list page. When a new
rule is needed, add it here in the same change that first applies it.**

## Rule 0 — build on the shared engine, and the rest is inherited

A new list page mounts `OAList` (`assets/oa-list.js`) and links
`assets/oa-list.css`. Every rule below is already implemented there ONCE, so
a page that uses the engine is mobile-correct by construction — candidates
and placements were verified to inherit the whole treatment with zero
page-specific CSS. Do not hand-roll a table, and do not copy the engine's
styles into a page; a second implementation is where the rules drift.

Page-specific chrome (action buttons, status chips) reuses the engine's
classes — `.oa-jobbtn`, `.oa-card-actions` — as oa-jobedit.js,
oa-candidateedit.js and the placements hook already do, so it inherits the
mobile sizing the same way.

A control a page wants in the FILTER BAR is declared through the engine's
`actions` option rather than appended to the bar (`buildBar()` empties it
whenever the filters are cleared, so an appended one would vanish at the first
press of Clear). It is drawn as `.oa-action`, which carries rules 3 and 4 on a
phone — 42px tall, full width — however small and quiet it is on a desktop.
The jobs page's Excel download is the first of them.

## The rules (each one was earned)

All apply at the phone breakpoint (`max-width: 640px` in oa-list.css) unless
marked global.

1. **A side gutter, owned by the list.** The site theme's mobile grid cancels
   its own gutter (`#content` pads 30px, `.row` pulls −30px), so anything that
   trusts the container runs edge-to-edge. `.oa-list` carries its own 14px
   horizontal padding on phones. Never "fix" this in the shared theme CSS —
   the old pages depend on the theme as it is.

2. **Inputs are 16px, minimum. Not cosmetic.** iOS Safari zooms the whole
   page into any focused input whose font-size is under 16px, and leaves it
   zoomed. Every text input, search box and picker button is ≥16px on phones.

3. **Touch targets are ≥40px tall.** Controls are 42px on phones (35px is a
   mouse target): search inputs, picker buttons, Clear, pager chevrons.
   Action pills (`.oa-jobbtn`) get `padding: 8px 14px` and full opacity —
   there is no hover on a phone to reveal or enlarge anything.

4. **Filters must not be a wall.** Value pickers sit two per row on phones;
   only the primary free-text search keeps the full width. Seven stacked
   filters cost ~900px of scrolling before the first result.

5. **Nothing ever scrolls sideways.** `document.scrollWidth` must equal the
   viewport width. Long values wrap (`overflow-wrap`) rather than widen.

6. **Dropdown menus stay on screen.** A picker menu caps at
   `calc(100vw - 28px)` and `50vh`; when opening would overflow the right
   edge (a right-column picker), oa-list.js measures and right-aligns it
   (`.oa-menu-right`). Measured after opening, never guessed from position.

7. **No keyboard over the options.** The picker's search box autofocuses only
   for fine pointers (`matchMedia('(pointer: coarse)')`); on a phone the
   keyboard would cover the very options the tap asked for.

8. **Detail rows stack.** The card's label/value table (`.oa-kv`) renders
   label above value on phones (`th`/`td` as blocks), with a hairline between
   rows — never a two-column table squeezed into 360px.

9. **Cards read as cards.** 6px corner radius on phones, the resting shadow
   kept, hover-only effects gated on `(hover: hover) and (pointer: fine)` so
   a tap does not leave a stuck hover state.

10. **A panel that opens over the page is a list too.** The posting form's
    name picker (`assets/oa-combo.js`) is not a table and not part of the
    shared engine, but it opens exactly the kind of panel rule 6 is about, so
    it holds the same three rules on a phone: `50vh` and
    `calc(100vw - 28px)`, 42px rows, and long names wrapping rather than
    widening the page. It shipped as a 300px panel of 33px rows precisely
    because a form is not a list page and nothing measured it —
    `page-test.mjs` now opens it at 390px and measures all three.

    A height cap is only half of rule 6: the panel hangs under its field, and
    on a phone a field is halfway down the screen, so 422px of list ran 61px
    past the fold and a field near the bottom put the whole thing out of
    sight. It now **measures after opening** and takes whichever side has more
    room, growing no further than that side allows.

## The test gate

`_scraper/page-test.mjs` runs every list page at a 390px viewport and
asserts: no sideways scroll, the gutter, the 16px input rule, 40px+ targets,
and every picker menu on screen. **A new list page must be added to the
`MOBILE_PAGES` list there in the same change that creates the page** — the
suite is what caught this very feature's first draft dropping the menu's
Escape-close wiring, so the gate is not a formality.

`MOBILE_PAGES` covers **both designs the site serves**: the live one at the
root (where the candidates and placements lists are sections of `index.html`
rather than pages of their own) and the 2026 design archived at `/v2/`, whose
pages are still served and still have to hold the standard on a phone. A page
added to one is not automatically in the other — list it where it exists.

Run locally:

    node _scraper/selftest.mjs
    node _scraper/page-test.mjs        (needs Playwright; PW_CHROMIUM=<path> to pin the browser)

## Non-list pages: the Universities map view

There are no Awesome Table embeds left (2026-08-16: `previous-markets.html`
and `recent-faculty.html` were rebuilt on OAList and joined `MOBILE_PAGES`).
**Do not add a new Awesome Table embed for any reason.**

`universities.html` serves TWO views since 2026-08-24: the card directory —
an OAList mount, so it is in `MOBILE_PAGES` like any list page — and the
Leaflet map it has carried since the vendor rebuild, behind the Cards ⇄ Map
switch. The map cannot mount OAList, so it follows these rules through its
own stylesheet (`assets/oa-uni-map.css`: the 14px phone gutter, the 16px/42px
search input) and keeps its own phone block in `page-test.mjs`, which now
switches to the map view first — a future non-list page (or view) should do
the same, and the selftest pins that the block exists.
