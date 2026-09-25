// Deterministic image sourcing. Zero model tokens.
//
// REPORTER hands us article URLs; we fetch each page's <head> and lift the
// publisher's own OpenGraph/Twitter card image. Results (including failures)
// are cached on the volume so a given article is fetched at most once.

import fs from "node:fs";
import path from "node:path";

import { newspaperDir } from "./store.js";

const CACHE_FILE = ".images.json";
const MAX_HTML_BYTES = 192 * 1024; // og: tags live in <head>; never read a whole page
const FETCH_TIMEOUT_MS = 6000;
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // retry a miss a week later, not every load
const CONCURRENCY = 8;
const UA =
  "Mozilla/5.0 (compatible; JeevesDaily/1.0; +https://github.com/Jinglejanglejingle96) Chrome/126 Safari/537.36";

let cache = null;
let cachePath = null;
let cacheDirty = false;
const inflight = new Map(); // url -> Promise, so parallel requests fetch once

function loadCache(workspaceDir) {
  const p = path.join(newspaperDir(workspaceDir), CACHE_FILE);
  if (cache && cachePath === p) return cache;
  cachePath = p;
  try {
    cache = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

function flushCache() {
  if (!cacheDirty || !cachePath) return;
  cacheDirty = false;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(`${cachePath}.tmp`, JSON.stringify(cache), "utf8");
    fs.renameSync(`${cachePath}.tmp`, cachePath);
  } catch {
    // Cache is an optimisation; never fail a page render over it.
  }
}

const META_TAG_RE = /<meta\b[^>]*>/gi;
const PROP_RE = /(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const CONTENT_RE = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

// Exact names only. Prefix matching here is a trap: og:image:width would
// qualify and its content ("1200") would be resolved as the image URL.
const IMAGE_PROPS = new Set([
  "og:image",
  "og:image:url",
  "og:image:secure_url",
  "twitter:image",
  "twitter:image:src",
]);

const pick = (m) => (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();

/** Pull the best publisher-declared social image out of a chunk of HTML. */
export function extractImage(html, baseUrl) {
  const found = [];
  for (const [tag] of html.matchAll(META_TAG_RE)) {
    const prop = pick(PROP_RE.exec(tag)).toLowerCase();
    if (!IMAGE_PROPS.has(prop)) continue;
    const raw = pick(CONTENT_RE.exec(tag));
    if (raw) found.push([prop, raw]);
  }
  // og:image wins over twitter:image; first declaration wins within a kind.
  found.sort((a, b) => (a[0].startsWith("og:") ? 0 : 1) - (b[0].startsWith("og:") ? 0 : 1));
  for (const [, raw] of found) {
    try {
      const u = new URL(decodeHtml(raw), baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (/\.svg($|\?)/i.test(u.pathname)) continue; // logos, not photographs
      if (GENERIC_RE.test(u.pathname)) continue; // section fallback, not this story's art
      return u.toString();
    } catch {
      // keep looking
    }
  }
  return "";
}

// Section fronts and paywalled pages often declare the masthead logo as their
// og:image. A newspaper printing the same BBC roundel six times looks broken,
// so treat these as "no image" and let the layout run text-only.
const GENERIC_RE = /(^|[\/_-])(default|placeholder|fallback|logo|generic|share[-_]?card|social[-_]?default)([\/_.-]|$)/i;

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchImageFor(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok || !/text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) {
      return "";
    }
    // Read only as far as we need; article bodies can be megabytes.
    const reader = res.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let html = "";
    while (html.length < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    await reader.cancel().catch(() => {});
    return extractImage(html, res.url || url);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function cachedValue(entry) {
  if (!entry) return undefined;
  if (entry.image) return entry.image;
  if (Date.now() - (entry.at ?? 0) < NEGATIVE_TTL_MS) return "";
  return undefined; // stale miss — worth one more try
}

/**
 * Fill in `image_url` for every story that lacks one, within a wall-clock
 * budget. Whatever does not resolve in time is simply left empty: the layout
 * is text-first and reads correctly without any image at all. The next page
 * load picks up where this one stopped.
 */
export async function ensureImages(workspaceDir, edition, { budgetMs = 4000, prune = false } = {}) {
  const c = loadCache(workspaceDir);
  if (prune) {
    // Only one edition is kept, so drop lookups for articles no longer on disk.
    const live = new Set([...edition.bySlug.values()].map((s) => s.url));
    for (const url of Object.keys(c)) {
      if (!live.has(url)) {
        delete c[url];
        cacheDirty = true;
      }
    }
  }
  const pending = [];
  for (const story of edition.bySlug.values()) {
    if (story.image_url || !story.url) continue;
    const hit = cachedValue(c[story.url]);
    if (hit !== undefined) {
      story.image_url = hit;
      continue;
    }
    pending.push(story);
  }
  if (!pending.length) {
    flushCache(); // persists a prune even when nothing needed fetching
    return edition;
  }

  const deadline = Date.now() + budgetMs;
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length && Date.now() < deadline) {
      const story = pending[cursor++];
      let promise = inflight.get(story.url);
      if (!promise) {
        promise = fetchImageFor(story.url).finally(() => inflight.delete(story.url));
        inflight.set(story.url, promise);
      }
      const image = await promise;
      c[story.url] = { image, at: Date.now() };
      cacheDirty = true;
      story.image_url = image;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  flushCache();
  return edition;
}
