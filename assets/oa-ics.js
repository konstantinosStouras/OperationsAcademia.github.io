/* ---------------------------------------------------------------------------
   Operations Academia — a minimal, dependency-free iCalendar (.ics) writer.

   ONE definition, loaded by BOTH sides, like assets/oa-xlsx.js:

     the browser   <script src="assets/oa-ics.js">            -> window.OAIcs
     the checks    createRequire(...)('.../oa-ics.js')        -> module.exports

   so _scraper/selftest.mjs builds a real calendar offline and reads the text
   back through _scraper/_ics-read.mjs, rather than trusting that a browser
   only file produces something a calendar app will import. ES5, no build
   step, no CDN — the rule every dual-mode file here is written under.

   WHAT A CALENDAR FILE IS. RFC 5545: CRLF line endings, a VCALENDAR wrapping
   VEVENTs, TEXT values with backslash, semicolon, comma and newline escaped,
   and every line folded at 75 OCTETS (bytes, not characters — a folded line
   continues on the next one after a single space). Every one of those is
   enforced here because a calendar app that meets a bad file does not show
   an error: it imports nothing, or imports the wrong day, and the reader
   blames the site.

   TWO KINDS OF EVENT, and the difference is the whole point of the two
   consumers:

     day:   'YYYY-MM-DD'          an ALL-DAY event (a deadline). No clock, no
                                  zone: applications close at the end of the
                                  day named, wherever the reader is. Marked
                                  TRANSPARENT, so it does not block the day.
     start: 'YYYY-MM-DDTHH:MM'    a TIMED event (a talk), `minutes` long, in
     tzid:  'America/Los_Angeles' the zone named — and the VTIMEZONE for that
                                  zone is written into the file, because a
                                  TZID without one is a reference some apps
                                  quietly read as the reader's own zone. A
                                  conference talk at 10:45 in San Francisco
                                  must stay 10:45 Pacific on the phone of
                                  somebody importing it from Boston, and
                                  still read 10:45 once that phone lands.

   A UID is STABLE: the same posting exported twice carries the same UID, so a
   second import updates the entry rather than duplicating it. Every UID is
   made into an address form (`…@operationsacademia.org`) because that is the
   shape every app accepts.

   API
     OAIcs.build(events, opts) -> string       the calendar text
     OAIcs.download(filename, text)           browser: save it
     OAIcs.escape(text) / OAIcs.fold(line)    the two RFC rules, for the checks
     OAIcs.stamp(date) -> 'YYYYMMDDTHHMMSSZ'  a UTC instant as the file writes it

   `opts`: { name, description, now, timezones: [tz] }
   `tz`:   { id, parts: [{ kind: 'STANDARD'|'DAYLIGHT', start, rrule, from, to, name }] }
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OAIcs = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DOMAIN = 'operationsacademia.org';
  var PRODID = '-//Operations Academia//operationsacademia.org//EN';
  var LINE_OCTETS = 75;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function txt(v) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\r\n?/g, '\n');
  }

  /** A TEXT value, escaped the RFC 5545 way. Newlines survive as `\n`, which
      is how a description keeps its lines; everything else that would be
      read as structure is backslashed. The order matters: the backslash
      first, or the ones added for the others would be doubled. */
  function escape(v) {
    return txt(v)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  /** The UTF-8 length of one code point, without TextEncoder — the file is
      ES5 and the browser half runs wherever the site does. */
  function octets(code) {
    if (code < 0x80) return 1;
    if (code < 0x800) return 2;
    if (code < 0x10000) return 3;
    return 4;
  }

  /** Fold one content line at 75 octets. A continuation line begins with a
      space that counts toward its own 75, so it carries 74 octets of content;
      a surrogate pair is never split, because half of one is not a
      character. */
  function fold(line) {
    var out = '', cur = '', used = 0, i = 0, limit = LINE_OCTETS;
    while (i < line.length) {
      var code = line.charCodeAt(i), ch = line.charAt(i), step = 1;
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < line.length) {
        var low = line.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          ch = line.substr(i, 2);
          step = 2;
        }
      }
      var n = octets(code);
      if (used + n > limit) {
        out += cur + '\r\n ';
        cur = '';
        used = 1;              // the leading space of the continuation line
        limit = LINE_OCTETS;
      }
      cur += ch;
      used += n;
      i += step;
    }
    return out + cur;
  }

  function isoDayOk(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return false;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }

  /** 'YYYY-MM-DD' -> 'YYYYMMDD' */
  function dateValue(day) { return String(day).replace(/-/g, ''); }

  /** The day after, as 'YYYY-MM-DD' — an all-day event's DTEND is EXCLUSIVE,
      so a one-day event ends on the next day. */
  function nextDay(day) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  /** 'YYYY-MM-DDTHH:MM' plus `minutes`, as a LOCAL (wall-clock) value
      'YYYYMMDDTHHMMSS'. Arithmetic in UTC deliberately: the value is a wall
      clock in the event's own zone, and the zone is said beside it by TZID,
      so the writer's own zone must never leak into it. */
  function localValue(start, addMinutes) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(start || ''));
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5] + (addMinutes || 0)));
    if (isNaN(+d)) return '';
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
      'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + '00';
  }

  function startOk(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
    return !!m && isoDayOk(m[1] + '-' + m[2] + '-' + m[3]) && +m[4] < 24 && +m[5] < 60;
  }

  /** A UTC instant as the file writes one: DTSTAMP, and any absolute time. */
  function stamp(d) {
    var t = d instanceof Date && !isNaN(+d) ? d : new Date();
    return t.getUTCFullYear() + pad(t.getUTCMonth() + 1) + pad(t.getUTCDate()) +
      'T' + pad(t.getUTCHours()) + pad(t.getUTCMinutes()) + pad(t.getUTCSeconds()) + 'Z';
  }

  /** A UID in address form, ASCII-safe: an id is derived from a name somebody
      typed, so anything outside the characters every app accepts is folded
      to a hyphen. */
  function uidOf(v) {
    var s = String(v == null ? '' : v).replace(/[^A-Za-z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!s) return '';
    return s.indexOf('@') === -1 ? s + '@' + DOMAIN : s;
  }

  /** An http(s) address or nothing — the same rule OAXlsx.safeUrl applies,
      because a calendar entry's URL is followed by a click too. */
  function safeUrl(v) {
    var s = String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
    if (!/^https?:\/\//i.test(s)) return '';
    if (/[\s<>"]/.test(s)) return '';
    return s;
  }

  function line(name, value) {
    return fold(name + ':' + value);
  }

  function tzBlock(tz) {
    if (!tz || !tz.id || !tz.parts || !tz.parts.length) return [];
    var out = ['BEGIN:VTIMEZONE', line('TZID', tz.id)];
    tz.parts.forEach(function (p) {
      if (!p || (p.kind !== 'STANDARD' && p.kind !== 'DAYLIGHT')) return;
      out.push('BEGIN:' + p.kind);
      out.push(line('DTSTART', p.start));
      if (p.rrule) out.push(line('RRULE', p.rrule));
      out.push(line('TZOFFSETFROM', p.from));
      out.push(line('TZOFFSETTO', p.to));
      if (p.name) out.push(line('TZNAME', escape(p.name)));
      out.push('END:' + p.kind);
    });
    out.push('END:VTIMEZONE');
    return out;
  }

  /**
   * One VEVENT, or null for an event that cannot be written: no UID, no
   * summary, or a day/start that is not a real date. Refusing is right —
   * "the posting does not say" is an event a calendar has no way to show,
   * and a guessed date is worse than none.
   */
  function eventBlock(ev, now, tzIds) {
    if (!ev) return null;
    var uid = uidOf(ev.uid);
    var summary = txt(ev.summary).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!uid || !summary) return null;

    var out = ['BEGIN:VEVENT', line('UID', uid), line('DTSTAMP', stamp(now))];
    if (ev.day) {
      if (!isoDayOk(ev.day)) return null;
      out.push(line('DTSTART;VALUE=DATE', dateValue(ev.day)));
      out.push(line('DTEND;VALUE=DATE', dateValue(nextDay(ev.day))));
    } else if (ev.start) {
      if (!startOk(ev.start)) return null;
      var minutes = (typeof ev.minutes === 'number' && ev.minutes > 0) ? Math.floor(ev.minutes) : 90;
      var tzid = ev.tzid && tzIds[ev.tzid] ? ev.tzid : '';
      var suffix = tzid ? ';TZID=' + tzid : '';
      out.push(line('DTSTART' + suffix, localValue(ev.start, 0)));
      out.push(line('DTEND' + suffix, localValue(ev.start, minutes)));
    } else {
      return null;
    }
    out.push(line('SUMMARY', escape(summary)));
    var desc = txt(ev.description).replace(/^\s+|\s+$/g, '');
    if (desc) out.push(line('DESCRIPTION', escape(desc)));
    var loc = txt(ev.location).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (loc) out.push(line('LOCATION', escape(loc)));
    var url = safeUrl(ev.url);
    if (url) out.push(line('URL', url));
    var cats = (ev.categories || []).map(function (c) { return escape(c); }).filter(Boolean);
    if (cats.length) out.push(line('CATEGORIES', cats.join(',')));
    if (ev.day) out.push('TRANSP:TRANSPARENT');
    out.push('END:VEVENT');
    return out;
  }

  /**
   * The calendar.
   *
   * @param events  [{ uid, summary, description, location, url, categories,
   *                   day | start + minutes + tzid }]
   * @param opts    { name, description, now, timezones }
   * @returns       the text, CRLF-terminated, every line folded — or '' when
   *                not one event could be written, so a caller can refuse to
   *                hand the reader an empty calendar.
   */
  function build(events, opts) {
    opts = opts || {};
    var now = opts.now instanceof Date ? opts.now : new Date();
    var tzIds = {};
    var tzLines = [];
    (opts.timezones || []).forEach(function (tz) {
      if (!tz || !tz.id || tzIds[tz.id]) return;
      var block = tzBlock(tz);
      if (block.length) { tzIds[tz.id] = true; tzLines = tzLines.concat(block); }
    });

    var body = [];
    (events || []).forEach(function (ev) {
      var block = eventBlock(ev, now, tzIds);
      if (block) body = body.concat(block);
    });
    if (!body.length) return '';

    var head = ['BEGIN:VCALENDAR', 'VERSION:2.0', line('PRODID', opts.prodid || PRODID),
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    var name = txt(opts.name).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (name) head.push(line('X-WR-CALNAME', escape(name)));
    var about = txt(opts.description).replace(/^\s+|\s+$/g, '');
    if (about) head.push(line('X-WR-CALDESC', escape(about)));

    return head.concat(tzLines, body, ['END:VCALENDAR']).join('\r\n') + '\r\n';
  }

  /** Browser: hand the reader the file. The same shape as OAXlsx.download. */
  function download(filename, text) {
    var blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
    return text.length;
  }

  return {
    DOMAIN: DOMAIN,
    PRODID: PRODID,
    LINE_OCTETS: LINE_OCTETS,
    build: build,
    download: download,
    escape: escape,
    fold: fold,
    stamp: stamp,
    uidOf: uidOf,
    safeUrl: safeUrl,
    nextDay: nextDay,
    isoDayOk: isoDayOk
  };
}));
