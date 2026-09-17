/* ---------------------------------------------------------------------------
   Operations Academia: the formatting toolbar, decided once.

   Owner, 2026-09-08, with Stack Exchange's editor beside the forum's ask
   form: "add that standard editing menu when someone composes a new
   question". Owner, 2026-09-17, of a job posting's Comments cell rendered as
   one unbroken wall of prose: "the 'comments' part of a job posting looks
   very bad. We should allow users to use boldface, italics, links and
   whatever. Build a menu for that part within the job posting step, similar
   to the new question's 'body' we have in the OA forum."

   SIMILAR TO is not a second copy of. The toolbar was written inside
   assets/oa-forum.js, bound to that page's own classes; a copy of it beside
   the job form would be the drift oa-countries.js, oa-schools.js,
   oa-news.js and oa-jobnav.js all exist to prevent: two editors writing two
   dialects of one Markdown subset, disagreeing silently the day either is
   touched. So it lives here, and every box a member writes prose into mounts
   THIS module:

     forum.html        a question, an answer, an edit   (assets/oa-forum.js)
     post-a-job.html   the posting's Comments           (assets/oa-jobform.js)
     admin-area.html   the review card's Comments       (assets/oa-jobreview.js)

   WHAT THE BUTTONS WRITE is the Markdown subset assets/oa-forum-markup.js
   READS, the one module on both sides of every text here, so a mark the
   toolbar can make is a mark the page draws, and neither side can learn a
   mark the other does not know.

   WHAT IT DELIBERATELY IS NOT. It is not the forum's guard: check() refuses
   an e-mail address, a telephone number and an ORCID iD, which is a rule
   about an ANONYMOUS room and would be nonsense on a job advertisement that
   names the department's own page. The forum wires its guard beside this
   module; the job form does not, and this file knows nothing about either.
   It is not an image button either: rule 6 of the forum guide forbids
   screenshots, and an image is a fetch from somebody else's host by every
   reader's browser, which would tell that host who read the page and when.

   HOW A BUTTON WRITES. Through execCommand('insertText') where the browser
   has it, so the browser's own undo stack holds the insertion and Ctrl+Z, or
   the Undo button, takes it back; setRangeText is the fallback, with an
   input event dispatched by hand so a live guard and the preview see the
   change. A press on a button does not take the keyboard from the box
   (mousedown is prevented), so the selection the button acts on is still
   there; the toolbar is ONE Tab stop (a roving tabindex, arrows between the
   buttons), and B, I and K with Ctrl or Cmd do what the first three buttons
   do. A second press on a mark takes it off again: bold on bold text unwraps
   it, a quoted block un-quotes.

   THE PREVIEW is drawn from the same html() the page draws a finished text
   by, under the box, and only once the words carry a mark: for a plain
   paragraph it would say what the box already says.

   THE TIPS ROW is one preference for the whole site, kept on the device
   (localStorage 'oa-editor-tips'). It is a preference and nothing about the
   reader, so it is never sent anywhere.

   Written in ES5, in the dual-mode shape every shared module here uses, so
   the selftest can require it in Node and read its tables. Everything that
   touches a document is only ever CALLED in a browser.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OAEditor = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The markup module, read at call time rather than at load: this file is
      loaded beside it on four pages and the order is pinned, but a preview
      is the one thing here that needs it, and a page that somehow lacks it
      must still get a working toolbar rather than a throw on every
      keystroke. */
  function markup() {
    return (typeof window !== 'undefined' && window.OAForumMarkup) || null;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function icon(paths) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  var TIPS_KEY = 'oa-editor-tips';
  var MOD_KEY = /Mac|iPhone|iPad|iPod/.test(
    String((typeof navigator !== 'undefined' && navigator && navigator.platform) || '')
  ) ? 'Cmd' : 'Ctrl';

  var ICON_BOLD = icon('<path d="M7 4h6.5a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 11h7.5a3.5 3.5 0 0 1 0 7H7z"/>');
  var ICON_ITALIC = icon('<path d="M10 4h8"/><path d="M6 20h8"/><path d="M14 4 10 20"/>');
  var ICON_LINK = icon('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>');
  var ICON_QUOTE = icon('<path d="M9 7H5.5A1.5 1.5 0 0 0 4 8.5V12h5v5H6"/><path d="M20 7h-3.5A1.5 1.5 0 0 0 15 8.5V12h5v5h-3"/>');
  var ICON_CODE = icon('<path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/><path d="m14 4-4 16"/>');
  var ICON_OL = icon('<path d="M10 6h10"/><path d="M10 12h10"/><path d="M10 18h10"/><path d="M4 4.5h1.5v4"/><path d="M4 8.5h3"/><path d="M4 14h3l-3 3.5h3"/>');
  var ICON_UL = icon('<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4.5 6h.01"/><path d="M4.5 12h.01"/><path d="M4.5 18h.01"/>');
  var ICON_HEADING = icon('<path d="M5 5v14"/><path d="M13 5v14"/><path d="M5 12h8"/><path d="M19 11v8"/><path d="M17 12.5 19 11"/>');
  var ICON_HR = icon('<path d="M4 12h16"/><path d="M6 6h12"/><path d="M6 18h12"/>');
  var ICON_UNDO = icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 0 12h-3"/>');
  var ICON_REDO = icon('<path d="m15 14 5-5-5-5"/><path d="M20 9h-9a6 6 0 0 0 0 12h3"/>');

  /* the buttons, in their groups; `key` is the letter that does the same
     with Ctrl or Cmd held */
  var TOOLS = [
    [{ cmd: 'bold', label: 'Bold', key: 'B', icon: ICON_BOLD },
     { cmd: 'italic', label: 'Italic', key: 'I', icon: ICON_ITALIC }],
    [{ cmd: 'link', label: 'Link', key: 'K', icon: ICON_LINK },
     { cmd: 'quote', label: 'Blockquote', icon: ICON_QUOTE },
     { cmd: 'code', label: 'Code', icon: ICON_CODE }],
    [{ cmd: 'ol', label: 'Numbered list', icon: ICON_OL },
     { cmd: 'ul', label: 'Bulleted list', icon: ICON_UL },
     { cmd: 'heading', label: 'Heading', icon: ICON_HEADING },
     { cmd: 'hr', label: 'Horizontal rule', icon: ICON_HR }],
    [{ cmd: 'undo', label: 'Undo', icon: ICON_UNDO },
     { cmd: 'redo', label: 'Redo', icon: ICON_REDO }]
  ];

  /* the tips row: what each mark writes, in the toolbar's own order */
  var TIPS = ['**bold**', '*italic*', '[link](https://…)', '> quote', '`code`', '1. list', '- list', '## heading', '---'];

  function tipsHidden() {
    try { return localStorage.getItem(TIPS_KEY) === 'off'; } catch (e) { return false; }
  }

  function toolbarHTML(taId, tipsId) {
    var out = '<div class="oa-editor-tb" role="toolbar" aria-label="Formatting" aria-controls="' + taId + '">';
    TOOLS.forEach(function (group, gi) {
      out += '<span class="oa-editor-group">';
      group.forEach(function (t, ti) {
        var name = t.label + (t.key ? ' (' + MOD_KEY + '+' + t.key + ')' : '');
        out += '<button type="button" class="oa-editor-btn" data-fmt="' + t.cmd + '" title="' + name + '" aria-label="' + name + '" ' +
          'tabindex="' + (gi === 0 && ti === 0 ? '0' : '-1') + '">' + t.icon + '</button>';
      });
      out += '</span>';
    });
    var off = tipsHidden();
    out += '<button type="button" class="oa-editor-tipsbtn" data-fmt="tips" tabindex="-1" aria-expanded="' + (off ? 'false' : 'true') + '" ' +
      'aria-controls="' + tipsId + '">' + (off ? 'Show' : 'Hide') + ' formatting tips</button>';
    return out + '</div>';
  }

  function tipsHTML(id) {
    var out = '<p class="oa-editor-tips" id="' + id + '"' + (tipsHidden() ? ' hidden' : '') + '>';
    TIPS.forEach(function (t) { out += '<span><code>' + esc(t) + '</code></span>'; });
    return out + '<span>A blank line starts a new paragraph</span><span>A web address becomes a link</span></p>';
  }

  function previewHTML(id) {
    return '<div class="oa-editor-preview" id="' + id + '" hidden><p class="oa-editor-preview-h">Preview</p><div class="oa-prose"></div></div>';
  }

  /** Replace [start, end) of the box with `text` and leave [selStart,
      selEnd) selected: through the browser's own insertText, so its undo
      stack holds the change, else by hand with the input event the guard
      and the preview listen for. */
  function replaceRange(ta, start, end, text, selStart, selEnd) {
    ta.focus();
    ta.setSelectionRange(start, end);
    var before = ta.value;
    var done = false;
    try {
      done = !!document.execCommand && (text ? document.execCommand('insertText', false, text) : document.execCommand('delete', false));
    } catch (e) { done = false; }
    /* the fallback only when the browser did NOTHING: a browser that wrote
       less than asked cut the text at the box's maxlength, which is right,
       and writing it again by hand would put the text in twice */
    if (!done || ta.value === before) {
      ta.setRangeText(text, start, end, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var max = ta.value.length;
    ta.setSelectionRange(Math.min(selStart, max), Math.min(selEnd, max));
  }

  /** Wrap the selection in `mark` (or the placeholder, selected, when
      nothing is), and take the mark off again when it is already there. */
  function wrapSel(ta, mark, placeholder) {
    var v = ta.value;
    var s = ta.selectionStart;
    var e = ta.selectionEnd;
    var sel = v.slice(s, e);
    var lead = (sel.match(/^\s*/) || [''])[0];
    var tail = (sel.match(/\s*$/) || [''])[0];
    var core = sel.trim();
    /* the spaces at either end stay outside the marks; a selection that is
       only spaces is no selection, and gets the placeholder after it */
    if (core) { s += lead.length; e -= tail.length; sel = core; }
    else { s = e; sel = ''; }
    var m = mark.length;
    if (sel.length >= 2 * m && sel.slice(0, m) === mark && sel.slice(-m) === mark) {
      var inner = sel.slice(m, -m);
      replaceRange(ta, s, e, inner, s, s + inner.length);
      return;
    }
    /* THE MARKS JUST OUTSIDE THE SELECTION, counted as runs: bold is on
       when two or more stars sit on each side, italic when an odd number
       does (one, or the three of bold italic). So bold on a bold word and
       italic on an italic or a bold-italic word take that mark off, while
       italic on a merely BOLD word wraps it, since taking one star of each
       pair would leave the word broken. A backtick has no runs to read. */
    var ch = mark.charAt(0);
    var rb = 0;
    var ra = 0;
    while (s - rb - 1 >= 0 && v.charAt(s - rb - 1) === ch) rb++;
    while (e + ra < v.length && v.charAt(e + ra) === ch) ra++;
    var on = mark === '`' ? rb === 1 && ra === 1
      : mark === '**' ? rb >= 2 && ra >= 2
        : rb % 2 === 1 && ra % 2 === 1;
    if (sel && on) {
      replaceRange(ta, s - m, e + m, sel, s - m, s - m + sel.length);
      return;
    }
    var text = sel || placeholder;
    replaceRange(ta, s, e, mark + text + mark, s + m, s + m + text.length);
  }

  /** The whole lines the selection touches, as [start, end) of the box. A
      selection ending just after a line break does not reach the next line. */
  function lineSpan(ta) {
    var v = ta.value;
    var s = ta.selectionStart;
    var e = ta.selectionEnd;
    if (e > s && v.charAt(e - 1) === '\n') e--;
    var ls = v.lastIndexOf('\n', s - 1) + 1;
    var le = v.indexOf('\n', e);
    if (le === -1) le = v.length;
    return { start: ls, end: le, caret: s === e };
  }

  /** Put `prefix` on every line the selection touches (a quote, a list, a
      heading), and take it off every line when every line carries one. */
  function prefixLines(ta, prefix, offRx) {
    var span = lineSpan(ta);
    var lines = ta.value.slice(span.start, span.end).split('\n');
    var marked = lines.filter(function (l) { return offRx.test(l); }).length;
    var out;
    if (marked && marked === lines.filter(function (l) { return /\S/.test(l); }).length) {
      out = lines.map(function (l) { return l.replace(offRx, ''); });
    } else {
      var n = 0;
      out = lines.map(function (l) {
        if (!/\S/.test(l) && lines.length > 1) return prefix(l, n, true);
        return prefix(l, n++, false) + l;
      });
    }
    var text = out.join('\n');
    var end = span.start + text.length;
    replaceRange(ta, span.start, span.end, text, span.caret ? end : span.start, end);
  }

  function fenceLines(ta) {
    var span = lineSpan(ta);
    var block = ta.value.slice(span.start, span.end);
    var lines = block.split('\n');
    var fenced = lines.length >= 2 && /^```/.test(lines[0]) && /^```/.test(lines[lines.length - 1]);
    var text = fenced ? lines.slice(1, -1).join('\n') : '```\n' + block + '\n```';
    replaceRange(ta, span.start, span.end, text, span.start, span.start + text.length);
  }

  function insertRule(ta) {
    var v = ta.value;
    var s = ta.selectionStart;
    var e = ta.selectionEnd;
    var before = v.slice(0, s);
    var after = v.slice(e);
    var lead = !before ? '' : /\n\n$/.test(before) ? '' : /\n$/.test(before) ? '\n' : '\n\n';
    var tail = /^\n\n/.test(after) ? '' : /^\n/.test(after) ? '\n' : '\n\n';
    var text = lead + '---' + tail;
    replaceRange(ta, s, e, text, s + text.length, s + text.length);
  }

  function insertLink(ta) {
    var v = ta.value;
    var s = ta.selectionStart;
    var e = ta.selectionEnd;
    var raw = v.slice(s, e);
    var sel = raw.trim();
    /* the spaces at either end of the selection stay where they are */
    if (sel) { s += raw.indexOf(sel); e = s + sel.length; } else { s = e; }
    var label;
    var url;
    var text;
    if (/^(https?:\/\/|www\.)\S+$/i.test(sel)) {
      /* an address selected: the label is what is left to write */
      label = 'link text';
      url = sel;
      text = '[' + label + '](' + url + ')';
      replaceRange(ta, s, e, text, s + 1, s + 1 + label.length);
      return;
    }
    label = sel || 'link text';
    url = 'https://';
    text = '[' + label + '](' + url + ')';
    var at = s + label.length + 3;
    replaceRange(ta, s, e, text, at, at + url.length);
  }

  function applyTool(ta, cmd) {
    if (cmd === 'undo' || cmd === 'redo') {
      ta.focus();
      try { document.execCommand(cmd, false); } catch (e) { /* the keyboard's own undo still works */ }
      return;
    }
    if (cmd === 'bold') wrapSel(ta, '**', 'bold text');
    else if (cmd === 'italic') wrapSel(ta, '*', 'italic text');
    else if (cmd === 'code') {
      if (ta.value.slice(ta.selectionStart, ta.selectionEnd).indexOf('\n') !== -1) fenceLines(ta);
      else wrapSel(ta, '`', 'code');
    } else if (cmd === 'link') insertLink(ta);
    else if (cmd === 'quote') prefixLines(ta, function (l, i, blank) { return blank ? '>' : '> '; }, /^ {0,3}> ?/);
    else if (cmd === 'ul') prefixLines(ta, function (l, i, blank) { return blank ? '' : '- '; }, /^ {0,3}[-*+] /);
    else if (cmd === 'ol') prefixLines(ta, function (l, i, blank) { return blank ? '' : (i + 1) + '. '; }, /^ {0,3}\d{1,9}[.)] /);
    else if (cmd === 'heading') prefixLines(ta, function (l, i, blank) { return blank ? '' : '## '; }, /^ {0,3}#{1,6} /);
    else if (cmd === 'hr') insertRule(ta);
  }

  /** One choice for the page: every box on it (an answer box and an open
      edit box can stand together) follows the switch that was pressed. */
  function toggleTips(btn, tips) {
    if (!tips) return;
    var off = !tips.hidden;
    try { localStorage.setItem(TIPS_KEY, off ? 'off' : 'on'); } catch (e) { /* a preference, nothing more */ }
    Array.prototype.forEach.call(document.querySelectorAll('.oa-editor .oa-editor-tips'), function (row) { row.hidden = off; });
    Array.prototype.forEach.call(document.querySelectorAll('.oa-editor-tipsbtn'), function (b) {
      b.setAttribute('aria-expanded', off ? 'false' : 'true');
      b.textContent = (off ? 'Show' : 'Hide') + ' formatting tips';
    });
  }

  /** The words as the page will draw them, shown once they carry a mark and
      put away while they do not: for a plain paragraph the preview would say
      what the box already says. Without the markup module there is nothing to
      preview WITH, so the preview stays away rather than showing the marks. */
  function paintPreview(prev, ta) {
    var v = String((ta && ta.value) || '');
    var mk = markup();
    var on = !!v.trim() && !!mk && mk.hasMarkup(v);
    prev.hidden = !on;
    prev.querySelector('.oa-prose').innerHTML = on ? mk.html(v) : '';
  }

  /** The toolbar, the shortcuts and the preview on one box. `box` is the
      .oa-editor holding all of them. */
  function wire(box, ta) {
    if (!box || !ta) return;
    var tb = box.querySelector('.oa-editor-tb');
    var tips = box.querySelector('.oa-editor-tips');
    var prev = box.querySelector('.oa-editor-preview');
    function btnOf(node) {
      while (node && node !== tb) {
        if (node.nodeType === 1 && node.hasAttribute('data-fmt')) return node;
        node = node.parentNode;
      }
      return null;
    }
    if (tb) {
      /* a press does not take the keyboard from the box, so the selection
         the button acts on is still there when it acts */
      tb.addEventListener('mousedown', function (e) { if (btnOf(e.target)) e.preventDefault(); });
      tb.addEventListener('click', function (e) {
        var b = btnOf(e.target);
        if (!b) return;
        e.preventDefault();
        var cmd = b.getAttribute('data-fmt');
        if (cmd === 'tips') toggleTips(b, tips);
        else applyTool(ta, cmd);
      });
      /* one Tab stop: the arrows move between the buttons */
      var stops = function () { return Array.prototype.slice.call(tb.querySelectorAll('[data-fmt]')); };
      tb.addEventListener('focusin', function (e) {
        var b = btnOf(e.target);
        if (!b) return;
        stops().forEach(function (x) { x.setAttribute('tabindex', x === b ? '0' : '-1'); });
      });
      tb.addEventListener('keydown', function (e) {
        var list = stops();
        var at = list.indexOf(btnOf(e.target));
        if (at === -1) return;
        var to = -1;
        if (e.key === 'ArrowRight') to = (at + 1) % list.length;
        else if (e.key === 'ArrowLeft') to = (at + list.length - 1) % list.length;
        else if (e.key === 'Home') to = 0;
        else if (e.key === 'End') to = list.length - 1;
        if (to === -1) return;
        e.preventDefault();
        list[to].focus();
      });
    }
    ta.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      var k = String(e.key || '').toLowerCase();
      var cmd = k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'k' ? 'link' : '';
      if (!cmd) return;
      e.preventDefault();
      applyTool(ta, cmd);
    });
    if (prev) {
      var timer = 0;
      ta.addEventListener('input', function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { timer = 0; paintPreview(prev, ta); }, 120);
      });
      paintPreview(prev, ta);
    }
  }

  /* ------------------------------------------------- mounting it on a box

     THE CHROME IS NEVER WRITTEN OUT BY HAND. A page ships a plain labelled
     <textarea> and calls attach() on it, which wraps the box in the toolbar,
     the tips row and the preview from the one definition above. Copying the
     toolbar's markup into post-a-job.html and admin-area.html would have put
     eleven inline SVGs into two more files, and the day a button is added or
     an icon corrected they would be two more places to remember -- which is
     the whole reason this module exists. The cost, stated: a page whose
     scripts never run shows the plain box, which is the right way round (an
     inert row of buttons over a box is worse than no row at all, and these
     forms need their scripts to send anything anyway). */

  function hasClass(node, cls) {
    return !!node && (' ' + String(node.className || '') + ' ').indexOf(' ' + cls + ' ') !== -1;
  }

  /** The .oa-editor a box has been attached inside, or null. */
  function boxOf(ta) {
    var node = ta && ta.parentNode;
    while (node && node.nodeType === 1) {
      if (hasClass(node, 'oa-editor')) return node;
      node = node.parentNode;
    }
    return null;
  }

  /** Wrap `ta` in the editor and wire it. Answers the box, and does nothing
      the second time it is called on the same one. */
  function attach(ta) {
    if (!ta || !ta.parentNode || ta.getAttribute('data-oa-editor') === 'on') return ta || null;
    var id = ta.id || '';
    var tipsId = (id || 'oa-editor') + '-tips';
    var box = ta.ownerDocument.createElement('div');
    box.className = 'oa-editor';
    ta.parentNode.insertBefore(box, ta);
    box.insertAdjacentHTML('afterbegin', toolbarHTML(id, tipsId) + tipsHTML(tipsId));
    /* the box keeps its value across the move: `value` is a property of the
       element, not of where it sits */
    box.appendChild(ta);
    box.insertAdjacentHTML('beforeend', previewHTML((id || 'oa-editor') + '-preview'));
    ta.setAttribute('data-oa-editor', 'on');
    /* the tips row DESCRIBES the box, so a screen reader hears what the marks
       write -- added to whatever the page already had it describing rather
       than replacing it (the job form's own hint is in there) */
    var said = String(ta.getAttribute('aria-describedby') || '').split(/\s+/);
    var out = [];
    for (var i = 0; i < said.length; i++) if (said[i] && out.indexOf(said[i]) === -1) out.push(said[i]);
    if (out.indexOf(tipsId) === -1) out.push(tipsId);
    ta.setAttribute('aria-describedby', out.join(' '));
    wire(box, ta);
    return box;
  }

  /** Repaint the preview of a box whose value was set by a SCRIPT rather than
      typed -- loading a posting into the form to edit it, say. A programmatic
      value change fires no input event, and faking one here would wake every
      other listener on the box (the job form's draft saver among them). */
  function refresh(ta) {
    var box = boxOf(ta);
    var prev = box && box.querySelector('.oa-editor-preview');
    if (prev) paintPreview(prev, ta);
  }

  return {
    TIPS_KEY: TIPS_KEY,
    MOD_KEY: MOD_KEY,
    TOOLS: TOOLS,
    TIPS: TIPS,
    tipsHidden: tipsHidden,
    toolbarHTML: toolbarHTML,
    tipsHTML: tipsHTML,
    previewHTML: previewHTML,
    applyTool: applyTool,
    wire: wire,
    attach: attach,
    refresh: refresh
  };
}));
