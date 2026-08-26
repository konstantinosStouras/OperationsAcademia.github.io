/* ---------------------------------------------------------------------------
   Operations Academia — a minimal, dependency-free .xlsx writer.

   ONE definition, loaded by BOTH sides, like assets/oa-alert-match.js:

     the browser   <script src="assets/oa-xlsx.js">            -> window.OAXlsx
     the checks    createRequire(...)('.../oa-xlsx.js')        -> module.exports

   so _scraper/selftest.mjs builds a real workbook offline and reads the bytes
   back, rather than trusting that a browser-only file produces a file Excel
   will open. Written in ES5 for the same reason every other dual-mode file
   here is: no build step, no transpiling, no CDN.

   WHY THIS EXISTS RATHER THAN A LIBRARY. The repository has no build step and
   loads nothing from a CDN — a rule the whole site is built on — so SheetJS is
   not available, and a CSV cannot carry what the owner asked for: "any
   deadlines should be marked as Excel date types". A date in a CSV is a string
   that Excel re-reads under the reader's own locale, which is how 05/10/2026
   becomes the tenth of May in Salt Lake City and the fifth of October in
   Coventry — the exact ambiguity `deadlineDay` in jobmarket-sheet.mjs refuses
   to guess at on the way IN. Writing a real workbook is what stops the site
   handing that ambiguity back out.

   LINEAGE. The zip container and the sheet XML are the shape of
   `lab/search-v2/admin/xlsx.js` in the sibling repository (stouras.com), which
   has been writing research workbooks for a while. Keep the two in step in
   SHAPE, not in code — different sites, different data, and this one adds the
   two things that file never needed: DATE cells and clickable links.

   API
     OAXlsx.build(sheets) -> Uint8Array            the .xlsx bytes
     OAXlsx.download(filename, sheets)             browser: save it
     OAXlsx.dateSerial('2026-09-08') -> number     the day as Excel counts them

   `sheets` is [{ name, cols, rows, filter }]:
     name   sheet tab name (sanitised to Excel's rules, <=31 chars, unique)
     cols   optional [{ w }] per-column widths, in Excel "characters"
     rows   array of rows, each an array of cells; row 0 is the header
     filter default true — false skips the header auto-filter (a notes sheet)

   A CELL is one of:
     null / undefined / ''   an EMPTY cell. Never a 0: an empty cell means the
                             posting does not say, and a 0 would be an answer.
     a finite number         a numeric cell
     a boolean               a real Excel boolean, so it reads TRUE/FALSE and
                             still parses as a boolean in pandas and R
     { date: 'YYYY-MM-DD' }  a real DATE cell — a serial under a yyyy-mm-dd
                             format, so it sorts, filters and subtracts as a
                             date whatever locale opens the file
     { link: url, text: s }  a clickable hyperlink cell (text defaults to the
                             URL, so the value stays copy-pasteable)
     anything else           text, as an inline string (no sharedStrings part)
   --------------------------------------------------------------------------- */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OAXlsx = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Excel's own limits, and what this file does about each. Exceeding one does
     not produce an error — it produces a file Excel refuses to open, or opens
     with a repair dialog, which is the worst possible failure for a download a
     reader asked for. So each is enforced here rather than hoped for. */
  var MAX_CELL_CHARS = 32767;   // a cell's text
  var MAX_LINKS = 60000;        // hyperlinks per sheet (the real cap is 65530)
  var MAX_SHEET_NAME = 31;

  /* ---------------------------------------------------- a tiny zip writer

     STORE entries only — no deflate. An .xlsx is a zip of XML, and this one is
     a few hundred kilobytes of it; compressing would need a deflate
     implementation (or CompressionStream, which is not in every browser this
     site still serves) to save a download nobody is waiting on. */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(str) { return new TextEncoder().encode(str); }

  function dosDateTime(d) {
    // MS-DOS date/time, whose epoch is 1980 — a clock set before it would
    // otherwise write a negative year into the header.
    var year = Math.max(1980, d.getFullYear());
    var date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { date: date & 0xFFFF, time: time & 0xFFFF };
  }

  // entries: [{ name, data: Uint8Array }] -> one Uint8Array holding a zip file
  function buildZip(entries, when) {
    var now = dosDateTime(when || new Date());
    var chunks = [], central = [], offset = 0;
    function u16(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
    function u32(v) { return [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]; }
    entries.forEach(function (e) {
      var name = utf8(e.name), data = e.data, crc = crc32(data);
      var common = [].concat(
        u16(20), u16(0x0800 /* the name is UTF-8 */), u16(0 /* STORE */),
        u16(now.time), u16(now.date), u32(crc), u32(data.length), u32(data.length),
        u16(name.length), u16(0)
      );
      var local = new Uint8Array(30 + name.length + data.length);
      local.set([].concat(u32(0x04034B50), common), 0);
      local.set(name, 30);
      local.set(data, 30 + name.length);
      chunks.push(local);
      var cen = new Uint8Array(46 + name.length);
      cen.set([].concat(u32(0x02014B50), u16(20), common,
        u16(0), u16(0), u16(0), u32(0), u32(offset)), 0);
      cen.set(name, 46);
      central.push(cen);
      offset += local.length;
    });
    var cdSize = 0;
    central.forEach(function (c) { cdSize += c.length; });
    var eocd = new Uint8Array(22);
    eocd.set([].concat(
      u32(0x06054B50), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(cdSize), u32(offset), u16(0)
    ), 0);
    var total = offset + cdSize + eocd.length, out = new Uint8Array(total), p = 0;
    chunks.concat(central, [eocd]).forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  /* ------------------------------------------------------------ the dates

     Excel counts days from an epoch of 1899-12-30 — not 1900-01-01, because
     the format inherited a phantom 29 February 1900 from Lotus 1-2-3 and
     shifting the epoch back two days is how every writer squares that. The
     bug only affects the first two months of 1900, which no job posting is
     in, so a single subtraction is exact for everything this site holds.

     UTC on both sides deliberately: the input is an ISO DAY with no time zone,
     and reading it in the browser's local one is how a date west of Greenwich
     lands on the day before. */
  var EPOCH = Date.UTC(1899, 11, 30);
  var DAY_MS = 86400000;

  function dateSerial(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso == null ? '' : iso).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var t = Date.UTC(y, mo - 1, d);
    // an impossible day (31 February) rolls over into the next month; refuse it
    // rather than silently exporting a date the posting never named
    var back = new Date(t);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 ||
        back.getUTCDate() !== d) return null;
    return Math.round((t - EPOCH) / DAY_MS);
  }

  /* -------------------------------------------------------- the sheet XML */

  function xmlEsc(v) {
    return String(v)
      // Excel refuses a file carrying a raw control character
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colLetter(i) {           // 0 -> A, 25 -> Z, 26 -> AA …
    var s = '';
    for (i = i + 1; i > 0; i = Math.floor((i - 1) / 26)) {
      s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    }
    return s;
  }

  /* Excel's own rules for a tab name, plus uniqueness — two sheets sharing a
     name is another file that opens to a repair dialog. */
  function sheetNames(sheets) {
    var seen = Object.create(null);
    return sheets.map(function (s, idx) {
      var base = String((s && s.name) || ('Sheet' + (idx + 1)))
        .replace(/[\[\]*?:\/\\]/g, ' ').replace(/\s+/g, ' ').trim()
        .slice(0, MAX_SHEET_NAME) || ('Sheet' + (idx + 1));
      var name = base, n = 2;
      while (seen[name.toLowerCase()]) {
        var suffix = ' (' + (n++) + ')';
        name = base.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
      }
      seen[name.toLowerCase()] = true;
      return name;
    });
  }

  // style ids, in the order cellXfs declares them below
  var S_BODY = 0, S_HEAD = 1, S_DATE = 2, S_LINK = 3;

  function textCell(ref, v, style) {
    var t = String(v).slice(0, MAX_CELL_CHARS);
    var sp = /^\s|\s$|\n/.test(t) ? ' xml:space="preserve"' : '';
    return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t' + sp + '>' +
      xmlEsc(t) + '</t></is></c>';
  }

  /** One cell. `links` collects the hyperlinks this sheet needs rels for. */
  function cellXml(ref, v, style, links) {
    if (v == null || v === '') return '';
    if (typeof v === 'boolean') {
      return '<c r="' + ref + '" s="' + style + '" t="b"><v>' + (v ? 1 : 0) + '</v></c>';
    }
    if (typeof v === 'number') {
      // NaN and Infinity have no cell type; a number Excel cannot hold is not
      // written as one rather than corrupting the sheet
      return isFinite(v) ? '<c r="' + ref + '" s="' + style + '"><v>' + v + '</v></c>' : '';
    }
    if (v instanceof Date) {
      var iso = isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : '';
      return cellXml(ref, iso ? { date: iso } : '', style, links);
    }
    if (typeof v === 'object') {
      if (v.date != null) {
        var serial = dateSerial(v.date);
        // A date the writer cannot place is carried as the TEXT it was given
        // rather than dropped: the reader still sees what the posting said.
        if (serial == null) return v.date ? textCell(ref, v.date, style) : '';
        return '<c r="' + ref + '" s="' + S_DATE + '"><v>' + serial + '</v></c>';
      }
      if (v.link != null) {
        var url = safeUrl(v.link);
        var label = String(v.text != null && v.text !== '' ? v.text : (url || v.link));
        if (!url) return label ? textCell(ref, label, style) : '';
        if (links.length < MAX_LINKS) links.push({ ref: ref, target: url });
        return textCell(ref, label, links.length <= MAX_LINKS ? S_LINK : style);
      }
      return '';
    }
    return textCell(ref, v, style);
  }

  /* Only http(s) becomes a clickable target. A workbook is opened outside the
     browser's sandbox, so the one thing that must never reach a hyperlink is a
     scheme that does something — the same rule OAList.safeUrl applies to an
     href, applied here because the consequence is larger. */
  function safeUrl(v) {
    var s = String(v == null ? '' : v).trim();
    if (!/^https?:\/\//i.test(s)) return '';
    if (/[\s<>"]/.test(s)) return '';
    return s;
  }

  function sheetXml(sheet, links) {
    var rows = sheet.rows || [];
    var nCols = 0;
    rows.forEach(function (r) { if (r && r.length > nCols) nCols = r.length; });

    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetViews><sheetView workbookViewId="0">' +
      // the header stays put while 500 postings scroll under it
      (rows.length > 1
        ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        : '') +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>';

    if (sheet.cols && sheet.cols.length) {
      xml += '<cols>';
      sheet.cols.forEach(function (c, i) {
        if (c && c.w) {
          xml += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + c.w +
            '" customWidth="1"/>';
        }
      });
      xml += '</cols>';
    }

    xml += '<sheetData>';
    rows.forEach(function (row, ri) {
      xml += '<row r="' + (ri + 1) + '">';
      (row || []).forEach(function (v, ci) {
        xml += cellXml(colLetter(ci) + (ri + 1), v, ri === 0 ? S_HEAD : S_BODY, links);
      });
      xml += '</row>';
    });
    xml += '</sheetData>';

    /* The order of what follows is the SCHEMA's, not a preference: autoFilter
       comes before hyperlinks in CT_Worksheet's sequence, and Excel rejects a
       worksheet whose children are out of order. */
    if (sheet.filter !== false && rows.length > 1 && nCols > 0) {
      xml += '<autoFilter ref="A1:' + colLetter(nCols - 1) + rows.length + '"/>';
    }
    if (links.length) {
      xml += '<hyperlinks>' + links.map(function (h, i) {
        return '<hyperlink ref="' + h.ref + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') + '</hyperlinks>';
    }
    return xml + '</worksheet>';
  }

  function sheetRelsXml(links) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      links.map(function (h, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/' +
          'officeDocument/2006/relationships/hyperlink" Target="' + xmlEsc(h.target) +
          '" TargetMode="External"/>';
      }).join('') +
      '</Relationships>';
  }

  /* numFmtId 164 is the first id available to a file (0-163 are Excel's own
     built-ins). ISO deliberately: the file crosses locales — an applicant in
     Dublin, a committee in Salt Lake City — and yyyy-mm-dd is the one spelling
     neither of them can misread. The CELL is a date either way; this only
     decides how it is drawn. */
  var STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
    '<fonts count="3">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '<font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEAEEF3"/>' +
    '<bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">' +
    '<alignment vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs>' +
    // the schema's order is cellXfs then cellStyles, and a workbook without a
    // named Normal style loads with a warning in some readers
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function build(sheets, opts) {
    if (!sheets || !sheets.length) sheets = [{ name: 'Sheet1', rows: [] }];
    var names = sheetNames(sheets);
    var linksPerSheet = sheets.map(function () { return []; });
    var sheetXmls = sheets.map(function (s, i) { return sheetXml(s, linksPerSheet[i]); });

    var contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ' +
          'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    var rootRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    var workbook =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map(function (n, i) {
        return '<sheet name="' + xmlEsc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') +
      '</sheets></workbook>';

    var wbRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    var entries = [
      { name: '[Content_Types].xml', data: utf8(contentTypes) },
      { name: '_rels/.rels', data: utf8(rootRels) },
      { name: 'xl/workbook.xml', data: utf8(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(wbRels) },
      { name: 'xl/styles.xml', data: utf8(STYLES) }
    ];
    sheetXmls.forEach(function (xml, i) {
      entries.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(xml) });
      if (linksPerSheet[i].length) {
        entries.push({
          name: 'xl/worksheets/_rels/sheet' + (i + 1) + '.xml.rels',
          data: utf8(sheetRelsXml(linksPerSheet[i]))
        });
      }
    });
    return buildZip(entries, opts && opts.when);
  }

  function download(filename, sheets) {
    var bytes = build(sheets);
    var blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
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
    return bytes.length;
  }

  return {
    build: build,
    download: download,
    dateSerial: dateSerial,
    safeUrl: safeUrl,
    colLetter: colLetter,
    sheetNames: sheetNames,
    MAX_CELL_CHARS: MAX_CELL_CHARS,
    MAX_LINKS: MAX_LINKS
  };
}));
