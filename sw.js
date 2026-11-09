/* aeden.me's service worker. It makes a refresh, which means "next design", open the
   next design at once. The design (and its strategy) is public/designs/README.md §10;
   how to turn it off is in worker/README.md ("The service worker").

   kit/warm.js registers it, on aeden.me only (or with localStorage "aeden:sw" = "1"),
   and tells it, at idle on every page, which files the next design will need.

   - Pages ("/" and /designs/<slug>/) come from the network, through navigation
     preload, and are kept. A kept page is answered from the cache only while it is
     younger than 10 minutes (GitHub Pages' own max-age=600, so never staler than the
     browser's cache would be), with two exceptions, for up to a day: "/" on a reload,
     and any page on back or forward (where the browser's cache would show whatever
     it has). The reload of "/" exists only to run roulette.js, which stops it at once
     and moves on to the next design, whose page was prefetched. Whatever comes from
     the cache is refreshed in the background.
   - ?v= and /static/ URLs are content-hashed, so they are cache-first.
   - Everything else goes to the network untouched, as if there were no worker: other
     same-origin files (the stats JSON, /llms.txt, unversioned images), the tracker
     (/aeden.js?v=6, versioned by hand), other origins, anything but GET, Range
     requests, /api/, /cdn-cgi/, /dashboard and the beacons.
   - Each build stamps VERSION, so a deploy changes this file and the browser installs
     the new worker on the next visit. It takes over once none of the visitor's aeden.me
     pages is using the old one (no skipWaiting: a worker replaced while it answers a
     navigation can leave that navigation hanging), and then deletes every older cache.
     Content doesn't wait for it: pages older than 10 minutes come from the network
     and every file's URL carries its hash, so the old worker serves the new deploy.

   Kill switch: set KILL to true and deploy. The build stamps the same switch into
   kit/warm.js, which unregisters the worker from the first page that loads it (an
   unregistered worker controls no new navigation) and never registers one; the kill
   worker itself, once it takes over, deletes the caches and unregisters too. ?nosw on
   any page does the same for that browser. */
const VERSION = "49e319b2b5"; // stamped by scripts/build-designs.js --dist
const KILL = false;

const PREFIX = "aeden-";
const CACHE = PREFIX + VERSION;
const PAGE_TTL = 10 * 60 * 1000;
const HOP_TTL = 24 * 60 * 60 * 1000;
// "/", "/index.html", "/designs/<slug>/", "/designs/<slug>/index.html"
const PAGE = /^\/(?:index\.html)?$|^\/designs\/[a-z0-9-]+\/(?:index\.html)?$/;
const AT = "x-aeden-cached-at";
const NOSW = /[?&]nosw(?:[=&#]|$)/;
let dead = false; // once ?nosw has removed this worker

// Installing fetches nothing (warm.js hands a new worker its list, with "/", once it
// is ready), and never skips waiting, not even the kill switch: see above.

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && (KILL || k !== CACHE)).map((k) => caches.delete(k)));
      if (KILL) return self.registration.unregister();
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
      await self.clients.claim();
    })()
  );
});

if (!KILL) {
  self.addEventListener("fetch", (e) => {
    const r = e.request;
    if (r.method !== "GET" || r.headers.has("range")) return;
    const u = new URL(r.url);
    if (u.origin !== location.origin) return;
    const p = u.pathname;
    // (the tracker too: /aeden.js?v=6 is versioned by hand, and stays the network's)
    if (/^\/(?:api|cdn-cgi|dashboard)(?:\/|$)/.test(p) || p === "/sw.js" || p === "/aeden.js") return;
    // ?nosw: this browser's escape hatch. Its page and everything that page asks for
    // (the referrer carries the query, also on a design, where the address bar shows
    // "/?nosw") go to the network, and the worker removes itself.
    if (NOSW.test(u.search) || NOSW.test(r.referrer) || dead) {
      if (r.mode === "navigate" && !dead) e.waitUntil(off());
      return;
    }
    if (r.mode === "navigate") {
      if (PAGE.test(p)) e.respondWith(page(e, p.replace(/index\.html$/, "")));
      return;
    }
    if (u.searchParams.has("v") || p.startsWith("/static/")) e.respondWith(asset(e));
  });

  // The prefetch keeps this worker busy for at most 4 s (the fetches carry on): a new
  // version waiting to take over (a deploy) waits for the old one's work to end, and
  // pages navigating meanwhile wait with it.
  self.addEventListener("message", (e) => {
    const list = e.data && e.data.prefetch;
    if (Array.isArray(list)) e.waitUntil(Promise.race([prefetch(list.slice(0, 64)), new Promise((ok) => setTimeout(ok, 4000))]));
  });
}

// A cache lookup that can't hold an answer up: the cache storage is shared with any
// other worker of this site (a new one installing, an old one finishing), and when it
// is slow to answer, the network is the better bet. Null on a miss, error or timeout.
function quick(p) {
  return Promise.race([Promise.resolve(p).then((x) => x || null, () => null), new Promise((ok) => setTimeout(() => ok(null), 1000))]);
}

async function page(e, key) {
  const c = await quick(caches.open(CACHE));
  const hit = c && (await quick(c.match(key)));
  const age = hit ? Date.now() - Number(hit.headers.get(AT) || 0) : Infinity;
  // Chrome and Firefox mark a plain reload no-cache, and back or forward force-cache
  // (where the browser's own cache would show any copy it has, however old). Safari
  // marks every navigation default, so there only the 10 minutes apply. A hard reload
  // skips the worker altogether.
  const mode = e.request.cache;
  const reload = mode === "no-cache" || mode === "reload";
  const back = mode === "force-cache" || mode === "only-if-cached";
  if (hit && (age < PAGE_TTL || ((back || (key === "/" && reload)) && age < HOP_TTL))) {
    e.waitUntil(refresh(e, c, key));
    return hit;
  }
  try {
    const res = (await e.preloadResponse) || (await fetch(e.request));
    if (c && good(res)) e.waitUntil(c.put(key, stamp(res.clone())).catch(() => {}));
    return res;
  } catch (err) {
    if (hit) return hit; // offline: the last copy beats an error page
    throw err;
  }
}

// The copy just served from the cache, brought up to date for next time with the
// navigation preload the browser has already made (a 304 when nothing changed).
async function refresh(e, c, key) {
  try {
    const res = (await e.preloadResponse) || (await fetch(key, { cache: "no-cache" }));
    if (good(res)) await c.put(key, stamp(res));
  } catch (err) {
    /* offline */
  }
}

async function asset(e) {
  const c = await quick(caches.open(CACHE));
  const hit = c && (await quick(c.match(e.request, { ignoreVary: true })));
  if (hit) return hit;
  const res = await fetch(e.request);
  if (c && good(res)) e.waitUntil(c.put(e.request, res.clone()).catch(() => {}));
  return res;
}

// warm.js's list for the next design. Pages are kept with the time they were fetched,
// and fetched again once half their life has gone; hashed files once.
async function prefetch(list) {
  const c = await caches.open(CACHE);
  await Promise.all(
    list.map(async (raw) => {
      try {
        const u = new URL(raw, location.origin);
        if (u.origin !== location.origin) return;
        if (PAGE.test(u.pathname)) {
          const key = u.pathname.replace(/index\.html$/, "");
          const hit = await c.match(key);
          if (hit && Date.now() - Number(hit.headers.get(AT) || 0) < PAGE_TTL / 2) return;
          await keep(c, key);
        } else if (u.searchParams.has("v") || u.pathname.startsWith("/static/")) {
          if (await c.match(u.href, { ignoreVary: true })) return;
          const res = await fetch(u.href, { credentials: "same-origin" });
          if (good(res)) await c.put(u.href, res);
        }
      } catch (err) {
        /* offline, or gone: the page will fetch it */
      }
    })
  );
}

async function keep(c, key) {
  // revalidated (a 304 when nothing changed), so the copy kept is the server's latest
  const res = await fetch(key, { credentials: "same-origin", cache: "no-cache" });
  if (good(res)) await c.put(key, stamp(res));
}

// Only whole, same-origin 200s are kept: never a 404, a redirect or a partial response.
function good(res) {
  return !!res && res.status === 200 && (res.type === "basic" || res.type === "default") && !res.redirected;
}

// A kept page is dated by when the server made it (Date, less any Age from a CDN), not
// by when it was stored: a copy that sat in the HTTP cache first has used up some of
// its 10 minutes. Never later than now, so a slow clock can't make a page look fresher.
function stamp(res) {
  const h = new Headers(res.headers);
  const made = Date.parse(res.headers.get("date") || "") - 1000 * (Number(res.headers.get("age")) || 0);
  h.set(AT, String(Math.min(Date.now(), made || Date.now())));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function off() {
  dead = true;
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith(PREFIX)).map((k) => caches.delete(k)));
  await self.registration.unregister();
}
