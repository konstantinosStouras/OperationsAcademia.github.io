/* ---------------------------------------------------------------------------
   Operations Academia: the candidate CARD, and what the build publishes of a
   profile. ONE renderer, ONE projection, three readers:

     the front page's candidates list   <script src="assets/oa-candcard.js"> -> window.OACandCard
     the account page's own-card preview   the same tag
     the posting form's live preview       the same tag
     the selftest                          createRequire(...) -> module.exports

   WHY ONE RENDERER (owner, 2026-09-04). A candidate who has posted a profile
   may see how THEIR OWN card will look before the reveal, and may watch it
   change as they type on the form. A preview drawn by a second copy of the
   card would be a promise the list then breaks in some small way, a label
   moved or a row missing, and the same goes for the row it draws: a preview
   built from the form's raw values would show a link the build refuses or a
   name the build re-spells. So the card is built from `cardConfig` here, the
   same rows in the same order for the list and the previews, and the row is
   built by `publicRowFromDoc`, a browser twin of the build's projection
   (`rowFromCandidateSubmission` + `publicCandidateRow` in
   _scraper/candidates-model.mjs) that selftest.mjs pins against the real one
   over a fixture table. `oa-fresh.js`'s `approvedRow` is the precedent: the
   name canonicaliser is INJECTED (the browser passes OASchools.canonColumns,
   Node passes the model's own), so this file keeps no dependency and the
   parity test can drive it offline.

   THE LIST'S OUTPUT IS UNCHANGED, TO THE BYTE. index.html keeps its own three
   link helpers and passes them in; the labels and their order are what they
   were. `decorate` adds the one new thing, the "Profile updated on" line, and
   adds it only INSIDE a card body: a locked card (a signed-out reader's) has
   no body and gets nothing, so the blurred strip of labels never advertises
   the line and the values stay absent rather than hidden.

   WHAT THE BROWSER CANNOT COMPUTE it leaves out rather than fakes: `owner` is
   a sha256 of the uid (node:crypto in the build) and is skipped when empty,
   exactly as the build skips an empty `ref`.

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.OACandCard = factory(root);
  }
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  /* The published fields, in the order the build writes them. A browser copy
     of CANDIDATE_PUBLIC_FIELDS in _scraper/candidates-model.mjs, pinned
     against it BOTH WAYS by selftest.mjs, so a field added to one is refused
     until it is added to the other. */
  var FIELDS = [
    'id', 'year', 'posted', 'first', 'last', 'name', 'affiliation', 'position',
    'researchAreas', 'informsDays', 'talks', 'cvUrl', 'rsUrl', 'webUrl', 'email',
    'source', 'addedAt', 'updatedAt', 'ref', 'owner'
  ];

  /* the talk details a day may carry (TALK_KEYS / TALK_MAXLEN in
     candidates-model.mjs, pinned both ways by selftest.mjs) */
  var TALK_KEYS = ['at', 'session', 'room', 'title'];
  var TALK_MAXLEN = { at: 5, session: 40, room: 120, title: 200 };
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  /* the same bounds as the model; a value longer than these is cut, never
     refused, so the preview shows the cut the build would make */
  var MAXLEN = {
    first: 100, last: 100, affiliation: 220, position: 160,
    institution: 160, school: 160, unit: 160,
    cvUrl: 500, rsUrl: 500, webUrl: 500, email: 160
  };
  var INFORMS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday'];
  var AREAS_MAX = 10;
  var AREA_LEN = 80;
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  /* ------------------------------------------- the sanitisers, ES5 copies

     Each is jobs-model.mjs's own (text, url, day, pickList, slug) or
     candidates-model.mjs's (freeList, tsToDate, joinCandidateAffiliation,
     candidateId), copied rather than imported because this file has to run
     in a browser with no module system. The parity table in selftest.mjs is
     what keeps the copies honest. */

  function text(v, max) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^\s+|\s+$/g, '')
      .slice(0, max == null ? 400 : max);
  }

  function url(v) {
    var s = String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
    if (!/^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/i.test(s)) return '';
    return s.slice(0, 500);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function valid(y, m, d) {
    var yy = +y, mm = +m, dd = +d;
    if (!(yy >= 1990 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return '';
    var t = new Date(Date.UTC(yy, mm - 1, dd));
    if (t.getUTCMonth() !== mm - 1 || t.getUTCDate() !== dd) return '';
    return yy + '-' + pad2(mm) + '-' + pad2(dd);
  }

  function day(v) {
    var s = String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
    if (!s) return '';
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return valid(m[1], m[2], m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return valid(m[3], m[1], m[2]);
    m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
    if (m) {
      var mo = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1;
      if (mo) return valid(m[3], String(mo), m[2]);
    }
    return '';
  }

  function listOf(v) { return Object.prototype.toString.call(v) === '[object Array]' ? v : [v]; }

  /* the seen-sets are prototype-free: with a plain {} an area named
     "constructor" is seen before it is ever added and is dropped, where the
     build's Set keeps it, and the twin would then disagree with the build */
  function pickList(v, allowed) {
    var seen = Object.create(null), out = [];
    listOf(v).forEach(function (x) {
      var t = text(x, 80);
      if (allowed.indexOf(t) === -1 || seen[t]) return;
      seen[t] = true;
      out.push(t);
    });
    return out;
  }

  /* candidates-model's talksFrom: only the days published, only the four
     keys, the time refused unless it is a real 'HH:MM', a day with nothing
     left dropped whole */
  function talksFrom(v, days) {
    var out = {};
    if (!v || typeof v !== 'object' || Object.prototype.toString.call(v) === '[object Array]') return out;
    (days || []).forEach(function (d) {
      var t = v[d];
      if (!t || typeof t !== 'object' || Object.prototype.toString.call(t) === '[object Array]') return;
      var talk = {}, any = false;
      TALK_KEYS.forEach(function (k) {
        var s = text(t[k], TALK_MAXLEN[k]);
        if (k === 'at' && s && !TIME_RE.test(s)) s = '';
        if (s) { talk[k] = s; any = true; }
      });
      if (any) out[d] = talk;
    });
    return out;
  }

  function freeList(v) {
    var seen = Object.create(null), out = [];
    listOf(v).forEach(function (x) {
      var t = text(x, AREA_LEN);
      if (!t || seen[t]) return;
      seen[t] = true;
      out.push(t);
    });
    return out.slice(0, AREAS_MAX);
  }

  function slug(s) {
    var v = String(s == null ? '' : s).toLowerCase();
    if (typeof v.normalize === 'function') v = v.normalize('NFD');
    return v
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '');
  }

  /** A Firestore Timestamp, a Date, a stamp string, or junk -> Date or null.
      TOTAL, like the model's: an Invalid Date comes back as null and never
      reaches toISOString(). */
  function tsToDate(ts) {
    if (!ts) return null;
    var d;
    if (ts instanceof Date) d = ts;
    else if (typeof ts.toDate === 'function') d = ts.toDate();
    else d = new Date(ts);
    return d instanceof Date && !isNaN(+d) ? d : null;
  }

  function isoDay(d) { return d.toISOString().slice(0, 10); }
  function isoStamp(d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  function candidateId(row) {
    return row.year + '-' + slug(row.last) + '-' + slug(row.first);
  }

  /* --------------------------------------------------------- the projection */

  /**
   * A `candidateSubmissions` document -> the row the build would publish, or
   * null where the build would publish nothing (a required detail missing).
   * The twin of publicCandidateRow(rowFromCandidateSubmission(doc, { now }))
   * in _scraper/candidates-model.mjs, pinned against it in selftest.mjs.
   *
   * `helpers`:
   *   canonColumns  the site's one spelling per place (OASchools.canonColumns
   *                 in the browser, jobs-model's in Node); identity if absent
   *   ownerTag      uid -> the published owner digest (Node only; the browser
   *                 has no synchronous sha256, so `owner` is '' and skipped,
   *                 like an empty `ref`)
   *   marketYear    now -> the market year (OAJobNav.marketYear, the ONE
   *                 definition of the July roll; never a copy of it here). A
   *                 document always carries `year` (the rules require it), so
   *                 this is reached only for a junk year: without the helper
   *                 such a document projects to null rather than to a guess
   *   now           the clock, for the parity test
   */
  function publicRowFromDoc(doc, helpers) {
    var h = helpers || {};
    doc = doc || {};
    var now = h.now ? new Date(h.now) : new Date();
    if (isNaN(+now)) now = new Date();
    var canon = h.canonColumns || (root && root.OASchools && root.OASchools.canonColumns)
      || function (place) { return place; };
    var tag = h.ownerTag || function () { return ''; };
    var marketYear = h.marketYear || (root && root.OAJobNav && root.OAJobNav.marketYear) || null;

    var first = text(doc.first, MAXLEN.first);
    var last = text(doc.last, MAXLEN.last);
    var place = canon({
      institution: text(doc.institution, MAXLEN.institution),
      school: text(doc.school, MAXLEN.school),
      unit: text(doc.unit, MAXLEN.unit)
    }) || {};
    var affiliation = [place.unit, place.school, place.institution]
      .filter(Boolean).join(', ').slice(0, MAXLEN.affiliation)
      || text(doc.affiliation, MAXLEN.affiliation);
    var position = text(doc.position, MAXLEN.position);
    if (!first || !last || !affiliation || !position) return null;

    var y = +doc.year;
    var year;
    if (isFinite(y) && y >= 2000 && y <= 2100) year = y < 0 ? Math.ceil(y) : Math.floor(y);
    else if (marketYear) year = marketYear(now);
    else return null;

    var created = tsToDate(doc.createdAt) || now;
    var stamped = isoDay(created);
    var asked = day(doc.postedOn);
    var posted = asked && asked <= stamped ? asked : stamped;

    var email = doc.emailPublic === true && EMAIL_RE.test(String(doc.email || '').replace(/^\s+|\s+$/g, ''))
      ? text(doc.email, MAXLEN.email)
      : '';

    var updated = tsToDate(doc.updatedAt);
    var row = {
      id: '',
      year: year,
      posted: posted,
      first: first,
      last: last,
      name: first + ' ' + last,
      affiliation: affiliation,
      position: position,
      researchAreas: freeList(doc.researchAreas),
      informsDays: pickList(doc.informsDays, INFORMS_DAYS),
      talks: {},
      cvUrl: url(doc.cvUrl),
      rsUrl: url(doc.rsUrl),
      webUrl: url(doc.webUrl),
      email: email,
      source: text(doc.source, 40) || 'oa-form',
      addedAt: isoStamp(created),
      updatedAt: updated ? isoDay(updated) : '',
      ref: text(doc.ref, 40),
      owner: tag(doc.uid)
    };
    row.talks = talksFrom(doc.talks, row.informsDays);
    row.id = candidateId(row);

    /* publicCandidateRow: the published keys, in order; an empty `ref`,
       `email`, `updatedAt` or `talks` is left out entirely. `owner` is left
       out when no ownerTag was INJECTED (the browser, which cannot compute
       it): the build always can, and publishes '' for a document with no
       uid, so with a helper injected the twin does exactly that. */
    var out = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var k = FIELDS[i];
      if (row[k] === undefined) continue;
      if ((k === 'ref' || k === 'email' || k === 'updatedAt') && !row[k]) continue;
      if (k === 'talks' && (!row[k] || !Object.keys(row[k]).length)) continue;
      if (k === 'owner' && !h.ownerTag) continue;
      out[k] = row[k];
    }
    return out;
  }

  /* ---------------------------------------- the talks, as the card says them

     One row per day that carries details, after "Presenting at INFORMS":
     "Talk on Monday 2 November 2026" where assets/oa-informs.js knows the
     season's meeting (loaded on every page that draws a card; absent, the
     bare day name), and the details in reading order: the time, the session
     code, the room, the title. The calendar (assets/oa-talkcal.js) reads the
     same fields; this is what a committee reads on the page. */
  function talkRows(r) {
    var talks = r && r.talks;
    if (!talks || typeof talks !== 'object') return [];
    var days = (r.informsDays || []).filter(function (d) { return talks[d]; });
    var meeting = (root && root.OAInforms && root.OAInforms.meetingFor)
      ? root.OAInforms.meetingFor(r.year) : null;
    return days.map(function (d) {
      var t = talks[d] || {};
      var parts = [];
      if (t.at) parts.push(t.at);
      if (t.session) parts.push('session ' + t.session);
      if (t.room) parts.push(t.room);
      if (t.title) parts.push('“' + t.title + '”');
      var when = meeting && root.OAInforms.dayLabel ? root.OAInforms.dayLabel(meeting, d) : d;
      return { label: 'Talk on ' + when, value: parts.join(' · ') };
    });
  }

  /* ------------------------------------------------------------ the card */

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === false || v === undefined) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  /* The three link helpers the previews use. index.html keeps ITS OWN copies
     (they rewrite the site's own addresses and read OAList.safeUrl) and passes
     them in, which is what keeps the list's output byte-identical; these are
     for the two pages that have none. All three answer null for a value the
     row should not link, which is what makes the engine skip the row. */
  function defaultLink(href, label) {
    var u = url(href);
    if (!u) return null;
    var a = document.createElement('a');
    a.href = u;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label || 'link';
    return a.outerHTML;
  }

  function defaultUniLink(name) {
    name = String(name || '').replace(/^\s+|\s+$/g, '');
    /* the affiliation is the whole joined line, smallest part first; the
       LAST part is the university, which is what the directory searches */
    if (name.indexOf(',') !== -1) {
      var parts = name.split(',');
      name = parts[parts.length - 1].replace(/^\s+|\s+$/g, '') || name;
    }
    if (!name) return null;
    var a = document.createElement('a');
    a.href = 'universities.html?filterA=' + encodeURIComponent(name);
    a.textContent = name;
    return a.outerHTML;
  }

  function defaultMailto(email) {
    email = String(email || '').replace(/^\s+|\s+$/g, '');
    if (!EMAIL_RE.test(email)) return null;
    var a = document.createElement('a');
    a.href = 'mailto:' + encodeURIComponent(email);
    a.textContent = email;
    return a.outerHTML;
  }

  /**
   * The card as OAList draws it: `{ title, subtitle, rows }`, the rows in
   * the one order the list has always shown them. `helpers` may carry
   * `link(url, label)`, `uniLink(affiliation)` and `mailto(email)`; index.html
   * passes its own three, the previews take the defaults above.
   */
  function cardConfig(helpers) {
    var h = helpers || {};
    var link = h.link || defaultLink;
    var uniLink = h.uniLink || defaultUniLink;
    var mailto = h.mailto || defaultMailto;
    return {
      title: function (r) { return r.name; },
      subtitle: function (r) {
        return [r.affiliation, r.position].filter(Boolean).join(' \u2014 ');
      },
      rows: function (r) {
        return [
          { label: 'Research area(s)',      value: (r.researchAreas || []).join(', ') },
          { label: 'Presenting at INFORMS', value: (r.informsDays || []).join(', ') }
        ].concat(talkRows(r), [
          { label: 'University page',       html: uniLink(r.affiliation) },
          { label: 'CV',                    html: link(r.cvUrl, 'link to CV') },
          // the form stopped asking for a research summary (2026-08-24);
          // the row stays for profiles filed while it still did, and an
          // empty rsUrl draws nothing
          { label: 'Research summary',      html: link(r.rsUrl, 'link') },
          { label: 'Web page',              html: link(r.webUrl, 'link') },
          { label: 'Contact',               html: mailto(r.email) }
        ]);
      }
    };
  }

  /**
   * "Profile updated on 2 October 2026", or '' where the card says nothing:
   * only when `updatedAt` is a LATER day than `addedAt` (a profile edited the
   * day it was posted has nothing to report). Day-month-year comes from
   * OAReveal.formatDay, the site's one home of that format; a caller with
   * no module may pass its own `formatDay`, and with neither the bare day
   * is printed rather than a second formatter kept here.
   */
  function updatedOnText(row, formatDay) {
    if (!row) return '';
    var u = String(row.updatedAt || '').slice(0, 10);
    var a = String(row.addedAt || '').slice(0, 10);
    if (!u || !a || u <= a) return '';
    var fmt = formatDay || (root && root.OAReveal && root.OAReveal.formatDay) || null;
    var when = fmt ? fmt(u) : '';
    return 'Profile updated on ' + (when || u);
  }

  /**
   * Add the "updated on" line to a drawn card, as the LAST line of its body.
   * A card with no body (a locked one) is left exactly as it is: the values
   * are absent there, and a line that is not a labelled row can never reach
   * the blurred strip either. Safe to call again (the list re-renders).
   */
  function decorate(li, row) {
    if (!li || typeof li.querySelector !== 'function') return;
    var body = li.querySelector('.oa-card-body');
    if (!body) return;
    var old = body.querySelector('.oa-card-updated');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var line = updatedOnText(row);
    if (!line) return;
    var doc = body.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    var p = doc.createElement('p');
    p.className = 'oa-card-updated';
    p.textContent = line;
    body.appendChild(p);
  }

  /**
   * One OPEN card, standing alone, for the previews: the same head, the same
   * `.oa-kv` table built from the same `cardConfig`, then `decorate`. The
   * head is a plain block rather than the list's toggle button: there is
   * nothing to open and nothing to lock. Null without a row or a document.
   */
  function render(row, helpers) {
    if (!row || typeof document === 'undefined') return null;
    var c = cardConfig(helpers);
    var head = el('div', { class: 'oa-card-head' }, [
      el('p', { class: 'oa-card-title', text: c.title(row) }),
      el('p', { class: 'oa-card-sub', text: c.subtitle(row) })
    ]);
    var table = el('table', { class: 'oa-kv' });
    var tbody = el('tbody');
    (c.rows(row) || []).forEach(function (kv) {
      if (!kv || (!kv.value && !kv.html)) return;
      var td = el('td');
      if (kv.html) td.innerHTML = kv.html;
      else td.textContent = kv.value;
      tbody.appendChild(el('tr', null, [el('th', { scope: 'row', text: kv.label }), td]));
    });
    table.appendChild(tbody);
    var body = el('div', { class: 'oa-card-body' });
    body.appendChild(table);
    var li = el('li', { class: 'oa-card oa-card-preview' }, [head, body]);
    decorate(li, row);
    return li;
  }

  /** Draw ONE card into `host` (emptied first), inside the same `ul.oa-cards`
      the list uses so oa-list.css and v3.css style it. Returns the card, or
      null with the host left empty. */
  function mount(host, row, helpers) {
    if (!host) return null;
    host.innerHTML = '';
    var li = render(row, helpers);
    if (!li) return null;
    var ul = el('ul', { class: 'oa-cards' });
    ul.appendChild(li);
    host.appendChild(ul);
    return li;
  }

  return {
    FIELDS: FIELDS,
    INFORMS_DAYS: INFORMS_DAYS,
    TALK_KEYS: TALK_KEYS,
    TALK_MAXLEN: TALK_MAXLEN,
    talksFrom: talksFrom,
    talkRows: talkRows,
    publicRowFromDoc: publicRowFromDoc,
    cardConfig: cardConfig,
    updatedOnText: updatedOnText,
    decorate: decorate,
    render: render,
    mount: mount,
    link: defaultLink,
    uniLink: defaultUniLink,
    mailto: defaultMailto
  };
}));
