/* ---------------------------------------------------------------------------
   Operations Academia — the words on a page that only a browser can show.

   apply.interfolio.com serves an Angular shell: the HTML carries a <title>
   of "Apply - Interfolio", the bundle's <script> tags, and nothing about the
   position. Every one of the 42 Interfolio advertisements in
   data/adverts.json is recorded `unreadable` for exactly that reason. The
   position's data is fetched by the bundle after load, from Interfolio's own
   API, which is not documented for the public and needs an institution's
   credentials for the documented one — so the honest way to read the page is
   the way a reader does: run it in a browser and take the text that appears.

   Playwright drives the Chromium the crawler's workflow installs (the same
   bounded, cached install oa-checks.yml already makes for page-test.mjs).
   Loaded LAZILY, and its absence is an answer: without it `renderedText`
   says so and the crawler queues the posting with what the POMS table said.
   A read is bounded by a clock, and a page that never settles is read as it
   stands when the clock runs out.

   Used for ANY page the markup reader could not read, not for Interfolio
   alone — SmartRecruiters, PageUp and the rest of the JavaScript boards fail
   the same way and render the same way.
   --------------------------------------------------------------------------- */

const UA = 'operationsacademia.org posting check (+https://www.operationsacademia.org)';

let lib;   // undefined: not tried; null: absent; else the module
export async function playwright() {
  if (lib !== undefined) return lib;
  try {
    lib = await import('playwright');
  } catch {
    lib = null;
  }
  return lib;
}

/**
 * The page as a reader sees it: `{ ok, text, title, h1, error }`, where
 * `text` is the body's innerText once the page has settled and `h1` is its
 * first heading — which on a job page is the position's title, and is
 * handed to the text parser as the title hint, since the body's first line
 * is routinely the site's own chrome ("Already have an account? Sign In").
 */
export async function renderedText(u, {
  timeoutMs = 45000,
  executablePath = process.env.PW_CHROMIUM || '',
} = {}) {
  const pw = await playwright();
  if (!pw || !pw.chromium) return { ok: false, text: '', title: '', h1: '', error: 'playwright is not installed' };

  let browser = null;
  try {
    browser = await pw.chromium.launch({
      headless: true, ...(executablePath ? { executablePath } : {}),
    });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 2000 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    /* the shell fetches its data after load: wait for the network to go
       quiet, then for a heading, then a beat for the framework to paint —
       each bounded, none fatal */
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('h1, h2', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const got = await page.evaluate(() => ({
      title: document.title || '',
      h1: (document.querySelector('h1') || {}).innerText || '',
      text: document.body ? document.body.innerText || '' : '',
    }));
    const text = String(got.text || '').trim();
    return { ok: !!text, text, title: String(got.title || ''), h1: String(got.h1 || '').trim(),
             error: text ? '' : 'the page rendered no text' };
  } catch (e) {
    return { ok: false, text: '', title: '', h1: '', error: e && e.message ? e.message : String(e) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
