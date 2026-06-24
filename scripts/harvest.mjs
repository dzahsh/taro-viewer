#!/usr/bin/env node
/* ============================================================================
 * harvest.mjs — build the static data the site reads.
 *
 *   data/repositories.json      every repository (from OAI ListSets)
 *   data/repos/<slug>.json      a repository's finding aids (from OAI ListRecords)
 *   data/eads/<slug>/<file>.xml  raw EAD, prefetched for repos in FULL_EAD_REPOS
 *
 * Why OAI and not the Search API for enumeration:
 *   - OAI `set=<slug>` scopes reliably to one repository; the Search API's
 *     repository filter is loose in practice (a `repo=` query returned the
 *     wrong repository, and a bare `repository=` returned HTTP 400).
 *   - OAI is a separate service from the rate-limited (100/hr) Search API, so a
 *     full crawl stays within limits.
 *
 * Field derivation:
 *   TARO finding-aid filenames are the numeric id (e.g. urn:taro:utexas.cah.04948
 *   -> 04948.xml), and raw EAD lives at /admin/<slug>/<file>. This convention held
 *   for every Search API record observed. Set ENRICH=1 to additionally confirm
 *   each file via the Search API (slower; counts against the 100/hr limit).
 *
 * No dependencies — uses Node 18+ global fetch and a small OAI/DC text parser.
 *
 * Env (all optional):
 *   FULL_EAD_REPOS=utaaa,smu   prefetch full EAD for these repos (default: utaaa)
 *   MAX_EAD=400                cap prefetched EAD per repo (default 400)
 *   SLUGS=utaaa,ricewrc        only harvest these repos (default: all)
 *   ENRICH=1                   confirm file/xml/facets via the Search API
 *   TARO_API_TOKEN=...         Search API token (only used when ENRICH=1)
 *   THROTTLE_MS=250            delay between OAI page requests
 *   OUT=data                   output directory (default ./data)
 * ==========================================================================*/

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OAI_BASE = "https://www.txarchives.org/oai/";
const SEARCH_API = "https://www.txarchives.org/api/finding_aid/search/";
const ADMIN_BASE = "https://www.txarchives.org/admin";
const DISPLAY_BASE = "https://txarchives.org";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || join(HERE, "..", "data");
const FULL_EAD_REPOS = (process.env.FULL_EAD_REPOS ?? "utaaa")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_EAD = parseInt(process.env.MAX_EAD || "400", 10);
const ONLY = (process.env.SLUGS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ENRICH = process.env.ENRICH === "1";
const TOKEN = process.env.TARO_API_TOKEN || "";
const THROTTLE_MS = parseInt(process.env.THROTTLE_MS || "250", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------- http ---------------------------------- */

async function fetchText(url, { headers = {}, tries = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "taro-viewer-harvester", ...headers } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(800 * (i + 1)); // back off on transient failures
    }
  }
  throw lastErr;
}

/* ------------------------------ tiny XML -------------------------------- */

const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };
function decode(s) {
  return String(s == null ? "" : s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]);
}
const clean = (s) => decode(s).replace(/\s+/g, " ").trim();
const firstText = (xml, re) => { const m = re.exec(xml); return m ? clean(m[1]) : ""; };

function allTags(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(clean(m[1]));
  return out;
}

/* ------------------------------ ListSets -------------------------------- */

function parseSets(xml) {
  const out = [];
  const re = /<set>([\s\S]*?)<\/set>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const slug = firstText(block, /<setSpec>([\s\S]*?)<\/setSpec>/);
    const name = firstText(block, /<setName>([\s\S]*?)<\/setName>/);
    if (slug) out.push({ slug, name: name || slug });
  }
  return out;
}

function cleanRepositories(sets) {
  // Drop placeholder "Test" entries; de-dupe slugs, keeping the richer name.
  const map = new Map();
  for (const s of sets) {
    if (/^test$/i.test(s.name)) continue;
    const cur = map.get(s.slug);
    if (!cur || cur.name.length < s.name.length) map.set(s.slug, s);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ----------------------------- ListRecords ------------------------------ */

function parseRecordsPage(xml) {
  const records = [];
  const re = /<record>([\s\S]*?)<\/record>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const header = (/<header\b([^>]*)>([\s\S]*?)<\/header>/.exec(block)) || [];
    const headerAttrs = header[1] || "";
    const headerBody = header[2] || "";
    if (/status\s*=\s*"deleted"/.test(headerAttrs)) continue; // tombstone
    const identifier = firstText(headerBody, /<identifier>([\s\S]*?)<\/identifier>/);
    const datestamp = firstText(headerBody, /<datestamp>([\s\S]*?)<\/datestamp>/);
    const meta = (/<metadata>([\s\S]*?)<\/metadata>/.exec(block) || [])[1] || "";
    records.push({
      identifier,
      datestamp,
      title: (allTags(meta, "dc:title")[0]) || "",
      creators: allTags(meta, "dc:creator"),
      subjects: allTags(meta, "dc:subject"),
      descriptions: allTags(meta, "dc:description"),
      dates: allTags(meta, "dc:date"),
      languages: allTags(meta, "dc:language"),
      types: allTags(meta, "dc:type"),
      identifiers: allTags(meta, "dc:identifier"),
    });
  }
  const token = (/<resumptionToken[^>]*>([\s\S]*?)<\/resumptionToken>/.exec(xml) || [])[1] || "";
  const size = (/completeListSize="(\d+)"/.exec(xml) || [])[1];
  return { records, token: token.trim(), completeListSize: size ? +size : null };
}

/* --------------------------- field derivation --------------------------- */

// Filename from the identifier's trailing numeric segment (e.g. ...cah.04948 -> 04948.xml).
function fileFromIdentifier(identifier) {
  const tail = String(identifier || "").replace(/\.+$/, "").split(/[.:]/).pop() || "";
  return tail ? `${tail}.xml` : "";
}

// Prefer an explicit finding-aid URL in dc:identifier, if present.
function fileFromDcIdentifiers(ids, slug) {
  for (const v of ids) {
    const m = /\/finding_aids\/([^/\s"']+\.xml)/i.exec(v);
    if (m) return m[1];
    const m2 = new RegExp(`/${slug}/([^/\\s"']+\\.xml)`, "i").exec(v);
    if (m2) return m2[1];
  }
  return "";
}

function recordToAid(slug, repoName, rec) {
  const filename = fileFromDcIdentifiers(rec.identifiers, slug) || fileFromIdentifier(rec.identifier);
  const digital = rec.types.some((t) => /digit/i.test(t)) || rec.identifiers.some((v) => /digital|ark:|doi/i.test(v));
  return {
    title: rec.title || "Untitled finding aid",
    abstract: rec.descriptions[0] || "",
    digital,
    repository: slug,
    repository_name: repoName,
    filename,
    taro_identifier: rec.identifier,
    languages: rec.languages,
    creators: rec.creators,
    start_dates: [],
    end_dates: [],
    inclusive_dates: rec.dates,
    extents: [],
    subject_topics: rec.subjects,
    display_site: filename ? `${DISPLAY_BASE.replace(/^https?:\/\//, "")}/${slug}/finding_aids/${filename}` : "",
    xml: filename ? `${ADMIN_BASE.replace(/^https?:\/\//, "")}/${slug}/${filename}` : "",
    last_modified: rec.datestamp || "",
  };
}

/* ------------------------------- enrich --------------------------------- */

async function enrich(aid) {
  try {
    const headers = TOKEN ? { Authorization: `Token ${TOKEN}` } : {};
    const txt = await fetchText(`${SEARCH_API}?taro_identifier=${encodeURIComponent(aid.taro_identifier)}`, { headers });
    const rows = JSON.parse(txt);
    const r = Array.isArray(rows) ? rows[0] : null;
    if (r) {
      aid.filename = r.filename || aid.filename;
      aid.xml = r.xml || aid.xml;
      aid.display_site = r.display_site || aid.display_site;
      aid.abstract = r.abstract || aid.abstract;
      aid.digital = !!r.digital;
      aid.extents = r.extents || aid.extents;
      aid.start_dates = r.start_dates || [];
      aid.end_dates = r.end_dates || [];
      aid.inclusive_dates = r.inclusive_dates || aid.inclusive_dates;
      aid.subject_topics = r.subject_topics || aid.subject_topics;
      aid.repository_name = r.repository_name || aid.repository_name;
    }
  } catch (_) { /* keep derived values */ }
  await sleep(THROTTLE_MS);
}

/* ----------------------------- harvest one ------------------------------ */

async function harvestRepo(slug, repoName) {
  const aids = [];
  let url = `${OAI_BASE}?verb=ListRecords&metadataPrefix=oai_dc&set=${encodeURIComponent(slug)}`;
  let pages = 0;
  while (url) {
    const xml = await fetchText(url);
    const { records, token } = parseRecordsPage(xml);
    for (const rec of records) if (rec.identifier) aids.push(recordToAid(slug, repoName, rec));
    pages++;
    if (token) {
      // Per the spec: when a token is present, send ONLY verb + resumptionToken.
      const t = /[&=]/.test(token) ? encodeURIComponent(token) : token; // already %-encoded as returned
      url = `${OAI_BASE}?verb=ListRecords&resumptionToken=${t}`;
      await sleep(THROTTLE_MS);
    } else {
      url = null;
    }
  }
  if (ENRICH) for (const a of aids) await enrich(a);

  // De-dupe by identifier; sort by title.
  const byId = new Map();
  for (const a of aids) if (!byId.has(a.taro_identifier)) byId.set(a.taro_identifier, a);
  const list = [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  return { list, pages };
}

async function prefetchEads(slug, aids) {
  let n = 0;
  for (const a of aids) {
    if (n >= MAX_EAD) break;
    if (!a.filename) continue;
    const src = a.xml ? (a.xml.startsWith("http") ? a.xml : `https://${a.xml}`) : `${ADMIN_BASE}/${slug}/${a.filename}`;
    try {
      const xml = await fetchText(src, { tries: 2 });
      if (xml.includes("<ead")) {
        await mkdir(join(OUT, "eads", slug), { recursive: true });
        await writeFile(join(OUT, "eads", slug, a.filename), xml);
        a.has_local_ead = true;
        n++;
      }
    } catch (_) { /* skip; live fetch will be attempted at view time */ }
    await sleep(THROTTLE_MS);
  }
  return n;
}

/* --------------------------------- main --------------------------------- */

async function main() {
  await mkdir(join(OUT, "repos"), { recursive: true });

  console.log("• ListSets …");
  const sets = cleanRepositories(parseSets(await fetchText(`${OAI_BASE}?verb=ListSets`)));
  await writeFile(
    join(OUT, "repositories.json"),
    JSON.stringify({ generated: new Date().toISOString(), source: `${OAI_BASE}?verb=ListSets`, repositories: sets }, null, 2)
  );
  console.log(`  ${sets.length} repositories`);

  const targets = ONLY.length ? sets.filter((s) => ONLY.includes(s.slug)) : sets;
  for (const repo of targets) {
    const { slug, name } = repo;
    try {
      process.stdout.write(`• ${slug} … `);
      const { list, pages } = await harvestRepo(slug, name);
      repo.count = list.length; // finding-aid count shown on the directory cards
      let eadCount = 0;
      if (FULL_EAD_REPOS.includes(slug)) eadCount = await prefetchEads(slug, list);
      await writeFile(
        join(OUT, "repos", `${slug}.json`),
        JSON.stringify({ slug, name, generated: new Date().toISOString(), finding_aids: list }, null, 2)
      );
      console.log(`${list.length} aids (${pages} page${pages === 1 ? "" : "s"})${eadCount ? `, ${eadCount} EAD cached` : ""}`);
      await sleep(THROTTLE_MS);
    } catch (e) {
      console.log(`failed: ${e.message}`);
    }
  }

  // Re-write the directory now that each entry carries a finding-aid count.
  await writeFile(
    join(OUT, "repositories.json"),
    JSON.stringify({ generated: new Date().toISOString(), source: `${OAI_BASE}?verb=ListSets`, repositories: sets }, null, 2)
  );
  console.log("✓ done");
}

main().catch((e) => { console.error(e); process.exit(1); });
