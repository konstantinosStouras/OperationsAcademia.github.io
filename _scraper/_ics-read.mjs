/* ---------------------------------------------------------------------------
   Read an .ics back out of its own text — for the CHECKS, not for the site.

   `assets/oa-ics.js` writes a calendar by hand, so the only honest way to
   assert that a deadline really lands on the day it names and a talk really
   carries its zone is to read the file the reader receives and look. Both
   guards need that — `selftest.mjs` builds one from the served data,
   `page-test.mjs` downloads one from a real browser — and two copies of a
   line reader is the drift every shared module in this repository exists to
   prevent. The mirror of `_xlsx-read.mjs`.
   --------------------------------------------------------------------------- */

/** The TEXT escapes, undone. */
export function unescapeText(v) {
  return String(v ?? '').replace(/\\(.)/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Every content line, UNFOLDED (a CRLF followed by a space or tab continues
    the line before it), as `{ name, params: { KEY: value }, value }`. The
    value is returned RAW — `unescapeText` is applied by the caller where the
    property is TEXT, because a URL or a date is not. */
export function contentLines(text) {
  const unfolded = String(text).replace(/\r\n[ \t]/g, '');
  const out = [];
  for (const raw of unfolded.split('\r\n')) {
    if (!raw) continue;
    // the name and its parameters end at the first colon outside a quoted
    // parameter value; no writer here quotes one, so the first colon is it
    const at = raw.indexOf(':');
    if (at < 0) continue;
    const head = raw.slice(0, at).split(';');
    const params = {};
    for (const p of head.slice(1)) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    out.push({ name: head[0].toUpperCase(), params, value: raw.slice(at + 1) });
  }
  return out;
}

/**
 * The calendar as an object: its own properties, the timezone ids it
 * defines, and every VEVENT as a map of property name -> `{ value, params }`
 * (TEXT properties unescaped). Nested components other than VEVENT and
 * VTIMEZONE are skipped.
 */
export function parseIcs(text) {
  const TEXT = new Set(['SUMMARY', 'DESCRIPTION', 'LOCATION', 'CATEGORIES', 'X-WR-CALNAME', 'X-WR-CALDESC', 'TZNAME']);
  const cal = { props: {}, timezones: [], events: [], raw: String(text) };
  let ev = null, depth = [];
  for (const l of contentLines(text)) {
    if (l.name === 'BEGIN') {
      depth.push(l.value.toUpperCase());
      if (l.value.toUpperCase() === 'VEVENT') ev = {};
      continue;
    }
    if (l.name === 'END') {
      const what = depth.pop();
      if (what === 'VEVENT' && ev) { cal.events.push(ev); ev = null; }
      continue;
    }
    const value = TEXT.has(l.name) ? unescapeText(l.value) : l.value;
    const top = depth[depth.length - 1];
    if (top === 'VEVENT' && ev) ev[l.name] = { value, params: l.params };
    else if (top === 'VTIMEZONE' && l.name === 'TZID') cal.timezones.push(l.value);
    else if (top === 'VCALENDAR') cal.props[l.name] = value;
  }
  return cal;
}

/** The longest line's octet count — what the 75-octet rule is measured on. */
export function longestLineOctets(text) {
  let max = 0;
  for (const l of String(text).split('\r\n')) max = Math.max(max, Buffer.byteLength(l, 'utf8'));
  return max;
}
