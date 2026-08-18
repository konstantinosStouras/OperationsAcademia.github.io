import { open, close } from './_probe.mjs';
const { q, errs } = await open('previous-markets.html', { seed:{ docs:[] } });
await q.waitForTimeout(1200);
const info = await q.evaluate(async () => {
  const past = await (await fetch('/data/past-postings.json')).json();
  const ids = new Set(past.map(r=>r.id));
  // pull the engine's rows via a card scan is awkward; use OAList internals? not exposed.
  const jobs = await (await fetch('/data/jobs.json')).json();
  return { past: past.length, jobs: jobs.length, marketYear: window.OAList ? 'n/a' : 'n/a' };
});
console.log(info);
// Count total cards by reading the result bar
const bar = await q.textContent('.oa-resultbar');
console.log('resultbar:', bar.replace(/\s+/g,' ').trim().slice(0,200));
await q.close(); await close();
