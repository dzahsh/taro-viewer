/* ============================================================================
 * site.js — shared data layer (LIVE).
 *
 * Queries TARO directly from the browser on page load:
 *   - repository directory  -> OAI ListSets (falls back to data/repositories.json)
 *   - a repository's aids    -> Search API ?repository=<slug>
 *   - global search          -> Search API ?text=
 *   - a finding aid's EAD     -> raw EAD at /admin/<slug>/<file> (see aid.html)
 *
 * TARO sends permissive CORS headers, so these calls work from any static host
 * (GitHub Pages, GitHub Enterprise Pages, S3, etc.) with no server or runner.
 *
 * The JSON under data/ is used only as a fallback if a live request fails, so
 * the directory and a seeded repository still render offline. It is optional.
 * ==========================================================================*/

export const CONFIG = {
  DATA: "./data",
  OAI: "https://www.txarchives.org/oai/",
  SEARCH_API: "https://www.txarchives.org/api/finding_aid/search/",
  ADMIN_BASE: "https://www.txarchives.org/admin",
  DISPLAY_BASE: "https://txarchives.org",
  LOGO: "https://txarchives.org/static/media/taro_logo.971efd0fb301ed63347b.png",
};

const OAI_NS = "http://www.openarchives.org/OAI/2.0/";

export const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );

export function debounce(fn, ms = 150) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export async function loadJSON(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

/* ----------------------------- OAI helpers ------------------------------ */

async function fetchXML(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/xml" } });
    } catch (e) {
      throw e; // network / CORS failure — retrying won't help, fail fast
    }
    try {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.getElementsByTagName("parsererror").length) throw new Error("Malformed XML");
      return doc;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

const nsText = (el, ns, name) => {
  const n = el.getElementsByTagNameNS(ns, name)[0];
  return n ? n.textContent.trim() : "";
};
const nsAll = (el, ns, name) =>
  [...el.getElementsByTagNameNS(ns, name)].map((n) => n.textContent.trim()).filter(Boolean);

// Build the next-page URL from a resumptionToken, handling both the
// already-percent-encoded form and the decoded form TARO might return.
function nextTokenUrl(doc, verb) {
  const t = doc.getElementsByTagNameNS(OAI_NS, "resumptionToken")[0];
  const tok = t ? t.textContent.trim() : "";
  if (!tok) return null;
  let q;
  if (/%[0-9A-Fa-f]{2}/.test(tok)) q = tok;              // already encoded
  else if (/[&=]/.test(tok)) q = encodeURIComponent(tok); // decoded -> encode
  else q = tok;
  return `${CONFIG.OAI}?verb=${verb}&resumptionToken=${q}`;
}

/* --------------------------- repositories ------------------------------- */

function cleanRepos(sets) {
  const map = new Map();
  for (const s of sets) {
    if (/^test$/i.test(s.name)) continue; // drop placeholder "Test" set
    const cur = map.get(s.slug);
    if (!cur || cur.name.length < s.name.length) map.set(s.slug, s); // keep richer name
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadRepositoriesLive() {
  let url = `${CONFIG.OAI}?verb=ListSets`;
  const sets = [];
  let guard = 0;
  while (url && guard++ < 50) {
    const doc = await fetchXML(url);
    for (const el of doc.getElementsByTagNameNS(OAI_NS, "set")) {
      const slug = nsText(el, OAI_NS, "setSpec");
      const name = nsText(el, OAI_NS, "setName");
      if (slug) sets.push({ slug, name: name || slug });
    }
    url = nextTokenUrl(doc, "ListSets");
  }
  return cleanRepos(sets);
}

// Live first; fall back to the committed snapshot if the live call fails.
export async function loadRepositories() {
  try {
    const repositories = await loadRepositoriesLive();
    if (repositories.length) return { repositories, source: "live" };
    throw new Error("empty");
  } catch (_) {
    const data = await loadJSON(`${CONFIG.DATA}/repositories.json`);
    const repositories = (data.repositories || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    return { repositories, source: "cached" };
  }
}

/* ----------------------- a repository's finding aids -------------------- */

/**
 * List one repository's finding aids via the Search API's repository filter.
 *
 * The Search API is CORS-enabled and (unlike OAI, which is not) can be called
 * from the browser. Its records are also richer than OAI's Dublin Core — they
 * include extents, split subjects, proper dates, and the digital flag — and it
 * returns them in a single request.
 *
 * onProgress(aids, total) is invoked once, for consistency with the progressive
 * renderer in repository.html.
 */
export async function loadRepoAidsLive(slug, repoName = "", { onProgress } = {}) {
  const res = await fetch(`${CONFIG.SEARCH_API}?repository=${encodeURIComponent(slug)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  const want = slug.toLowerCase();
  const aids = (Array.isArray(rows) ? rows : [])
    .filter((r) => r.repository && r.repository.toLowerCase() === want) // enforce the repo
    .map(normalizeAid)
    .sort((a, b) => a.title.localeCompare(b.title));
  if (onProgress) onProgress(aids.slice(), aids.length);
  return { aids, total: aids.length, pages: 1 };
}

// Live first; fall back to a committed per-repo snapshot if present.
export async function loadRepoAids(slug, opts = {}) {
  try {
    const { aids } = await loadRepoAidsLive(slug, opts.repoName || "", opts);
    return { source: "live", aids };
  } catch (_) {
    const data = await loadJSON(`${CONFIG.DATA}/repos/${slug}.json`);
    return { source: "cached", aids: (data.finding_aids || []).map(normalizeAid) };
  }
}

/* ----------------------------- global search ---------------------------- */

export async function liveSearch(text) {
  const res = await fetch(`${CONFIG.SEARCH_API}?text=${encodeURIComponent(text)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : []).map(normalizeAid);
}

/** Full-text search across the *content* of one repository's finding aids. */
export async function liveSearchInRepo(slug, text) {
  const url = `${CONFIG.SEARCH_API}?repository=${encodeURIComponent(slug)}&text=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const rows = await res.json();
  const want = slug.toLowerCase();
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r.repository && r.repository.toLowerCase() === want)
    .map(normalizeAid)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/* ----------------------------- normalization ---------------------------- */

export function normalizeAid(r) {
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []);
  return {
    title: r.title || "Untitled finding aid",
    abstract: r.abstract || "",
    digital: !!r.digital,
    repository: r.repository || "",
    repositoryName: r.repository_name || "",
    filename: r.filename || "",
    identifier: r.taro_identifier || "",
    languages: arr(r.languages),
    creators: arr(r.creators),
    startDates: arr(r.start_dates),
    endDates: arr(r.end_dates),
    inclusiveDates: arr(r.inclusive_dates),
    extents: arr(r.extents),
    subjects: [].concat(arr(r.subject_topics), arr(r.subject_persons), arr(r.subject_organizations)),
    geographic: arr(r.geographic_areas),
    displaySite: r.display_site || "",
    xml: r.xml || "",
    hasLocalEad: !!r.has_local_ead,
    lastModified: r.last_modified || "",
  };
}

export function formatDates(rec) {
  if (rec.inclusiveDates && rec.inclusiveDates.length) {
    return rec.inclusiveDates
      .map((d) => String(d).replace(/(\d{4})\s*-\s*(\d{4})/g, "$1\u2013$2"))
      .join(", ");
  }
  const s = rec.startDates.filter((d) => d && d !== "0")[0];
  const e = rec.endDates.filter((d) => d && d !== "0")[0];
  if (s && e) return `${s}\u2013${e}`;
  return s || e || "";
}

/** The LAST date in the record's list (used in finding-aid lists). */
export function lastDate(rec) {
  const d = rec.inclusiveDates;
  if (d && d.length) return String(d[d.length - 1]).replace(/(\d{4})\s*-\s*(\d{4})/g, "$1\u2013$2");
  const e = rec.endDates.filter((x) => x && x !== "0");
  const s = rec.startDates.filter((x) => x && x !== "0");
  if (s.length && e.length) return `${s[s.length - 1]}\u2013${e[e.length - 1]}`;
  return e[e.length - 1] || s[s.length - 1] || "";
}

/** The LAST extent in the record's list. */
export function lastExtent(rec) {
  return rec.extents.length ? rec.extents[rec.extents.length - 1] : "";
}

/* ----------------------------- URL builders ----------------------------- */

export function repoHref(slug) { return `repository.html?repo=${encodeURIComponent(slug)}`; }

export function aidHref(rec) {
  return `aid.html?${new URLSearchParams({ repo: rec.repository, file: rec.filename }).toString()}`;
}

export function adminXmlUrl(repo, filename, recXml) {
  if (recXml) return recXml.startsWith("http") ? recXml : `https://${recXml}`;
  return `${CONFIG.ADMIN_BASE}/${repo}/${filename}`;
}

export function taroDisplayUrl(rec) {
  if (rec.displaySite) return rec.displaySite.startsWith("http") ? rec.displaySite : `https://${rec.displaySite}`;
  if (rec.repository && rec.filename) return `${CONFIG.DISPLAY_BASE}/${rec.repository}/finding_aids/${rec.filename}`;
  return CONFIG.DISPLAY_BASE;
}

/* ------------------------------ shared chrome --------------------------- */

export function mountMasthead() {
  const host = document.querySelector("[data-masthead]");
  if (!host) return;
  host.innerHTML = `
    <div class="mast-top">
      <a class="mast-brand" href="index.html" aria-label="TARO — home">
        <img class="mast-logo" src="${CONFIG.LOGO}" alt="TARO — Texas Archival Resources Online" />
      </a>
      <span class="spacer"></span>
      <form class="mast-search" role="search" data-global-search>
        <input type="search" name="q" placeholder="Search all finding aids\u2026" aria-label="Search all finding aids" />
        <button type="submit">Search</button>
      </form>
    </div>
    <nav class="mast-nav"><div class="mast-nav-in">
      <a href="index.html">Repositories</a>
      <a href="search.html">Search</a>
      <a href="https://txarchives.org" target="_blank" rel="noopener">TARO &#8599;</a>
    </div></nav>`;
  const form = host.querySelector("[data-global-search]");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (q) location.href = `search.html?q=${encodeURIComponent(q)}`;
  });
}

export function mountFooter() {
  const host = document.querySelector("[data-footer]");
  if (!host) return;
  host.innerHTML = `
    <div class="wrap">
      <div class="disclaimer">
        An independent viewer for finding aids published on
        <a href="https://txarchives.org" rel="noopener">Texas Archival Resources Online (TARO)</a>.
        Descriptions and EAD records are the property of their contributing repositories.
      </div>
      <div>Queried live from the TARO Search &amp; OAI-PMH APIs</div>
    </div>`;
}
