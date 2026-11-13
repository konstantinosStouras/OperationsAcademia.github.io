/* Browser selection shared by the admin queue regression suites.
   PW_BROWSER=firefox|webkit|msedge; default remains Chromium for existing CI.
   Firefox has no isMobile emulation: its narrow run checks responsive/touch
   behavior, not Android Firefox. WebKit is engine coverage, not Apple Safari. */
const playwright = require('playwright');
const name = process.env.PW_BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit', 'msedge'].includes(name)) throw new Error('Unknown PW_BROWSER: ' + name);
module.exports = {
  async launch() {
    const engine = name === 'msedge' ? playwright.chromium : playwright[name];
    const options = { headless: true };
    if (name === 'msedge') options.channel = 'msedge';
    else if (name === 'chromium' && process.env.PW_CHROMIUM) options.executablePath = process.env.PW_CHROMIUM;
    const browser = await engine.launch(options);
    console.log('Admin tests: ' + name + ' ' + browser.version());
    return browser;
  },
  context(viewport) {
    return { viewport, hasTouch: viewport.width < 500,
      ...(name === 'firefox' ? {} : { isMobile: viewport.width < 500 }) };
  }
};
