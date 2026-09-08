/* ---------------------------------------------------------------------------
   Operations Academia: how a forum post's words are READ, decided once.

   A post is typed in the compose box with a formatting toolbar above it
   (owner, 2026-09-08: "add that standard editing menu when someone composes
   a new question", with the Stack Exchange toolbar beside it). What the
   toolbar writes is the Markdown subset that site writes, and this module is
   the ONE reading of it, loaded by every consumer:

     forum.html             <script src="assets/oa-forum-markup.js"> -> window.OAForumMarkup
                            html() draws a post; plain() is what a quote of the
                            whole post falls back to
     the Cloud Functions    require('../forum-markup.js'), the VENDORED copy that
                            _scraper/build-functions-vendor.mjs writes and the
                            selftest pins byte-for-byte against this file: plain()
                            is what a thread's excerpt is cut from, and what a
                            quoted passage is checked against
     _scraper/seed-forum.mjs, _fake-firebase.js and the selftest
                            createRequire(...) / window            -> the same two

   WHAT IT READS. Paragraphs on a blank line (a single line break stays a
   line break, as it always did here); `**bold**`, `*italic*` and their
   underscore forms; `[label](https://…)` links and bare web addresses;
   `> quoted` lines; `# headings`; `-` and `1.` lists, nested by indent;
   `code` in backticks and blocks in fences or four spaces of indent; and a
   line of three dashes as a rule. Nothing else: no raw HTML (every character
   is escaped at emission, so `<img>` in a post is the five characters), no
   images (rule 6 of the guide forbids screenshots, and an image fetched from
   somebody else's host by every reader's browser would tell that host who
   read the thread and when, on a page that deliberately loads no analytics),
   no tables, no footnotes.

   TWO EMITTERS, ONE PARSE. html() and plain() walk the same tree, so the
   words a reader SELECTS on the rendered post are the words plain() answers
   with, whitespace aside: that is what lets forumPost accept a quote of the
   rendered words of a formatted post (member.js flattens both sides), and
   what keeps a thread's excerpt free of the markers.

   A LINK IS http, https OR www AND NOTHING ELSE. `[x](javascript:…)` is
   drawn as the text it is; an address is never followed off the page
   without `noopener noreferrer nofollow`, and it opens in a new tab so the
   thread stays. Trailing sentence punctuation is not part of a bare
   address, and a closing bracket only counts as punctuation when the
   address does not open one of its own (Wikipedia's titles end that way).

   Written in ES5 so it needs no transpiling for either consumer.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OAForumMarkup = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------ inline */

  var URL_RX = /^(https?:\/\/|www\.)[^\s<]+/i;
  /* what may precede a bare address for it to be one: the start, a space, an
     opening bracket, a quotation mark */
  var LEAD_RX = /[\s("'“‘]/;
  var TRAIL = '.,!?)"\'>&:;]”’';

  function isWord(c) {
    return !!c && /[A-Za-z0-9]/.test(c);
  }

  function isSpace(c) {
    return !c || /\s/.test(c);
  }

  /** The address at position i, with the trailing punctuation that is not
      part of it handed back; null when there is none. */
  function urlAt(s, i) {
    var m = URL_RX.exec(s.slice(i));
    if (!m) return null;
    var url = m[0];
    var trail = 0;
    while (url) {
      var last = url.charAt(url.length - 1);
      /* a closing bracket the address opened is part of it */
      if (last === ')' && url.split(')').length <= url.split('(').length) break;
      if (TRAIL.indexOf(last) === -1) break;
      url = url.slice(0, -1);
      trail++;
    }
    if (!url || /^www\.$/i.test(url) || /^https?:\/\/$/i.test(url)) return null;
    return { text: url, href: /^www\./i.test(url) ? 'https://' + url : url, end: i + url.length };
  }

  /** `[label](address)` at position i, or null. The label may hold
      emphasis and code; the address must be an http, https or www one with
      no space in it, or it is not a link and the brackets are text. */
  function linkAt(s, i) {
    var depth = 0;
    var j = i;
    for (; j < s.length; j++) {
      var c = s.charAt(j);
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) break; }
      else if (c === '\n' && s.charAt(j + 1) === '\n') return null;
    }
    if (j >= s.length || s.charAt(j + 1) !== '(') return null;
    var label = s.slice(i + 1, j);
    if (!label.replace(/\s+/g, '')) return null;
    var k = j + 2;
    var close = s.indexOf(')', k);
    if (close === -1) return null;
    var url = s.slice(k, close).trim();
    if (!url || /\s/.test(url) || !/^(https?:\/\/|www\.)\S+$/i.test(url)) return null;
    return { label: label, href: /^www\./i.test(url) ? 'https://' + url : url, end: close + 1 };
  }

  /** `**x**`, `__x__`, `*x*` or `_x_` opening at position i, or null. A
      run of three is italic bold. The underscore forms need a word
      boundary on both sides, so snake_case is not italics. */
  function emphasisAt(s, i) {
    var d = s.charAt(i);
    var prev = i > 0 ? s.charAt(i - 1) : '';
    var run = 0;
    while (s.charAt(i + run) === d) run++;
    if (run > 3) return null;
    if (d === '_' && isWord(prev)) return null;
    var open = s.slice(i, i + run);
    if (isSpace(s.charAt(i + run))) return null;
    var j = i + run;
    while (j < s.length) {
      j = s.indexOf(d, j);
      if (j === -1) return null;
      var len = 0;
      while (s.charAt(j + len) === d) len++;
      if (len === run && !isSpace(s.charAt(j - 1)) && j > i + run &&
          !(d === '_' && isWord(s.charAt(j + len)))) {
        var inner = s.slice(i + run, j);
        if (inner.indexOf('\n\n') !== -1) return null;
        return { run: run, inner: inner, end: j + len };
      }
      j += len;
    }
    return null;
  }

  /** A backtick run at position i and the code span it opens, or null. */
  function codeAt(s, i) {
    var run = 0;
    while (s.charAt(i + run) === '`') run++;
    var ticks = s.slice(i, i + run);
    var j = i + run;
    while (j < s.length) {
      var close = s.indexOf(ticks, j);
      if (close === -1) return null;
      var len = 0;
      while (s.charAt(close + len) === '`') len++;
      if (len === run) {
        var code = s.slice(i + run, close);
        if (code.length >= 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ' && /\S/.test(code)) {
          code = code.slice(1, -1);
        }
        return { run: run, code: code, end: close + run };
      }
      j = close + len;
    }
    return null;
  }

  /** The inline tokens of a run of text: text, code, strong, em and link.
      `noLinks` is set inside a link's own label, where a second link
      cannot nest. */
  function inline(s, noLinks) {
    var out = [];
    var buf = '';
    var i = 0;
    var n = s.length;
    function flush() {
      if (buf) { out.push({ t: 'text', s: buf }); buf = ''; }
    }
    while (i < n) {
      var c = s.charAt(i);
      var prev = i > 0 ? s.charAt(i - 1) : '';
      if (c === '`') {
        var cd = codeAt(s, i);
        if (cd) { flush(); out.push({ t: 'code', s: cd.code }); i = cd.end; continue; }
        /* an unclosed run of backticks is the characters */
        var ticks = 0;
        while (s.charAt(i + ticks) === '`') ticks++;
        buf += s.slice(i, i + ticks);
        i += ticks;
        continue;
      }
      if (c === '[' && !noLinks) {
        var lk = linkAt(s, i);
        if (lk) { flush(); out.push({ t: 'link', href: lk.href, k: inline(lk.label, true) }); i = lk.end; continue; }
      }
      if (c === '*' || c === '_') {
        var em = emphasisAt(s, i);
        if (em) {
          flush();
          var kids = inline(em.inner, noLinks);
          if (em.run === 1) out.push({ t: 'em', k: kids });
          else if (em.run === 2) out.push({ t: 'strong', k: kids });
          else out.push({ t: 'em', k: [{ t: 'strong', k: kids }] });
          i = em.end;
          continue;
        }
      }
      if (!noLinks && (c === 'h' || c === 'H' || c === 'w' || c === 'W') && (prev === '' || LEAD_RX.test(prev))) {
        var u = urlAt(s, i);
        if (u) { flush(); out.push({ t: 'link', href: u.href, k: [{ t: 'text', s: u.text }] }); i = u.end; continue; }
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  /* ------------------------------------------------------------- blocks */

  var FENCE_RX = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
  var HEADING_RX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
  var HR_RX = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  var QUOTE_RX = /^ {0,3}>[ ]?(.*)$/;
  var ITEM_RX = /^( {0,3})([-*+]|\d{1,9}[.)])(?:( +)(.*)|[ \t]*$)/;
  var INDENT_RX = /^(?: {4}|\t)(.*)$/;

  function isBlank(line) {
    return !/\S/.test(line);
  }

  /** Does this line START a block of its own, so a paragraph before it
      ends here? A numbered item interrupts a paragraph only from 1, so a
      number at the start of a line inside a paragraph is not a list (and
      a year is not one anywhere: itemOf). */
  function startsBlock(line) {
    if (FENCE_RX.test(line) || HEADING_RX.test(line) || HR_RX.test(line) || QUOTE_RX.test(line)) return true;
    var it = itemOf(line);
    if (!it) return false;
    if (it.ordered) return it.start === 1;
    return true;
  }

  /** A numbered list may start at any number up to three digits: "3." is
      a list carried on from somewhere, "2019." at the start of a line is a
      year, and reading it as a list would drop it from the excerpt. */
  var ITEM_START_MAX = 999;

  function itemOf(line) {
    if (HR_RX.test(line)) return null;
    var m = ITEM_RX.exec(line);
    if (!m) return null;
    var marker = m[2];
    if (/^\d/.test(marker) && parseInt(marker, 10) > ITEM_START_MAX) return null;
    var spaces = m[3] === undefined ? 1 : m[3].length;
    /* five or more spaces after the marker is one space and an indented
       code block (CommonMark), which is more than a post needs; read it as
       one space so a wide gap still lists */
    if (spaces > 4) spaces = 1;
    var content = m[4] === undefined ? '' : (m[3] !== undefined && m[3].length > 4 ? m[3].slice(1) + m[4] : m[4]);
    return {
      ordered: /^\d/.test(marker),
      start: /^\d/.test(marker) ? parseInt(marker, 10) : 1,
      kind: /^\d/.test(marker) ? marker.charAt(marker.length - 1) : marker,
      indent: m[1].length,
      width: m[1].length + marker.length + spaces,
      content: content
    };
  }

  function stripIndent(line, width) {
    var k = 0;
    var col = 0;
    while (k < line.length && col < width) {
      var c = line.charAt(k);
      if (c === ' ') col++;
      else if (c === '\t') col += 4 - (col % 4);
      else break;
      k++;
    }
    return line.slice(k);
  }

  function indentOf(line) {
    var col = 0;
    for (var k = 0; k < line.length; k++) {
      var c = line.charAt(k);
      if (c === ' ') col++;
      else if (c === '\t') col += 4 - (col % 4);
      else break;
    }
    return col;
  }

  /** The block tree of a text: paragraphs, headings, quotes, lists, code
      blocks and rules, in the order they are written. */
  function blocks(lines) {
    var out = [];
    var i = 0;
    var n = lines.length;
    while (i < n) {
      var line = lines[i];
      if (isBlank(line)) { i++; continue; }
      var m;
      /* a fenced code block, to the closing fence or the end */
      if ((m = FENCE_RX.exec(line))) {
        var fence = m[1];
        var body = [];
        i++;
        while (i < n && !(new RegExp('^ {0,3}' + fence.charAt(0) + '{' + fence.length + ',}[ \\t]*$').test(lines[i]))) {
          body.push(lines[i]);
          i++;
        }
        if (i < n) i++;
        out.push({ t: 'pre', s: body.join('\n') });
        continue;
      }
      /* an indented code block: consecutive indented lines, blank lines
         inside it kept while an indented line follows */
      if (INDENT_RX.test(line)) {
        var code = [];
        while (i < n && (INDENT_RX.test(lines[i]) || isBlank(lines[i]))) {
          if (isBlank(lines[i])) {
            var k = i;
            while (k < n && isBlank(lines[k])) k++;
            if (k >= n || !INDENT_RX.test(lines[k])) break;
            for (; i < k; i++) code.push('');
            continue;
          }
          code.push(INDENT_RX.exec(lines[i])[1]);
          i++;
        }
        out.push({ t: 'pre', s: code.join('\n') });
        continue;
      }
      if (HR_RX.test(line)) { out.push({ t: 'hr' }); i++; continue; }
      if ((m = HEADING_RX.exec(line))) {
        out.push({ t: 'h', level: m[1].length, k: inline(String(m[2] || '').trim()) });
        i++;
        continue;
      }
      if (QUOTE_RX.test(line)) {
        var inner = [];
        var lazy = false;
        while (i < n) {
          var q = QUOTE_RX.exec(lines[i]);
          if (q) { inner.push(q[1]); lazy = !isBlank(q[1]) && !startsBlock(q[1]); i++; continue; }
          /* a line without the marker carries a paragraph on, as it does
             on the site the toolbar copies */
          if (lazy && !isBlank(lines[i]) && !startsBlock(lines[i])) { inner.push(lines[i]); i++; continue; }
          break;
        }
        out.push({ t: 'quote', b: blocks(inner) });
        continue;
      }
      var item = itemOf(line);
      if (item) {
        var list = { t: item.ordered ? 'ol' : 'ul', start: item.start, items: [], loose: false };
        var kind = item.kind;
        while (i < n) {
          var it = itemOf(lines[i]);
          if (!it || it.ordered !== item.ordered || it.kind !== kind || it.indent > item.indent + 3) break;
          var itemLines = [it.content];
          i++;
          var sawBlank = false;
          while (i < n) {
            var l2 = lines[i];
            if (isBlank(l2)) {
              /* a blank line inside an item: kept if what follows is still
                 this item, else the list may go on loose */
              var k2 = i;
              while (k2 < n && isBlank(lines[k2])) k2++;
              if (k2 < n && indentOf(lines[k2]) >= it.width) {
                for (; i < k2; i++) itemLines.push('');
                list.loose = true;
                continue;
              }
              var next = k2 < n ? itemOf(lines[k2]) : null;
              if (next && next.ordered === item.ordered && next.kind === kind && next.indent <= item.indent + 3) list.loose = true;
              sawBlank = true;
              i = k2;
              break;
            }
            if (indentOf(l2) >= it.width) { itemLines.push(stripIndent(l2, it.width)); i++; continue; }
            /* the next item, or something that is not this item's */
            if (itemOf(l2) || startsBlock(l2)) break;
            /* a lazy continuation of the item's paragraph */
            if (!isBlank(itemLines[itemLines.length - 1])) { itemLines.push(l2.replace(/^\s+/, '')); i++; continue; }
            break;
          }
          list.items.push(blocks(itemLines));
          if (sawBlank && (i >= n || !itemOf(lines[i]))) break;
        }
        out.push(list);
        continue;
      }
      /* a paragraph: to a blank line or the next block. An indented line
         carries a paragraph on rather than starting code inside it, as it
         does everywhere Markdown is read. */
      var para = [line.replace(/^\s+|\s+$/g, '')];
      i++;
      while (i < n && !isBlank(lines[i]) && !startsBlock(lines[i])) {
        para.push(lines[i].replace(/^\s+|\s+$/g, ''));
        i++;
      }
      out.push({ t: 'p', k: inline(para.join('\n')) });
    }
    return out;
  }

  function parse(text) {
    var s = String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n');
    return blocks(s.split('\n'));
  }

  /* ----------------------------------------------------------- emitters */

  var LINK_ATTRS = ' target="_blank" rel="noopener noreferrer nofollow"';

  function inlineHTML(toks) {
    var out = '';
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.t === 'text') out += esc(t.s).replace(/\n/g, '<br>');
      else if (t.t === 'code') out += '<code>' + esc(t.s) + '</code>';
      else if (t.t === 'strong') out += '<strong>' + inlineHTML(t.k) + '</strong>';
      else if (t.t === 'em') out += '<em>' + inlineHTML(t.k) + '</em>';
      else if (t.t === 'link') out += '<a href="' + esc(t.href) + '"' + LINK_ATTRS + '>' + inlineHTML(t.k) + '</a>';
    }
    return out;
  }

  /** A heading in a post is a heading INSIDE the post: the thread's title
      is the page's h1 and the answers band its h2, so the largest a post
      gets is an h3. `#` and `##` are both that one (the toolbar writes
      `##`, the way the site the owner named does, and a reader who types
      `#` means the same thing), and the levels step down from there. */
  function headingTag(level) {
    return 'h' + Math.min(6, Math.max(3, level + 1));
  }

  function blocksHTML(bs, tight) {
    var out = '';
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (b.t === 'p') out += tight && bs.length === 1 ? inlineHTML(b.k) : '<p>' + inlineHTML(b.k) + '</p>';
      else if (b.t === 'h') { var tag = headingTag(b.level); out += '<' + tag + '>' + inlineHTML(b.k) + '</' + tag + '>'; }
      else if (b.t === 'quote') out += '<blockquote>' + blocksHTML(b.b) + '</blockquote>';
      else if (b.t === 'pre') out += '<pre><code>' + esc(b.s) + '</code></pre>';
      else if (b.t === 'hr') out += '<hr>';
      else if (b.t === 'ul' || b.t === 'ol') {
        out += b.t === 'ol' && b.start !== 1 ? '<ol start="' + b.start + '">' : '<' + b.t + '>';
        for (var j = 0; j < b.items.length; j++) out += '<li>' + blocksHTML(b.items[j], !b.loose) + '</li>';
        out += '</' + b.t + '>';
      }
    }
    return out;
  }

  function inlineText(toks) {
    var out = '';
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.t === 'text' || t.t === 'code') out += t.s;
      else out += inlineText(t.k);
    }
    return out;
  }

  function blocksText(bs) {
    var out = [];
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (b.t === 'p' || b.t === 'h') out.push(inlineText(b.k));
      else if (b.t === 'quote') out.push(blocksText(b.b));
      else if (b.t === 'pre') out.push(b.s);
      else if (b.t === 'ul' || b.t === 'ol') {
        var items = [];
        for (var j = 0; j < b.items.length; j++) items.push(blocksText(b.items[j]));
        out.push(items.join('\n'));
      }
    }
    return out.join('\n\n');
  }

  /** The post as markup, every character of the reader's own words escaped
      at emission. An empty post is an empty string. */
  function html(text) {
    return blocksHTML(parse(text));
  }

  /** The post as the words a reader sees: the markers gone, the link
      labels kept, the code kept, a rule dropped. What an excerpt is cut
      from and what a quoted passage is checked against. */
  function plain(text) {
    return blocksText(parse(text));
  }

  /** What a guard refuses in the text AS TYPED or AS READ: the first reason
      `check` gives for either. A contact detail split by a mark passes the
      guard on the bytes and reads whole on the page (jane**@**mit.edu is
      jane@mit.edu once drawn, and once excerpted), so every text a member
      sends is checked both ways, here, by the functions, the page and the
      shim alike. */
  function checkRead(text, check) {
    var s = String(text === null || text === undefined ? '' : text);
    return check(s) || check(plain(s));
  }

  /** Does the text carry any of the markup at all? What the page uses to
      decide whether a preview would show anything the box does not. */
  function hasMarkup(text) {
    var bs = parse(text);
    function inl(toks) {
      for (var i = 0; i < toks.length; i++) if (toks[i].t !== 'text') return true;
      return false;
    }
    function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (b.t !== 'p') return true;
        if (inl(b.k)) return true;
      }
      return false;
    }
    return walk(bs);
  }

  return {
    parse: parse,
    html: html,
    plain: plain,
    hasMarkup: hasMarkup,
    checkRead: checkRead,
    esc: esc
  };
}));
