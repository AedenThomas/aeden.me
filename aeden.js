/*!
 * aeden.me first-party analytics tracker
 *
 * Vanilla, dependency-free, and loaded with `defer` from public/index.html on
 * every page. Everything here is wrapped so that a failure anywhere degrades
 * to "no analytics" rather than a broken page: the whole file runs inside one
 * try/catch, every listener is guarded, and nothing awaits the network.
 *
 * What it records, all batched and flushed to /api/visitor/journal:
 *   - page views on load and on SPA route changes (hash and pushState)
 *   - engagement: scroll depth, active vs hidden time, clicks with a selector
 *     and text, rage clicks, dead clicks, text copy, outbound links, résumé
 *     downloads, tab visibility, page exit
 *   - heat: click and mouse positions relative to the nearest stable element's
 *     box (never raw pixels), mouse sampled at ~10 Hz only while moving,
 *     aggregated into 1 % cells before they leave the browser
 *
 * Session replay is rrweb, self-hosted at /vendor/scene.min.js and loaded
 * lazily after the page is idle. Inputs are masked. Chunks go to
 * /api/visitor/frames and land in R2.
 *
 * Identity: the Worker owns an HttpOnly `aeden_vid` cookie. This script keeps
 * a `cid` in localStorage only so the very first batch — before the cookie
 * exists — can be tied to the ones that follow. The session id is derived
 * here with a 30-minute inactivity timeout and shared with the React app via
 * window.__aeden so the employer lookup lands on the same session.
 *
 * Opt out: window.top !== window (framed — the dashboard's heatmap iframe),
 * navigator.webdriver, an `aeden_notrack=1` cookie, or ?aeden_notrack=1 once.
 */
(function () {
  "use strict";

  // Neutral names on purpose. EasyPrivacy and friends block URLs by pattern —
  // "/rrweb-record.min.js" is in the list verbatim, and "collect", "track" and
  // "replay" are well-worn tracker vocabulary — so a visitor running uBlock
  // would lose the recorder, or this whole script, under the obvious names.
  var COLLECT = "/api/visitor/journal";
  var REPLAY = "/api/visitor/frames";
  var RECORDER = "/vendor/scene.min.js";

  var SESSION_MS = 30 * 60 * 1000;   // inactivity timeout
  var FLUSH_MS = 5000;               // event batch cadence
  var REPLAY_FLUSH_MS = 20000;       // replay chunk cadence
  var REPLAY_MIN_BYTES = 8000;       // hold a tiny buffer back rather than
  var REPLAY_HOLD_MS = 60000;        // spending a chunk (and a fetch on replay) on it
  var REPLAY_MAX_BYTES = 180000;     // flush a chunk early past this (uncompressed)
  var BEACON_MAX = 60000;            // Chromium caps sendBeacon payloads at 64 KB
  var MOUSE_MS = 100;                // ~10 Hz
  var IDLE_MS = 5000;                // a gap longer than this is not "active"
  var RAGE_N = 3, RAGE_MS = 1000, RAGE_PX = 30;
  var DEAD_MS = 800;

  try { main(); } catch (_) { /* analytics must never break the page */ }

  function main() {
    if (window.__aeden) return;
    // The design roulette sets this when it redirects on a reload (see
    // public/designs/kit/roulette.js): the page is on its way out, so record nothing.
    if (window.AEDEN_TRACK && window.AEDEN_TRACK.off) return;
    if (window.top !== window.self) return;
    if (navigator.webdriver) return;
    if (/bot|crawl|spider|slurp|headless|lighthouse|prerender/i.test(navigator.userAgent)) return;

    var ls = storage();
    if (/[?&]aeden_notrack=1/.test(location.search)) {
      ls.set("aeden:notrack", "1");
      document.cookie = "aeden_notrack=1; Path=/; Max-Age=31536000; SameSite=Lax";
    }
    if (ls.get("aeden:notrack") === "1" || /(?:^|;\s*)aeden_notrack=1/.test(document.cookie)) return;

    // ?s=<tag> marks where a link was placed (resume, email signature, …) for
    // the places that send no referrer. Read once, then dropped from the
    // address bar so the visitor only ever sees plain aeden.me.
    var srcTag = null;
    var sm = /[?&]s=([A-Za-z0-9_.-]{1,40})(?:&|$)/.exec(location.search);
    if (sm) {
      srcTag = sm[1].toLowerCase();
      var rest = location.search.slice(1).split("&").filter(function (kv) { return kv.split("=")[0] !== "s"; }).join("&");
      tryOr(function () {
        history.replaceState(history.state, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
      }, null);
    }

    // www.aeden.me (the resume's link) hands its tag over in a cookie instead,
    // see worker/src/index.js. Expired on read so a later visit isn't tagged.
    var cm = /(?:^|;\s*)aeden_src=([A-Za-z0-9_.-]{1,40})/.exec(document.cookie);
    if (cm) {
      document.cookie = "aeden_src=; Domain=aeden.me; Path=/; Max-Age=0; Secure; SameSite=Lax";
      if (!srcTag) srcTag = cm[1].toLowerCase();
    }

    var cfg = window.AEDEN_TRACK || {};
    var cid = ls.get("aeden:cid");
    if (!/^[a-f0-9]{32}$/.test(cid || "")) { cid = rid(); ls.set("aeden:cid", cid); }

    /* ------------------------------------------------------------ session */
    var sid = null;
    function touch(now) {
      now = now || Date.now();
      var last = +ls.get("aeden:last") || 0;
      var cur = ls.get("aeden:sid");
      var rotated = false;
      if (!/^[a-f0-9]{32}$/.test(cur || "") || now - last > SESSION_MS) {
        cur = rid();
        ls.set("aeden:sid", cur);
        ls.set("aeden:rseq", "0");
        rotated = true;
      }
      if (now - last > 1000) ls.set("aeden:last", String(now));
      var changed = sid !== null && cur !== sid;
      sid = cur;
      return rotated || changed;
    }
    touch();

    /* --------------------------------------------------------------- env */
    var device = deviceType();
    var env = {
      tz: tryOr(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }, null),
      lang: navigator.language || null,
      sw: screen.width, sh: screen.height,
      dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
      device: device
    };
    function vp() { return { vw: window.innerWidth, vh: window.innerHeight }; }

    /* ------------------------------------------------------------ events */
    var queue = [];      // engagement events awaiting flush
    var heat = {};       // aggregated heat cells awaiting flush
    var heatN = 0;

    function push(ev) {
      ev.at = ev.at || Date.now();
      if (!ev.p) ev.p = page.path;
      queue.push(ev);
      if (queue.length >= 60) flush(false);
    }

    /* --------------------------------------------------------------- page */
    var page = null;     // current page view
    var lastInput = Date.now();
    var visSpanStart = Date.now();
    var visState = document.visibilityState;

    function pathOf() {
      var h = location.hash || "";
      // HashRouter: /#/blog/x -> /blog/x. Anything else is the real pathname, or
      // the page's own path when the address bar hides it (a design shows "/").
      if (h.indexOf("#/") === 0) return h.slice(1).split("?")[0] || "/";
      var p = cfg.path || location.pathname || "/";
      return p.length > 1 ? p.replace(/\/+$/, "") : p;
    }

    function openPage(reason) {
      page = {
        id: rid().slice(0, 16),
        path: pathOf(),
        title: (document.title || "").slice(0, 120),
        started: Date.now(),
        scroll: 0,
        active: 0,
        visible: 0,
        hidden: 0,
        ended: false
      };
      lastInput = page.started;
      visSpanStart = page.started;
      var v = vp();
      push({ t: "pv", id: page.id, p: page.path, title: page.title,
             ref: reason === "load" ? (document.referrer || null) : null,
             src: reason === "load" ? srcTag : null,
             vw: v.vw, vh: v.vh, why: reason });
      customEvent("page_view", { path: page.path });
      measureScroll();
    }

    function closeVisSpan(now) {
      var d = Math.max(0, now - visSpanStart);
      if (visState === "visible") page.visible += d; else page.hidden += d;
      visSpanStart = now;
    }

    function closePage(reason) {
      if (!page || page.ended) return;
      page.ended = true;
      var now = Date.now();
      closeVisSpan(now);
      push({ t: "pe", id: page.id, p: page.path, scroll: page.scroll,
             active: Math.round(Math.min(page.active, page.visible || page.active)),
             visible: Math.round(page.visible), hidden: Math.round(page.hidden),
             dur: now - page.started, why: reason });
    }

    function routeChanged(why) {
      if (!page || pathOf() === page.path) return;
      closePage("nav");
      if (touch()) { /* idle long enough to be a new session — new sid, keep going */ }
      openPage(why || "route");
      snapshotSoon();
    }

    /* ------------------------------------------------------------ scroll */
    var scrollRaf = 0;
    function measureScroll() {
      var doc = document.documentElement;
      var h = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
      if (!h) return;
      var pct = Math.min(100, Math.round((window.scrollY + window.innerHeight) / h * 100));
      if (page && pct > page.scroll) page.scroll = pct;
    }
    on(window, "scroll", function () {
      input();
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(function () { scrollRaf = 0; measureScroll(); });
    }, { passive: true });

    /* ------------------------------------------------------------- active */
    function input() {
      var now = Date.now();
      if (page) page.active += Math.min(now - lastInput, IDLE_MS);
      lastInput = now;
      if (touch(now)) {
        // The session expired while the tab sat idle. Close the old page
        // view against the old session and start fresh, replay included.
        closePage("timeout");
        flush(false);
        openPage("resume");
        snapshotSoon();
      }
    }
    ["keydown", "pointerdown", "touchstart", "wheel"].forEach(function (k) {
      on(document, k, input, { passive: true, capture: true });
    });

    /* --------------------------------------------------------- visibility */
    on(document, "visibilitychange", function () {
      var now = Date.now();
      if (page) closeVisSpan(now);
      visState = document.visibilityState;
      push({ t: "vis", s: visState });
      if (visState === "hidden") flush(true);
    });

    /* -------------------------------------------------------------- exit */
    on(window, "pagehide", function () {
      closePage("hide");
      flush(true);
      flushReplay(true);
    });
    on(window, "pageshow", function (e) {
      if (e.persisted) { touch(); openPage("bfcache"); }
    });

    /* -------------------------------------------------------------- SPA */
    on(window, "hashchange", function () { routeChanged("hash"); });
    on(window, "popstate", function () { setTimeout(function () { routeChanged("pop"); }, 0); });
    ["pushState", "replaceState"].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== "function") return;
      history[m] = function () {
        var r = orig.apply(this, arguments);
        try { routeChanged(m); } catch (_) {}
        return r;
      };
    });

    /* ------------------------------------------------------------ clicks */
    var recent = [];        // for rage detection
    var rageBurstAt = 0;
    var noisy = [];         // nodes that mutate on their own (animations)
    var mutatedAt = 0;      // last "meaningful" mutation

    var mo = tryOr(function () {
      var o = new MutationObserver(function (list) {
        var now = Date.now();
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (m.type === "attributes" && m.attributeName === "style") continue;
          var target = m.target;
          // Scripts and styles being injected into <head> (this file's own
          // recorder included) are not something the visitor can see react.
          if (target === document.head || target === document.documentElement) continue;
          // Mutations on nodes that were already changing before the click
          // (a blinking dot, a cycling greeting) are not a reaction to it.
          if (!page || now - lastClickAt > DEAD_MS) { remember(target, now); continue; }
          if (!isNoisy(target, now)) mutatedAt = now;
        }
      });
      o.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      return o;
    }, null);
    function remember(node, now) {
      noisy.push([node, now]);
      if (noisy.length > 60) noisy.splice(0, noisy.length - 60);
    }
    function isNoisy(node, now) {
      for (var i = noisy.length - 1; i >= 0; i--) {
        if (now - noisy[i][1] > 4000) break;
        var n = noisy[i][0];
        if (n === node || (n.contains && n.contains(node))) return true;
      }
      return false;
    }

    var lastClickAt = 0;
    var lastDead = { sel: null, at: 0 };
    var INTERACTIVE = "a,button,input,select,textarea,label,summary,details,video,audio,iframe," +
      "[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch]," +
      "[role=option],[tabindex],[onclick],[contenteditable],.custom-cursor-clickable";

    on(document, "click", function (e) {
      // composedPath() reaches inside shadow roots (the design dock), where
      // e.target is only the host element.
      var path = (e.composedPath && e.composedPath()) || [];
      var t0 = path[0] && path[0].nodeType ? path[0] : e.target;
      var el = t0 && t0.nodeType === 1 ? t0 : (t0 && t0.parentElement);
      if (!el) return;
      function onPath(q) {
        for (var j = 0; j < path.length; j++) {
          if (path[j].nodeType === 1 && path[j].matches && path[j].matches(q)) return path[j];
        }
        return el.closest ? el.closest(q) : null;
      }
      var now = Date.now();
      lastClickAt = now;
      input();

      var sel = selector(el);
      var txt = textOf(el);
      var link = onPath("a[href]");
      var v = vp();
      push({ t: "click", sel: sel, txt: txt, x: Math.round(e.clientX), y: Math.round(e.clientY),
             vw: v.vw, vh: v.vh });
      heatPoint("c", el, e.clientX, e.clientY);

      // outbound + downloads
      if (link) {
        var href = link.getAttribute("href") || "";
        var u = tryOr(function () { return new URL(link.href, location.href); }, null);
        var isDl = link.hasAttribute("download") || /\.(pdf|docx?|zip)(\?|$)/i.test(href) ||
          /resume|résumé|\bcv\b/i.test(href + " " + txt);
        if (isDl) { push({ t: "dl", href: (u ? u.href : href).slice(0, 300), txt: txt }); customEvent("download", { href: href }); }
        else if (u && u.host && u.host !== location.host && /^https?:/.test(u.protocol)) {
          push({ t: "out", href: u.href.slice(0, 300), txt: txt });
          customEvent("outbound", { href: u.href });
        }
      }

      // rage: N clicks inside RAGE_MS within RAGE_PX of each other
      recent.push([now, e.clientX, e.clientY]);
      while (recent.length && now - recent[0][0] > RAGE_MS) recent.shift();
      if (recent.length >= RAGE_N && now - rageBurstAt > RAGE_MS) {
        var a = recent[0], near = true;
        for (var i = 1; i < recent.length; i++) {
          if (Math.abs(recent[i][1] - a[1]) > RAGE_PX || Math.abs(recent[i][2] - a[2]) > RAGE_PX) { near = false; break; }
        }
        if (near) {
          rageBurstAt = now;
          push({ t: "rage", sel: sel, txt: txt, x: Math.round(e.clientX), y: Math.round(e.clientY), n: recent.length });
          customEvent("rage_click", { sel: sel });
        }
      }

      // dead: a click on something inert that nothing responded to. One per
      // element per burst — a rage click on dead space is already reported
      // as rage, and three more rows would say nothing new.
      var interactive = !!onPath(INTERACTIVE);
      if (!interactive) {
        var href0 = location.href, mutBefore = mutatedAt;
        setTimeout(function () {
          try {
            var selText = window.getSelection ? String(window.getSelection()) : "";
            if (selText) return;                       // they were selecting text
            if (location.href !== href0) return;       // navigated
            if (mutatedAt > mutBefore) return;         // the page reacted
            var t2 = Date.now();
            if (lastDead.sel === sel && t2 - lastDead.at < 1500) return;
            lastDead = { sel: sel, at: t2 };
            push({ t: "dead", sel: sel, txt: txt, x: Math.round(e.clientX), y: Math.round(e.clientY) });
            customEvent("dead_click", { sel: sel });
          } catch (_) {}
        }, DEAD_MS);
      }
    }, { capture: true, passive: true });

    /* -------------------------------------------------------------- copy */
    on(document, "copy", function () {
      var s = tryOr(function () { return String(window.getSelection() || ""); }, "");
      if (!s) return;
      push({ t: "copy", len: s.length, txt: s.replace(/\s+/g, " ").trim().slice(0, 120) });
      customEvent("copy", { len: s.length });
    });

    /* -------------------------------------------------------------- heat */
    var lastMove = 0, lastMX = -1, lastMY = -1;
    on(document, "mousemove", function (e) {
      var now = Date.now();
      if (now - lastMove < MOUSE_MS) return;
      if (Math.abs(e.clientX - lastMX) < 2 && Math.abs(e.clientY - lastMY) < 2) return;
      lastMove = now; lastMX = e.clientX; lastMY = e.clientY;
      input();
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (el) heatPoint("m", el, e.clientX, e.clientY);
    }, { passive: true });

    function heatPoint(kind, el, x, y) {
      var a = anchor(el);
      if (!a) return;
      var r = a.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      var rx = (x - r.left) / r.width, ry = (y - r.top) / r.height;
      if (rx < 0 || rx > 1 || ry < 0 || ry > 1) return;
      var cx = Math.round(rx * 100) / 100, cy = Math.round(ry * 100) / 100;
      var sel = selector(a);
      var key = kind + "|" + page.path + "|" + sel + "|" + cx + "|" + cy;
      var cell = heat[key];
      if (cell) cell.n++;
      else {
        heat[key] = { k: kind, p: page.path, s: sel, x: cx, y: cy, n: 1,
                      w: Math.round(r.width), h: Math.round(r.height) };
        heatN++;
      }
      if (heatN > 400) flush(false);
    }

    /* The element a heat point is measured against. Prefer something that
       survives a redeploy: an id, a landmark, a heading, or the nearest block
       that is big enough to be a "section" of the page. */
    var LANDMARK = /^(SECTION|MAIN|NAV|HEADER|FOOTER|ARTICLE|ASIDE|FORM|TABLE|FIGURE|UL|OL|H1|H2|H3|H4|H5|H6|IMG|A|BUTTON|P|LI|PRE|BLOCKQUOTE|VIDEO|CANVAS|SVG)$/;
    function anchor(el) {
      var n = el, depth = 0;
      while (n && n.nodeType === 1 && n !== document.body && depth < 40) {
        if (n.id) return n;
        if (LANDMARK.test(n.tagName)) {
          var r = n.getBoundingClientRect();
          if (r.width >= 24 && r.height >= 16) return n;
        } else {
          var rr = n.getBoundingClientRect();
          if (rr.height >= 120 && rr.width >= 240) return n;
        }
        n = n.parentElement; depth++;
      }
      return document.body;
    }

    /* Structural selector — ids as shortcuts, tag:nth-of-type otherwise. Class
       names are deliberately left out: Tailwind classes change with every
       hover state and the dashboard has to be able to find the element again. */
    var selCache = window.WeakMap ? new WeakMap() : null;
    function selector(el) {
      var hit = selCache && selCache.get(el);
      if (hit) return hit;
      var out = buildSelector(el);
      if (selCache) selCache.set(el, out);
      return out;
    }
    function buildSelector(el) {
      var parts = [], n = el, depth = 0;
      while (n && n.nodeType === 1 && depth < 14) {
        if (n === document.body) { parts.unshift("body"); break; }
        if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift("#" + n.id); break; }
        var tag = n.tagName.toLowerCase();
        var p = n.parentElement, i = 1;
        if (p) {
          var sib = p.firstElementChild;
          while (sib && sib !== n) { if (sib.tagName === n.tagName) i++; sib = sib.nextElementSibling; }
        }
        parts.unshift(tag + (i > 1 || (p && p.children.length > 1) ? ":nth-of-type(" + i + ")" : ""));
        n = p; depth++;
      }
      return parts.join(">").slice(0, 400);
    }

    function textOf(el) {
      var t = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title"));
      if (!t) {
        var a = el.closest ? el.closest("a,button,[role=button],label,summary,h1,h2,h3,li,p") : null;
        t = (a || el).innerText || (a || el).textContent || "";
      }
      return String(t).replace(/\s+/g, " ").trim().slice(0, 80) || null;
    }

    /* ------------------------------------------------------------- flush */
    var flushTimer = 0;
    function flush(unloading) {
      if (!queue.length && !heatN) return;
      var v = vp();
      var body = {
        v: 1, sid: sid, cid: cid, ts: Date.now(),
        tz: env.tz, lang: env.lang, sw: env.sw, sh: env.sh, dpr: env.dpr, device: env.device,
        vw: v.vw, vh: v.vh,
        events: queue, heat: Object.keys(heat).map(function (k) { return heat[k]; })
      };
      queue = []; heat = {}; heatN = 0;
      send(COLLECT, JSON.stringify(body), "application/json", unloading);
    }
    function schedule() { flushTimer = setTimeout(function () { flush(false); schedule(); }, FLUSH_MS); }

    function send(url, data, type, unloading) {
      try {
        var small = data.length < BEACON_MAX;
        if (small && navigator.sendBeacon) {
          if (navigator.sendBeacon(url, new Blob([data], { type: type }))) return;
        }
        fetch(url, { method: "POST", body: data, keepalive: !!unloading && small, credentials: "same-origin",
                     headers: { "content-type": type } }).catch(function () {});
      } catch (_) {}
    }

    /* ------------------------------------------------------------ replay */
    var rec = null, rbuf = [], rbytes = 0, rfrom = 0, replayTimer = 0, stopRec = null;
    var replayOn = cfg.replay !== false &&
      !(navigator.connection && navigator.connection.saveData) &&
      !(window.matchMedia && matchMedia("(prefers-reduced-data: reduce)").matches);

    function customEvent(tag, payload) {
      try { if (rec) rec.addCustomEvent(tag, payload || {}); } catch (_) {}
    }
    function snapshotSoon() {
      try { if (rec) setTimeout(function () { atRealPath(function () { rec.takeFullSnapshot(true); }); }, 50); } catch (_) {}
    }

    // A design shows "/" in the address bar (public/designs/kit/roulette.js), and
    // rrweb resolves relative URLs (style.css, images) against it, so the replay
    // asked for /style.css and played unstyled. Snapshots run synchronously
    // with the design's real path put back for the duration.
    function atRealPath(fn) {
      var real = cfg.path, shown = location.pathname;
      if (!real || real === shown) return fn();
      var H = history, rs = H.replaceState;
      var url = function (p) { return p + location.search + location.hash; };
      try { rs.call(H, H.state, "", url(real)); } catch (_) { return fn(); }
      try { return fn(); } finally { try { rs.call(H, H.state, "", url(shown)); } catch (_) {} }
    }

    function loadRecorder() {
      if (!replayOn || rec || window.rrwebRecord) { if (window.rrwebRecord) startReplay(); return; }
      var s = document.createElement("script");
      s.src = RECORDER; s.async = true;
      s.onload = function () { try { startReplay(); } catch (_) {} };
      s.onerror = function () { replayOn = false; };
      (document.head || document.body).appendChild(s);
    }

    function startReplay() {
      var R = window.rrwebRecord;
      rec = R && (typeof R === "function" ? R : R.record);
      if (typeof rec !== "function") return;
      stopRec = atRealPath(function () { return rec({
        emit: function (ev) {
          if (!rbuf.length) rfrom = ev.timestamp || Date.now();
          rbuf.push(ev);
          rbytes += approxSize(ev);
          if (rbytes > REPLAY_MAX_BYTES) flushReplay(false);
        },
        maskAllInputs: true,
        maskTextClass: "aeden-mask",
        blockClass: "aeden-noreplay",
        ignoreClass: "aeden-noreplay",
        sampling: { mousemove: 80, mouseInteraction: true, scroll: 150, media: 800, input: "last" },
        slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true,
                          headMetaDescKeywords: true, headMetaSocial: true, headMetaRobots: true,
                          headMetaHttpEquiv: true, headMetaAuthorship: true, headMetaVerification: true },
        recordCanvas: false,
        collectFonts: false,
        inlineStylesheet: true,
        checkoutEveryNms: 10 * 60 * 1000
      }); });
      customEvent("page_view", { path: page.path });
      replayTimer = setInterval(function () { flushReplay(false); }, REPLAY_FLUSH_MS);
    }

    function approxSize(ev) {
      // Full snapshots are the only expensive ones to measure; everything
      // else is small enough that a flat guess is fine.
      if (ev.type === 2 || ev.type === 4) return tryOr(function () { return JSON.stringify(ev).length; }, 50000);
      if (ev.type === 3 && ev.data && ev.data.source === 0) return 400 + (ev.data.adds ? ev.data.adds.length * 200 : 0);
      return 60;
    }

    var lastReplayFlush = 0;
    function flushReplay(unloading) {
      if (!rbuf.length) return;
      // Dribs of a few events each turn into hundreds of chunks over a long
      // session, and every chunk is a row and a read on the dashboard. Hold a
      // small buffer unless it has been sitting a while, or we are leaving.
      var now = Date.now();
      if (!unloading && rbytes < REPLAY_MIN_BYTES && lastReplayFlush &&
          now - lastReplayFlush < REPLAY_HOLD_MS) return;
      lastReplayFlush = now;
      var events = rbuf, from = rfrom;
      rbuf = []; rbytes = 0;
      var seq = (+ls.get("aeden:rseq") || 0) + 1;
      ls.set("aeden:rseq", String(seq));
      var to = events[events.length - 1].timestamp || Date.now();
      var qs = "?sid=" + sid + "&cid=" + cid + "&seq=" + seq + "&from=" + from + "&to=" + to +
        "&n=" + events.length + "&p=" + encodeURIComponent(page ? page.path : "/") +
        "&vw=" + window.innerWidth + "&vh=" + window.innerHeight + "&d=" + env.device;
      var json = JSON.stringify(events);

      if (unloading || !window.CompressionStream || json.length < 4000) {
        // pagehide has no time for async compression — raw JSON via beacon.
        send(REPLAY + qs + "&gz=0", json, "application/json", unloading);
        return;
      }
      try {
        var cs = new CompressionStream("gzip");
        var stream = new Blob([json]).stream().pipeThrough(cs);
        new Response(stream).blob().then(function (blob) {
          fetch(REPLAY + qs + "&gz=1", { method: "POST", body: blob, credentials: "same-origin",
                                         headers: { "content-type": "application/octet-stream" } }).catch(function () {});
        }).catch(function () {
          send(REPLAY + qs + "&gz=0", json, "application/json", false);
        });
      } catch (_) {
        send(REPLAY + qs + "&gz=0", json, "application/json", false);
      }
    }

    /* -------------------------------------------------------------- boot */
    openPage("load");
    schedule();
    // First batch goes out quickly so a bounce still registers as a page view.
    setTimeout(function () { flush(false); }, 1500);
    if (replayOn) {
      var kick = function () {
        if (window.requestIdleCallback) requestIdleCallback(loadRecorder, { timeout: 4000 });
        else setTimeout(loadRecorder, 1500);
      };
      if (document.readyState === "complete") kick(); else on(window, "load", kick);
    }

    window.__aeden = {
      sid: function () { touch(); return sid; },
      cid: cid,
      page: function () { return page ? page.path : pathOf(); },
      track: function (type, meta) {
        if (typeof type !== "string" || !/^[a-z_]{1,32}$/.test(type)) return;
        push({ t: "custom", name: type, meta: meta == null ? null : JSON.stringify(meta).slice(0, 500) });
      },
      flush: function () { flush(false); flushReplay(false); },
      stop: function () {
        clearTimeout(flushTimer); clearInterval(replayTimer);
        try { if (stopRec) stopRec(); } catch (_) {}
        try { if (mo) mo.disconnect(); } catch (_) {}
      }
    };
  }

  /* ----------------------------------------------------------- helpers */
  function on(target, type, fn, opts) {
    target.addEventListener(type, function (e) { try { fn(e); } catch (_) {} }, opts || false);
  }
  function tryOr(fn, fallback) { try { return fn(); } catch (_) { return fallback; } }
  function rid() {
    var b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    var s = "";
    for (var j = 0; j < 16; j++) s += (b[j] < 16 ? "0" : "") + b[j].toString(16);
    return s;
  }
  function storage() {
    var mem = {};
    return {
      get: function (k) { try { return localStorage.getItem(k); } catch (_) { return mem[k] == null ? null : mem[k]; } },
      set: function (k, v) { try { localStorage.setItem(k, v); } catch (_) { mem[k] = v; } }
    };
  }
  function deviceType() {
    var ua = navigator.userAgent || "";
    var coarse = tryOr(function () { return matchMedia("(pointer: coarse)").matches; }, false);
    var w = Math.min(screen.width || 0, window.innerWidth || 0) || window.innerWidth;
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
    if (/Mobi|iPhone|iPod|Android/i.test(ua)) return "mobile";
    if (coarse && w < 768) return "mobile";
    if (coarse && w < 1100) return "tablet";
    return "desktop";
  }
})();
