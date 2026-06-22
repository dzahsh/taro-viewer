# TARO finding-aid viewer

A static website that browses and renders archival finding aids published on
[Texas Archival Resources Online (TARO)](https://txarchives.org). Three views:

1. **Repository directory** (`index.html`) — every contributing repository.
2. **Repository** (`repository.html?repo=<slug>`) — a searchable, sortable list of that repository's finding aids.
3. **Finding aid** (`aid.html?repo=<slug>&file=<file>.xml`) — the full finding aid, rendered from its EAD.

It is **pure static files** — no server, no build step, no CI runner. It queries
TARO's public APIs directly from the browser on page load, so new repositories
and finding aids appear automatically with nothing to schedule or rebuild.

---

## How it works (live, in the browser)

TARO sends permissive CORS headers, so the page can fetch its data directly:

| View | Source |
| --- | --- |
| Repository directory | OAI-PMH `ListSets` (see CORS note) |
| A repository's finding aids | Search API `?repository=<slug>` |
| Global full-text search | Search API `?text=` |
| A finding aid's full hierarchy | raw EAD at `/admin/<slug>/<file>.xml` |

**CORS note:** the Search API and the raw EAD files send permissive CORS headers,
so the per-repository lists, search, and the finding-aid viewer all work live in
the browser. TARO's **OAI** endpoint does *not* currently send CORS headers, so
the browser can't read it. OAI is only used for the repository **directory**
(`ListSets`); when that call is blocked, the site falls back to the committed
`data/repositories.json` (a snapshot of all repositories). The directory becomes
fully live automatically if TARO adds `Access-Control-Allow-Origin` to the OAI
endpoint. Everything else is already live.

Use `?repository=<slug>` (the full parameter) to filter — not `repo=`, which is
unreliable.

The XML is parsed in the browser with `DOMParser` (see `assets/site.js`). The
finding-aid renderer is the `__BOOT__` function in `aid.html`; it takes an EAD 2002
XML string and is namespace-agnostic.

> **Note:** the Search API is rate-limited to 100 requests/hour for anonymous
> users, which only affects the global search box. Browsing the directory and
> repositories uses OAI, which is separate.

---

## Deploy

Because it's just static files, host it anywhere that serves a folder.

**UT Austin GitHub Enterprise (or any GitHub Pages):** push this folder, then
**Settings → Pages → Source → Deploy from a branch → `main` → `/ (root)`**. This
uses the platform's built-in Pages builder and needs **no Actions runner**. (On
an Enterprise Server the resulting URL is reachable by that instance's users; for
a fully public site, use public github.com.)

**Public github.com:** push to a public repo and set **Settings → Pages → Source
→ Deploy from a branch → `main` → `/ (root)`**. The site is public at
`https://<username>.github.io/<repo>/`.

**Locally:** `python3 -m http.server 8000` then open `http://localhost:8000`
(use a server, not `file://`, so module imports work).

---

## File map

```
index.html         repository directory
repository.html    a repository's finding aids (progressive)
aid.html           the finding-aid viewer (renders EAD)
search.html        global full-text search
assets/taro.css    shared design system + chrome
assets/site.js     shared data layer (live fetch + parse)
data/              optional fallback snapshot (see below)
```

## The `data/` folder is optional

The site is live, so `data/` is **not required**. It is used only as a fallback
if a live request fails: `data/repositories.json` backs the directory, and any
`data/repos/<slug>.json` / cached `data/eads/<slug>/<file>.xml` back those views.
You can keep it as an offline safety net or delete it.

## Optional: a pre-rendered snapshot (no live calls)

If you ever want the site to serve from a fixed snapshot instead of querying TARO
live (e.g., to pin a moment in time, or if CORS ever changes), the repo includes a
dependency-free harvester and GitHub Actions workflows under `scripts/` and
`.github/`. These require an Actions runner. On an Enterprise Server without
runners you can instead run the harvester on your own computer and commit the
output:

```bash
node scripts/harvest.mjs          # writes data/*.json (+ utaaa EAD)
```

For the live site, you don't need any of that — `scripts/` and `.github/` can be
deleted.

## Customizing

- **Branding** — masthead/footer markup is in `mountMasthead()` / `mountFooter()`
  in `assets/site.js`; colors and type are CSS variables at the top of
  `assets/taro.css`.
- **The finding-aid rendering** — the `__BOOT__` function inside `aid.html`.
