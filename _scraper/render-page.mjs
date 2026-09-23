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
/** What the browser process is allowed to see of this process's
    environment. The crawl step holds the project's Admin credential, and
    Playwright's default hands the WHOLE environment to the browser and to
    every renderer it forks for a page from the POMS list, so a renderer
    exploit's payoff would have been /proc/self/environ (the 2026-09-23
    review). The browser needs a path, a home and a temp directory; nothing
    else. */
export const BROWSER_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'PLAYWRIGHT_BROWSERS_PATH', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'DISPLAY'];
export function browserEnv(from = process.env) {
  const env = {};
  for (const k of BROWSER_ENV_KEYS) if (from[k]) env[k] = String(from[k]);
  return env;
}

/**
 * The page as a reader sees it: `{ ok, text, title, h1, error }`, where
 * `text` is the body's innerText once the page has settled and `h1` is its
 * first heading — which on a job page is the position's title, and is
 * handed to the text parser as the title hint, since the body's first line
 * is routinely the site's own chrome ("Already have an account? Sign In").
 *
 * The whole read is raced against one clock (`overallMs`) whose loser
 * closes the browser, which rejects any call still pending inside: a page
 * whose script never yields, or that shadows `innerText` with a getter that
 * never returns, hung `page.evaluate` for ever, since that call takes no
 * timeout (the 2026-09-23 review). The words are read through Playwright's
 * utility world (`locator.innerText`, `page.title`), each with a timeout,
 * where a page's own definitions are not in force.
 */
export async function renderedText(u, {
  timeoutMs = 45000,
  overallMs = 0,
  executablePath = process.env.PW_CHROMIUM || '',
} = {}) {
  const pw = await playwright();
  if (!pw || !pw.chromium) return { ok: false, text: '', title: '', h1: '', error: 'playwright is not installed' };
  const deadline = overallMs > 0 ? overallMs : timeoutMs + 45000;

  let browser = null;
  const launch = async () => {
    const base = { headless: true, env: browserEnv(), ...(executablePath ? { executablePath } : {}) };
    /* the OS sandbox on, where the runner allows it; a launch it refuses is
       tried once more without, as Playwright's own default has it */
    try {
      return await pw.chromium.launch({ ...base, chromiumSandbox: true });
    } catch {
      return pw.chromium.launch({ ...base, chromiumSandbox: false });
    }
  };
  const work = (async () => {
    try {
      browser = await launch();
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
      const title = await page.title().catch(() => '');
      const h1 = await page.locator('h1').first().innerText({ timeout: 10000 }).catch(() => '');
      const text = String(await page.locator('body').innerText({ timeout: 20000 }).catch(() => '')).trim();
      return { ok: !!text, text, title: String(title || ''), h1: String(h1 || '').trim(),
               error: text ? '' : 'the page rendered no text' };
    } catch (e) {
      return { ok: false, text: '', title: '', h1: '', error: e && e.message ? e.message : String(e) };
    }
  })();
  let timer = null;
  const clock = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, text: '', title: '', h1: '',
      error: `the page did not finish rendering within ${Math.round(deadline / 1000)}s` }), deadline);
  });
  try {
    return await Promise.race([work, clock]);
  } finally {
    if (timer) clearTimeout(timer);
    if (browser) await browser.close().catch(() => {});
  }
}
