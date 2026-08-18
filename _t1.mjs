import { open, close } from './_probe.mjs';

const ADMIN = { uid:'admin1', email:'kstouras@gmail.com', emailVerified:true,
                displayName:'K', providerData:[{providerId:'google.com'}] };

// 1) anonymous visitor, all three pages
for (const url of ['previous-markets.html','recent-faculty.html','universities.html']) {
  const { q, errs, logs } = await open(url, { seed:{ docs:[] } });
  await q.waitForTimeout(1500);
  const n = await q.evaluate(()=>document.querySelectorAll('.oa-card, .leaflet-marker-icon').length);
  console.log('ANON', url, 'cards/pins:', n, 'errs:', errs, 'console:', logs.slice(0,5));
  await q.close();
}
await close();
