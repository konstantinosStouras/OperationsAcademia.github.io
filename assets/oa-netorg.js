/* ---------------------------------------------------------------------------
   Operations Academia — which university a visitor's network belongs to.

   THE CHART THIS EXISTS FOR, AND WHY IT WAS WRONGLY DECLARED DEAD. The old
   "which universities visited" figures came from Universal Analytics'
   `networkDomain` — a REVERSE-DNS LOOKUP of the visitor's IP address, so a
   reader coming through their university's network resolved to `ox.ac.uk`,
   `mit.edu`, `nus.edu.sg` and was counted there. GA4 removed that dimension
   and offers nothing in its place, which is true and was the whole of what was
   first checked; from it the conclusion was drawn that the figures could never
   be shown again, and the owner was told so. That conclusion was wrong.

   What is true is that a BROWSER cannot see its own reverse-DNS. What it
   overlooks is that nothing says the browser has to: anything server-side
   receives the connection and can see the address it came from. This site has
   Cloud Functions, so it can do for itself exactly what UA used to do for it —
   and rather better, because the answer is checked against the site's OWN
   curated directory of operations departments rather than against whatever
   string an ISP happens to publish.

   THE IP IS NEVER STORED, and that is the design rather than a promise. The
   function resolves the address in memory, keeps the university name, and
   discards everything else; what reaches Firestore is a counter per day per
   university. There is no identifier, no cookie and no per-visitor row —
   consistent with the cookieless posture the rest of the analytics runs under.

   CURATED, NEVER GUESSED. A domain is only ever resolved to a university the
   site already publishes: `data/university-domains.json` is DERIVED from the
   `deptUrl` of the Universities directory, so the domains it knows are the
   ones this site has a department page for, and a domain claimed by two
   universities is dropped rather than picked between. An academic host it does
   not recognise is counted as academic-but-unknown; a commercial or
   residential one is not counted at all — the chart is about universities, and
   an ISP's name is both useless here and closer to personal data than a
   university's is.

   Dual-mode (browser `window.OANetOrg`, Node `require`), so the Cloud
   Function, the builder and the tests share one definition.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OANetOrg = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Multi-part public suffixes under which a university sits one label up:
     `ox.ac.uk` is the university, `ac.uk` is the suffix. Without this list
     every British university would collapse to one entry called "ac.uk".

     It is a CURATED list of the academic suffixes, not a copy of the public
     suffix list: this module only ever has to be right about universities, so
     carrying a 10,000-line dependency that changes monthly would be a large
     liability for no gain. A suffix missing from it makes one country's
     universities resolve a label too short — which the map lookup then simply
     fails to recognise, so the visit is counted as unknown rather than
     mis-attributed. Wrong in the safe direction, and easy to extend. */
  const ACADEMIC_SUFFIXES = [
    'ac.uk', 'ac.at', 'ac.be', 'ac.cn', 'ac.cy', 'ac.il', 'ac.in', 'ac.ir',
    'ac.jp', 'ac.kr', 'ac.nz', 'ac.rs', 'ac.th', 'ac.za', 'ac.ae',
    'edu.ar', 'edu.au', 'edu.br', 'edu.cn', 'edu.co', 'edu.eg', 'edu.gr',
    'edu.hk', 'edu.in', 'edu.lb', 'edu.mx', 'edu.my', 'edu.pe', 'edu.ph',
    'edu.pk', 'edu.pl', 'edu.qa', 'edu.sa', 'edu.sg', 'edu.tr', 'edu.tw',
    'edu.vn',
  ];

  /* A host is ACADEMIC when its suffix says so. This is what lets a visit be
     reported as "a university we have no department page for" rather than
     silently dropped — the difference between "no universities visited" and
     "we could not name them", which is exactly the distinction the rest of
     this analytics pipeline is built to keep. */
  const ACADEMIC_TLD = /^(edu|ac)$/;

  /* NOT UNIVERSITIES, whatever their suffix says.

     `academia.edu` is the one that makes this list necessary rather than
     tidy: it ends in `.edu`, so every suffix rule in this file says it is a
     university, and it is a company. The rest are the hosts a department page
     legitimately sits on — a hosted CMS, a campus map, a social profile —
     which must never become a university's DOMAIN when the map is derived
     from those pages.

     It is a DENYLIST and not an allowlist, and that direction was measured.
     Requiring an academic suffix instead dropped 28 real universities from
     the map — ETH Zurich (ethz.ch), McGill (mcgill.ca), Toronto, Bocconi,
     Erasmus (rsm.nl), TUM, Copenhagen Business School, UCD's Smurfit school —
     because outside the English-speaking world a university is very often on
     a plain national domain. Losing a university silently is the quieter and
     worse failure; a stray hosting domain in the map costs nothing, because
     nobody's IP reverse-resolves to `wordpress.com`. */
  const DENY_DOMAINS = [
    'academia.edu', 'researchgate.net', 'ssrn.com', 'orcid.org',
    'google.com', 'googleusercontent.com', 'gstatic.com', 'blogspot.com',
    'wordpress.com', 'wordpress.org', 'wixsite.com', 'wix.com', 'weebly.com',
    'squarespace.com', 'github.io', 'github.com', 'netlify.app', 'vercel.app',
    'notion.site', 'glitch.me', 'herokuapp.com', 'azurewebsites.net',
    'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'youtube.com',
    'bit.ly', 'tinyurl.com', 't.co', 'forms.gle', 'mailchimp.com',
    'amazonaws.com', 'cloudfront.net', 'akamaitechnologies.com',
  ];

  /** A domain this file must never treat as a university. */
  function isDenied(host) {
    const d = registrableDomain(host);
    return !!d && DENY_DOMAINS.indexOf(d) !== -1;
  }

  /** The registrable domain — `www.sbs.ox.ac.uk` -> `ox.ac.uk`. */
  function registrableDomain(host) {
    let h = String(host || '').trim().toLowerCase();
    if (!h) return '';
    h = h.replace(/\.$/, '');                       // a PTR record's trailing dot
    if (h.indexOf('/') !== -1 || h.indexOf(' ') !== -1) return '';
    if (!/^[a-z0-9.-]+$/.test(h)) return '';        // never a raw IP or junk
    if (/^[\d.]+$/.test(h)) return '';              // an IPv4 literal is not a name
    const parts = h.split('.').filter(Boolean);
    if (parts.length < 2) return '';
    for (const suffix of ACADEMIC_SUFFIXES) {
      if (h === suffix) return '';
      if (h.endsWith('.' + suffix)) {
        const n = suffix.split('.').length + 1;
        if (parts.length < n) return '';
        return parts.slice(-n).join('.');
      }
    }
    return parts.slice(-2).join('.');
  }

  /** Does this host belong to an academic network at all? */
  function looksAcademic(host) {
    const d = registrableDomain(host);
    if (!d || isDenied(d)) return false;
    if (ACADEMIC_TLD.test(d.split('.').slice(-1)[0])) return true;
    return ACADEMIC_SUFFIXES.some((s) => d.endsWith('.' + s));
  }

  /**
   * The university a hostname belongs to, or '' when the site does not
   * publish one for it. `map` is data/university-domains.json.
   *
   * A SUBDOMAIN NEVER MATCHES A DIFFERENT UNIVERSITY. The lookup is on the
   * registrable domain alone, so `some-lab.mit.edu` is MIT and nothing else
   * can claim it; there is no substring or suffix search that could let
   * `notmit.edu` resolve to MIT.
   */
  function universityFor(host, map) {
    const d = registrableDomain(host);
    if (!d || !map) return '';
    const hit = Object.prototype.hasOwnProperty.call(map, d) ? map[d] : '';
    return typeof hit === 'string' ? hit : '';
  }

  /**
   * What a resolved hostname should be COUNTED as:
   *   { university }  a university the site publishes a department page for
   *   { academic }    an academic network we cannot name
   *   null            anything else — never counted, never stored
   *
   * The third case is the important one. A commercial or residential host
   * resolves to an ISP, and an ISP's name in a public file is both useless for
   * this chart and closer to personal data than a university's is: "one visit
   * from BT Broadband" narrows a person far more than "one visit from Oxford".
   * So it is dropped here, before anything is written.
   */
  function classify(host, map) {
    if (isDenied(host)) return null;
    const university = universityFor(host, map);
    if (university) return { university: university };
    if (looksAcademic(host)) return { academic: true };
    return null;
  }

  /* ------------------------------------------------ reading the visitor's IP

     Lives here rather than in the Cloud Function so it can be driven by the
     offline selftest: the function itself is then thin enough to read in one
     sitting, and the one part with edge cases is covered without deploying
     anything. */

  /** One entry of an X-Forwarded-For list, with any port stripped. IPv6 needs
      care: `1.2.3.4:56` is an address and a port, while `2001:db8::1` is all
      address, so a port is only cut when it is bracketed or when there is
      exactly one colon in the whole string. */
  function bareIp(entry) {
    let v = String(entry || '').trim();
    if (!v) return '';
    if (v.charAt(0) === '[') {                       // [2001:db8::1]:443
      const end = v.indexOf(']');
      return end > 0 ? v.slice(1, end).toLowerCase() : '';
    }
    if ((v.match(/:/g) || []).length === 1) v = v.split(':')[0];
    return v.toLowerCase();
  }

  /** A routable address — the only kind worth a reverse lookup. Loopback,
      RFC1918, carrier-grade NAT and link-local are the proxy hops and the
      health checks, and asking DNS about them wastes the lookup budget. */
  function isPublicIp(ip) {
    const v = String(ip || '').trim().toLowerCase();
    if (!v) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) {
      const p = v.split('.').map(Number);
      if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
      if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
      if (p[0] === 192 && p[1] === 168) return false;
      if (p[0] === 169 && p[1] === 254) return false;
      if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;   // CGNAT
      if (p[0] >= 224) return false;                                  // multicast, reserved
      return true;
    }
    if (v.indexOf(':') !== -1 && /^[0-9a-f:.]+$/.test(v)) {
      /* An IPv4-mapped address (`::ffff:10.0.0.1`) is the IPv4 address it
         wraps, and is judged as one — otherwise a private hop written that
         way passed as public and clientIp() picked it over the real visitor. */
      var mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
      if (mapped) return isPublicIp(mapped[1]);
      if (v === '::' || v === '::1') return false;
      if (/^f[cd]/.test(v)) return false;            // fc00::/7 unique-local
      if (/^fe[89ab]/.test(v)) return false;          // fe80::/10 link-local
      return true;
    }
    return false;
  }

  /**
   * The visitor's address, from an X-Forwarded-For header value.
   *
   * THE LAST ROUTABLE ENTRY, not the first, and the reason is spoofing. Cloud
   * Run APPENDS the address it saw to whatever the client sent, so a visitor
   * who sets their own `X-Forwarded-For: 1.2.3.4` produces
   * `1.2.3.4, <their real address>` — reading from the left would take
   * whatever they wrote. Reading from the right takes the entry the
   * INFRASTRUCTURE added, which nothing upstream of it can forge.
   *
   * The worst a spoof could do here is inflate one university's count, since
   * the address is never stored and no visitor is ever identified — but a
   * chart is read as fact, so it should be as hard to move as it cheaply can
   * be.
   */
  function clientIp(forwardedFor) {
    const parts = String(forwardedFor || '').split(',');
    for (let i = parts.length - 1; i >= 0; i--) {
      const ip = bareIp(parts[i]);
      /* an IPv4 address written the IPv6 way is handed on as the IPv4
         address it is: both look-ups below ask about the network, and the
         registry is asked in the form it files the network under */
      const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
      if (isPublicIp(ip)) return mapped ? mapped[1] : ip;
    }
    return '';
  }

  /* ------------------------------------------ the network's REGISTRATION

     WHY A SECOND LOOK-UP EXISTS (owner, 2026-09-29: "these numbers stated
     are too little, are they correct?"). They were correct as counts and
     far too small as a picture. Over the resolver's first month (30 August
     to 28 September 2026) it saw 2,960 visits, reverse DNS answered for 857
     of them (29%) and 158 (5%) could be placed at a university. Reverse DNS
     only names an address whose operator publishes a name for it, and most
     no longer do: an IPv6 address almost never has one, which is how a
     growing share of campus traffic now arrives, and a phone's carrier or a
     cloud VPN names nothing useful.

     Every routable network has a second public record that does not depend
     on anybody publishing a name: its REGISTRATION at the regional internet
     registry, served over RDAP (the successor to WHOIS). Cornell's addresses
     are registered to Cornell University with contacts at cornell.edu,
     Stanford's IPv6 block to Stanford University with contacts at
     stanford.edu, Oxford's IPv6 block with contacts at it.ox.ac.uk, and a
     home broadband range to Comcast or Sky. So when reverse DNS names no
     university, the function asks the registry, and this is the pure half
     that reads the answer (measured against the live registries on
     2026-09-29; the fixtures in the selftest are those answers, trimmed).

     THE SAME RULES AS THE REVERSE LOOK-UP, AND ONE STRICTER:
       - a university is named only through the site's OWN map: the
         registrable domain of a contact address must be a domain the map
         carries, or the registrant's own name must equal a university name
         the map carries, folded for case, accents and a trailing acronym and
         otherwise EXACT. Nothing is guessed from a network's handle or a
         free-text remark;
       - a registration naming TWO universities names neither: it is counted
         as academic and attributed to nobody, the same refusal the map makes
         for a domain two universities claim;
       - a registration whose contacts are at an academic domain the site has
         no page for (a national research network, a university not listed)
         is academic-but-unnamed, exactly as a PTR record under `.edu` is;
       - anything else, a company, an internet provider or a mobile operator,
         is null and nothing is recorded, the rule the rest of this file
         keeps. */

  /** The registrant's name, folded so that case, accents, a leading "The",
      a parenthesised acronym and punctuation do not decide whether two
      spellings are one name. Everything else still must match exactly. */
  function foldName(v) {
    return String(v || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/^the /, '');
  }

  /** What an RDAP answer carries that can name a university: the registrable
      domain of every contact address in it, and the name of every entity it
      calls the REGISTRANT. The walk is bounded (depth and count) because the
      answer comes from outside and is read inside a request. */
  function registrationFacts(rdap) {
    const domains = [];
    const names = [];
    let visited = 0;
    function card(en) {
      const vc = en && Array.isArray(en.vcardArray) && Array.isArray(en.vcardArray[1])
        ? en.vcardArray[1] : [];
      const roles = Array.isArray(en && en.roles) ? en.roles : [];
      for (const prop of vc) {
        if (!Array.isArray(prop)) continue;
        const value = String(prop[3] == null ? '' : prop[3]);
        if (prop[0] === 'email') {
          const m = /@([a-z0-9.-]+)\s*$/i.exec(value);
          const d = m ? registrableDomain(m[1]) : '';
          if (d && !isDenied(d) && domains.indexOf(d) === -1) domains.push(d);
        } else if (prop[0] === 'fn' && roles.indexOf('registrant') !== -1) {
          const n = value.trim().slice(0, 200);
          if (n && names.indexOf(n) === -1) names.push(n);
        }
      }
    }
    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 4) return;
      const list = Array.isArray(node.entities) ? node.entities : [];
      for (const en of list) {
        if (++visited > 200) return;
        card(en);
        walk(en, depth + 1);
      }
    }
    walk(rdap, 0);
    return { domains: domains, names: names };
  }

  /**
   * What a network's REGISTRATION says it should be counted as — the same
   * three answers `classify` gives for a hostname: { university },
   * { academic }, or null. `rdap` is the registry's JSON answer (or null when
   * the look-up failed, which is simply null here); `map` is
   * data/university-domains.json.
   */
  function classifyRegistration(rdap, map) {
    if (!rdap || typeof rdap !== 'object' || !map) return null;
    const facts = registrationFacts(rdap);
    const own = (d) => (Object.prototype.hasOwnProperty.call(map, d) &&
      typeof map[d] === 'string' ? map[d] : '');

    const byDomain = [];
    for (const d of facts.domains) {
      const u = own(d);
      if (u && byDomain.indexOf(u) === -1) byDomain.push(u);
    }
    if (byDomain.length === 1) return { university: byDomain[0] };
    if (byDomain.length > 1) return { academic: true };

    /* the registrant's own name, against the names the map carries */
    const known = {};
    for (const d of Object.keys(map)) {
      const u = map[d];
      if (typeof u !== 'string') continue;
      const f = foldName(u);
      if (!f) continue;
      if (!known[f]) known[f] = [];
      if (known[f].indexOf(u) === -1) known[f].push(u);
    }
    const byName = [];
    for (const n of facts.names) {
      const hit = Object.prototype.hasOwnProperty.call(known, foldName(n)) ? known[foldName(n)] : null;
      if (hit && hit.length === 1 && byName.indexOf(hit[0]) === -1) byName.push(hit[0]);
    }
    if (byName.length === 1) return { university: byName[0] };
    if (byName.length > 1) return { academic: true };

    if (facts.domains.some(looksAcademic)) return { academic: true };
    return null;
  }

  return {
    ACADEMIC_SUFFIXES: ACADEMIC_SUFFIXES,
    DENY_DOMAINS: DENY_DOMAINS,
    isDenied: isDenied,
    registrableDomain: registrableDomain,
    looksAcademic: looksAcademic,
    universityFor: universityFor,
    classify: classify,
    bareIp: bareIp,
    isPublicIp: isPublicIp,
    clientIp: clientIp,
    foldName: foldName,
    registrationFacts: registrationFacts,
    classifyRegistration: classifyRegistration,
  };
}));
