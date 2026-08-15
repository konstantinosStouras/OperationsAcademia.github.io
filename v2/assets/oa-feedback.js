/* ---------------------------------------------------------------------------
   Operations Academia — feedback, and the maintainer's inbox.

   Modelled on /lit/'s feedback system. A visitor (signed in or not) leaves a
   message and up to five screenshots; the page writes ONE bounded document to
   the Firestore `feedback` collection with a page-generated ticket number, and
   a scheduled job (v2/_scraper/feedback-mailer.mjs) forwards it to the
   maintainer and sends the submitter a copy.

   The loop is closed from the repository: adding
   v2/_feedback-resolutions/<TICKET>.md and pushing it closes the ticket and
   e-mails the submitter what was done. That file is the public record of the
   fix — which is why it must never contain the submitter's name or address
   (this repository is public; the mailer looks those up in Firestore).

   SCREENSHOT BUDGET. A Firestore document is capped at about 1 MB, and a
   base64 data URL is a third larger than the bytes it carries. Images are
   therefore re-encoded to JPEG in the browser, longest side 1400px, and the
   quality is stepped down until the whole batch fits inside SHOT_BUDGET. That
   is the difference between "attach a phone photo" working and the write
   failing with an opaque error.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var MAX_SHOTS = 5;
  var SHOT_BUDGET = 700 * 1024;    // total base64 chars across all screenshots
  var MAX_EDGE = 1400;

  var shots = [];                  // [{ name, dataUrl }]

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.hidden = !on; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function say(msg, kind) {
    var m = $('fb-msg');
    if (!m) return;
    m.textContent = msg || '';
    m.className = 'oa-form-msg' + (kind ? ' is-' + kind : '');
  }

  /* Ticket shape matches /lit/'s so the two systems read the same way in an
     inbox: OA-YYMMDD-XXXX, with no I/O/0/1 to misread over the phone. */
  function makeTicket() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var stamp = String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate());
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var buf = new Uint32Array(4);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    var rnd = '';
    for (var i = 0; i < 4; i++) rnd += alphabet[buf[i] % alphabet.length];
    return 'OA-' + stamp + '-' + rnd;
  }

  /* ------------------------------------------------------------ screenshots */

  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('could not read ' + file.name)); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error(file.name + ' is not an image we can read')); };
        img.onload = function () {
          var scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';                       // JPEG has no alpha
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /** Encode every canvas, dropping quality together until the batch fits. */
  function encodeAll(canvases) {
    var qualities = [0.82, 0.7, 0.58, 0.45, 0.35];
    for (var i = 0; i < qualities.length; i++) {
      var urls = canvases.map(function (c) { return c.toDataURL('image/jpeg', qualities[i]); });
      var total = urls.reduce(function (n, u) { return n + u.length; }, 0);
      if (total <= SHOT_BUDGET) return { urls: urls, quality: qualities[i] };
    }
    return null;
  }

  function renderThumbs() {
    var box = $('fb-thumbs');
    box.innerHTML = '';
    shots.forEach(function (s, i) {
      var fig = document.createElement('figure');
      fig.className = 'oa-thumb';
      fig.innerHTML =
        '<img src="' + s.dataUrl + '" alt="' + esc(s.name) + '">' +
        '<button type="button" aria-label="Remove ' + esc(s.name) + '">&times;</button>';
      fig.querySelector('button').addEventListener('click', function () {
        shots.splice(i, 1);
        renderThumbs();
      });
      box.appendChild(fig);
    });
  }

  function onFiles(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    if (shots.length + files.length > MAX_SHOTS) {
      say('Please attach at most ' + MAX_SHOTS + ' screenshots.', 'err');
      files = files.slice(0, MAX_SHOTS - shots.length);
      if (!files.length) return;
    }
    say('Preparing the screenshots…');
    Promise.all(files.map(shrink))
      .then(function (canvases) {
        var all = shots.map(function (s) { return s.canvas; }).concat(canvases);
        var enc = encodeAll(all);
        if (!enc) {
          say('Those images are too large even after shrinking. Please attach fewer, or crop them.', 'err');
          return;
        }
        shots = all.map(function (c, i) {
          return { name: (shots[i] && shots[i].name) || files[i - shots.length] &&
            files[i - shots.length].name || ('screenshot-' + (i + 1) + '.jpg'),
            canvas: c, dataUrl: enc.urls[i] };
        });
        renderThumbs();
        say('');
      })
      .catch(function (err) { say(err.message, 'err'); });
  }

  /* ------------------------------------------------------------ the inbox */

  function fmtDate(v) {
    var d = v && typeof v.toDate === 'function' ? v.toDate() : (v ? new Date(v) : null);
    if (!d || isNaN(+d)) return '';
    return d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 16);
  }

  function renderInbox(db, tab) {
    var list = $('oa-inbox-list');
    list.innerHTML = '<p class="oa-hint">Loading…</p>';
    db.collection(OAFB.col.feedback).orderBy('createdAt', 'desc').limit(200).get()
      .then(function (snap) {
        var docs = snap.docs.filter(function (d) {
          var s = d.data().status || 'open';
          return tab === 'all' || s === tab;
        });
        if (!docs.length) {
          list.innerHTML = '<p class="oa-hint">Nothing here.</p>';
          return;
        }
        list.innerHTML = '';
        docs.forEach(function (d) {
          var v = d.data();
          var card = document.createElement('article');
          card.className = 'oa-fb-card';
          card.innerHTML =
            '<header>' +
              '<span class="oa-ticket">' + esc(v.ticket || d.id) + '</span> ' +
              '<span class="oa-fb-status is-' + esc(v.status || 'open') + '">' +
                esc(v.status || 'open') + '</span> ' +
              '<span class="oa-hint" style="display:inline">' + esc(fmtDate(v.createdAt)) +
                (v.email ? ' &middot; ' + esc(v.email) : ' &middot; anonymous') + '</span>' +
            '</header>' +
            (v.shots && v.shots.length
              ? '<div class="oa-thumbs">' + v.shots.map(function (u) {
                  return '<a href="' + u + '" target="_blank" rel="noopener"><img src="' + u + '" alt=""></a>';
                }).join('') + '</div>'
              : '') +
            '<p class="oa-fb-body">' + esc(v.message || '') + '</p>' +
            (v.resolution ? '<p class="oa-fb-res"><strong>Resolution:</strong> ' +
              esc(v.resolution) + '</p>' : '') +
            '<p class="oa-hint">Close this ticket by adding ' +
              '<code>v2/_feedback-resolutions/' + esc(v.ticket || d.id) + '.md</code> ' +
              'to the repository &mdash; the submitter is e-mailed automatically.</p>';
          list.appendChild(card);
        });
      })
      .catch(function (err) {
        list.innerHTML = '<p class="oa-form-msg is-err">Could not load the inbox (' +
          esc(err.code || err.message) + ').</p>';
      });
  }

  function wireInbox() {
    OAAccounts.onChange(function () {
      if (!OAAccounts.isAdmin()) { show($('oa-inbox'), false); return; }
      show($('oa-inbox'), true);
      OAFB.ready().then(function (fb) {
        var db = fb.firestore();
        var tabs = $('oa-inbox-tabs');
        tabs.addEventListener('click', function (e) {
          var b = e.target.closest('.oa-tab');
          if (!b) return;
          Array.prototype.forEach.call(tabs.children, function (x) { x.classList.remove('is-on'); });
          b.classList.add('is-on');
          renderInbox(db, b.dataset.tab);
        });
        renderInbox(db, 'open');
      });
    });
  }

  /* -------------------------------------------------------------- wiring */

  function boot() {
    var form = $('oa-fb-form');
    var msg = $('fb-message');

    msg.addEventListener('input', function () {
      $('fb-count').textContent = String(msg.value.length);
    });
    $('fb-shots').addEventListener('change', onFiles);

    function standDown(why) {
      var note = $('oa-offline');
      if (why) note.innerHTML = '<p>' + why + '</p>';
      show(note, true);
      form.querySelectorAll('input, textarea, button').forEach(function (n) { n.disabled = true; });
    }

    if (!window.OAFB || !OAFB.enabled) {
      standDown();
      return;
    }

    // Unlike posting a job, feedback needs no account — so the form is shown
    // to everyone. It still needs Firestore to send, though, and if the SDK
    // never loaded the button would fail only after someone had typed out
    // their whole report. Stand it down before that happens.
    OAAccounts.onChange(function () {
      if (OAAccounts.failed && OAAccounts.failed()) {
        standDown('<strong>We cannot reach the feedback service right now.</strong> ' +
          'If you use an ad blocker, allow <code>gstatic.com</code> and reload. ' +
          'Otherwise please write to ' +
          '<a href="mailto:kostas.stouras@ucd.ie">kostas.stouras@ucd.ie</a>.');
      }
    });

    wireInbox();

    // convenience: prefill from the signed-in account
    OAAccounts.onChange(function (u) {
      if (u && !$('fb-email').value) $('fb-email').value = u.email || '';
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = msg.value.trim();
      if (text.length < 5) {
        say('Please write a little more so we can act on it.', 'err');
        msg.focus();
        return;
      }
      var email = $('fb-email').value.trim();
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        say('That does not look like an e-mail address.', 'err');
        $('fb-email').focus();
        return;
      }

      var btn = $('fb-submit');
      btn.disabled = true;
      say('Sending…');

      var ticket = makeTicket();
      OAFB.ready().then(function (fb) {
        return fb.firestore().collection(OAFB.col.feedback).add({
          ticket: ticket,
          message: text.slice(0, 6000),
          name: $('fb-name').value.trim().slice(0, 160),
          email: email.slice(0, 200),
          shots: shots.map(function (s) { return s.dataUrl; }),
          page: (document.referrer || location.href).slice(0, 400),
          ua: navigator.userAgent.slice(0, 300),
          status: 'open',
          forwarded: false,
          createdAt: fb.firestore.FieldValue.serverTimestamp()
        });
      }).then(function () {
        $('fb-ticket').textContent = ticket;
        $('fb-done-mail').textContent = email
          ? 'We will e-mail you at ' + email + ' when it is dealt with.'
          : 'You did not leave an e-mail address, so we cannot write back — but the ' +
            'message has reached us.';
        show(form, false);
        show($('fb-done'), true);
        $('fb-done').scrollIntoView({ block: 'center', behavior: 'smooth' });
      }).catch(function (err) {
        btn.disabled = false;
        var code = (err && err.code) || '';
        if (code === 'permission-denied') {
          say('Feedback is not switched on yet — the database rules have not been published.', 'err');
        } else if (/longer than|exceeds|invalid-argument/i.test(err.message || '')) {
          say('That message and its screenshots are too large to send. Please attach fewer images.', 'err');
        } else {
          say('We could not send that. Please try again in a moment.' + (code ? ' (' + code + ')' : ''), 'err');
        }
        if (window.console) console.error('feedback:', err);
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
