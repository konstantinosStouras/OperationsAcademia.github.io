#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Operations Academia — the pictures a link preview shows.

       node _scraper/make-share-images.mjs            # write the square
       node _scraper/make-share-images.mjs --wide     # …and redraw the card
       node _scraper/make-share-images.mjs --check    # write nothing, report

   WHY THIS EXISTS. Two images, and they are two because the platforms crop
   differently and one asset cannot serve both.

   images/og-card.jpg      1200x630   the WIDE card. Facebook, Messenger,
                                      WhatsApp, LinkedIn, Telegram, Slack and
                                      iMessage all render an og:image at
                                      roughly 1.91:1 and letterbox anything
                                      else.
   images/share-square.jpg  800x800   the SQUARE thumbnail. WeChat draws a
                                      link as a small near-square tile beside
                                      the title and CENTRE-CROPS whatever it
                                      is given: hand it the wide card and the
                                      crop keeps the middle 630x630, which on
                                      this card is the inside of the logo pill
                                      — "peration" and no tagline. It is
                                      offered through <link rel="image_src">
                                      and <meta itemprop="image">, which
                                      WeChat prefers and the wide-card
                                      platforms ignore, so each gets the one
                                      it can use.

   WHY 800x800 AND NOT 300x300. The one hard number Tencent publishes — 32 KB
   — governs the Open-SDK path, where a SENDING APP hands WeChat a thumbnail
   it has already encoded. Nothing here is on that path: these files are
   fetched from a URL, for which no ceiling is published, and the floor that
   IS repeated everywhere is 300x300 (smaller is skipped outright). 800 is
   comfortably above the floor, gives a retina tile, and still lands well
   under 100 KB — which the share-check enforces, along with the floor.

   They are GENERATED rather than hand-drawn so the wording can be corrected
   without a design tool. Rendering is Chromium via Playwright — the same
   browser _scraper/page-test.mjs already needs — with the site's own fonts
   from Google Fonts, so the card is set in the typeface the site is set in.
   Nothing here runs in CI: run it by hand, LOOK at what came out, and commit
   it.

   THE WIDE CARD IS NOT REWRITTEN WITHOUT `--wide`, and that is deliberate.
   The committed og-card.jpg is the image every link anyone has ever shared
   already resolved to; the recipe below reproduces it closely but not to the
   byte, so a routine run of this script would replace a proven asset with an
   approximation of it and invalidate every cached preview for nothing. The
   square is new and has nothing to lose, so it is the default. Pass `--wide`
   when the card's own wording changes — and then look at it.

   The declared og:image:width/height in every page's head must match the real
   pixels of the file. `node _scraper/share-check.mjs` measures that and fails
   when the two disagree, so a regenerated image at a new size cannot ship
   with the old numbers still in the pages.
   --------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const WIDE_TOO = process.argv.includes('--wide');

/* The card's own palette, sampled from the committed og-card.jpg so a
   regenerated file lands on the colours the site has been sharing under. */
const NAVY_DARK = '#0c2041';
const NAVY_MID = '#132f5c';
const NAVY_LIT = '#234582';

const LOGO = 'data:image/png;base64,' +
  readFileSync(path.join(ROOT, 'images', 'OA_logo_1200x294.png')).toString('base64');

const FONTS = 'https://fonts.googleapis.com/css2' +
  '?family=Inter:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,400..700&display=swap';

const TAGLINE = 'Matching supply with demand in the Operations job market';

/* ---------------------------------------------------------------- the pages */

function shell(w, h, body) {
  return `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="${FONTS}">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${w}px;height:${h}px;overflow:hidden}
  body{
    font-family:'Inter',system-ui,sans-serif;
    color:#fff;
    background:
      radial-gradient(120% 90% at 78% 8%, ${NAVY_LIT} 0%, rgba(35,69,130,0) 62%),
      linear-gradient(135deg, ${NAVY_DARK} 0%, ${NAVY_MID} 55%, #18396e 100%);
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    -webkit-font-smoothing:antialiased;
  }
  .pill{background:#fff;border-radius:28px;display:flex;align-items:center;justify-content:center}
  .pill img{display:block;width:100%;height:auto}
  .tag{font-weight:700;text-align:center;line-height:1.22;letter-spacing:-0.01em}
  .host{color:#c8d6ef;text-align:center;letter-spacing:0.01em}
</style>
${body}`;
}

const WIDE = shell(1200, 630, `
<style>
  .pill{width:900px;padding:34px 44px;border-radius:22px}
  .tag{font-size:52px;margin-top:64px;max-width:900px}
  .host{font-size:26px;margin-top:26px}
</style>
<div class="pill"><img src="${LOGO}" alt=""></div>
<div class="tag">${TAGLINE.replace(' in the', '<br>in the')}</div>
<div class="host">operationsacademia.org</div>
`);

/* The square carries LESS, not the same thing smaller: at the size WeChat
   draws it the wide card's three lines of tagline are unreadable, so it keeps
   the logo, one short line and the host. */
const SQUARE = shell(800, 800, `
<style>
  .pill{width:660px;padding:30px 34px}
  .tag{font-size:44px;margin-top:58px;max-width:640px}
  .host{font-size:26px;margin-top:30px}
</style>
<div class="pill"><img src="${LOGO}" alt=""></div>
<div class="tag">The Operations<br>job market, in one place</div>
<div class="host">operationsacademia.org</div>
`);

const IMAGES = [
  { file: 'images/og-card.jpg', html: WIDE, w: 1200, h: 630, quality: 88, guarded: true },
  { file: 'images/share-square.jpg', html: SQUARE, w: 800, h: 800, quality: 88 },
].filter(spec => WIDE_TOO || CHECK || !spec.guarded);

/* ------------------------------------------------------------------ the run */

async function browser() {
  const require = (await import('node:module')).createRequire(import.meta.url);
  let playwright;
  for (const id of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try { playwright = require(id); break; } catch { /* try the next */ }
  }
  if (!playwright) {
    console.log('playwright is not installed — `npm install playwright` to regenerate the share images');
    process.exit(CHECK ? 0 : 1);
  }
  const opts = {};
  if (process.env.PW_CHROMIUM) opts.executablePath = process.env.PW_CHROMIUM;
  return playwright.chromium.launch(opts);
}

const br = await browser();
let changed = 0;
for (const spec of IMAGES) {
  const page = await br.newPage({ viewport: { width: spec.w, height: spec.h }, deviceScaleFactor: 1 });
  /* The cards are set in the site's own Google Fonts, so `networkidle`
     never arrives on a machine that cannot reach fonts.googleapis.com.
     That is a reason to fall back to the local stack and carry on — the
     card comes out in a substitute face, which `--check` will report as
     a difference — not a reason to die on an unhandled timeout. */
  try { await page.setContent(spec.html, { waitUntil: 'networkidle' }); }
  catch { console.log('  (fonts did not load — the card below is set in a fallback face)'); }
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ type: 'jpeg', quality: spec.quality });
  await page.close();

  const abs = path.join(ROOT, spec.file);
  const before = existsSync(abs) ? readFileSync(abs) : null;
  const same = before && before.equals(buf);
  if (CHECK) {
    const note = spec.guarded ? '   (hand-made; only --wide rewrites it)' : '';
    console.log(`${same ? 'unchanged' : 'DIFFERS '}  ${spec.file}  ${spec.w}x${spec.h}  ${buf.length} bytes${note}`);
    if (!same && !spec.guarded) changed++;
  } else {
    writeFileSync(abs, buf);
    console.log(`wrote ${spec.file}  ${spec.w}x${spec.h}  ${buf.length} bytes`);
  }
}
await br.close();

if (CHECK && changed) {
  console.log(`\n${changed} image(s) would change — run without --check, look at them, and commit.`);
}
