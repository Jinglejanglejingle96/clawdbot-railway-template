// Edition store — the only thing that knows where editions live on disk.
//
// One JSON file per day under <workspace>/data/newspaper/YYYY-MM-DD.json,
// written by REPORTER during its existing 06:40 run. Everything downstream
// (layout, render, routes) reads normalised objects from here and never
// touches the filesystem itself.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Sections we know how to order and style. Unknown sections still render,
// appended in the order REPORTER emitted them.
export const SECTION_ORDER = [
  "WORLD",
  "UK",
  "KOREA",
  "BUSINESS",
  "MARKETS",
  "TECHNOLOGY",
  "AI",
  "SCIENCE",
  "NEUROSCIENCE",
  "HEALTH",
  "CULTURE",
  "HOT TOPICS",
  "HACKER NEWS",
  "THE NEWSLETTERS",
];

export function newspaperDir(workspaceDir) {
  return path.join(workspaceDir, "data", "newspaper");
}

function editionPath(workspaceDir, date) {
  return path.join(newspaperDir(workspaceDir), `${date}.json`);
}

/** Today's date in Europe/London (the edition calendar), as YYYY-MM-DD. */
export function londonToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Newest-first list of edition dates that exist on disk. */
export function listEditions(workspaceDir) {
  let names = [];
  try {
    names = fs.readdirSync(newspaperDir(workspaceDir));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json") && DATE_RE.test(n.slice(0, -5)))
    .map((n) => n.slice(0, -5))
    .sort()
    .reverse();
}

/** Read + normalise one edition. Returns null if absent or unparseable. */
export function readEdition(workspaceDir, date) {
  if (!DATE_RE.test(date)) return null;
  let raw;
  try {
    raw = fs.readFileSync(editionPath(workspaceDir, date), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return normaliseEdition(parsed, date);
}

/** Most recent edition at or before `date` (default: today). */
export function readLatestEdition(workspaceDir, date = londonToday()) {
  for (const d of listEditions(workspaceDir)) {
    if (d <= date) {
      const ed = readEdition(workspaceDir, d);
      if (ed) return ed;
    }
  }
  return null;
}

/** Delete every edition dated before `keepDate`; only the newest paper is kept. */
export function pruneEditions(workspaceDir, keepDate) {
  for (const d of listEditions(workspaceDir)) {
    if (d < keepDate) fs.rmSync(editionPath(workspaceDir, d), { force: true });
  }
}

export function writeEdition(workspaceDir, edition) {
  const date = edition?.date;
  if (!DATE_RE.test(date ?? "")) throw new Error("edition.date must be YYYY-MM-DD");
  const dir = newspaperDir(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = editionPath(workspaceDir, date);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(edition, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target); // atomic: a half-written edition never renders
  return target;
}

// --- normalisation -------------------------------------------------------
//
// REPORTER is a language model writing JSON, so assume nothing. Every field
// is coerced to the shape the renderer expects; anything unusable is dropped
// rather than allowed to throw mid-page.

const str = (v) => (typeof v === "string" ? v.trim() : "");

function clampImportance(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function safeUrl(v) {
  const s = str(v);
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
}

export function slugify(headline, url) {
  const base = str(headline)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // Short digest keeps slugs unique when two headlines collapse to the same stem.
  const digest = crypto.createHash("sha1").update(`${headline}|${url}`).digest("hex").slice(0, 6);
  return `${base || "story"}-${digest}`;
}

function normaliseStory(raw, fallbackSection) {
  if (!raw || typeof raw !== "object") return null;
  const headline = str(raw.headline) || str(raw.title);
  if (!headline) return null; // a story with no headline is not a story
  const url = safeUrl(raw.url);
  return {
    headline,
    deck: str(raw.deck) || str(raw.subhead),
    summary: str(raw.summary),
    why_it_matters: str(raw.why_it_matters),
    what_to_watch: str(raw.what_to_watch),
    pull_quote: str(raw.pull_quote),
    section: (str(raw.section) || fallbackSection || "WORLD").toUpperCase(),
    importance: clampImportance(raw.importance),
    source: str(raw.source),
    url,
    image_url: safeUrl(raw.image_url),
    image_caption: str(raw.image_caption),
    published_at: str(raw.published_at),
    slug: slugify(headline, url),
  };
}

function normaliseMarket(raw) {
  if (!raw || typeof raw !== "object") return null;
  const label = str(raw.label) || str(raw.name);
  if (!label) return null;
  const change = str(raw.change);
  let direction = str(raw.direction).toLowerCase();
  if (!["up", "down", "flat"].includes(direction)) {
    // Infer from the change string so REPORTER never has to state it twice.
    direction = /^[+]/.test(change) ? "up" : /^[-–−]/.test(change) ? "down" : "flat";
  }
  return {
    group: str(raw.group) || "Markets",
    label,
    value: str(raw.value) || str(raw.level),
    change,
    direction,
    status: str(raw.status),
    note: str(raw.note) || str(raw.driver),
  };
}

export function normaliseEdition(raw, fallbackDate) {
  const date = DATE_RE.test(str(raw?.date)) ? str(raw.date) : fallbackDate;

  const sections = {};
  const bySlug = new Map();
  const src = raw?.sections && typeof raw.sections === "object" ? raw.sections : {};

  for (const [name, list] of Object.entries(src)) {
    if (!Array.isArray(list)) continue;
    const key = name.trim().toUpperCase();
    const stories = list
      .map((s) => normaliseStory(s, key))
      .filter(Boolean)
      // Drop repeats of the same story inside one section.
      .filter((s) => !bySlug.has(s.slug) && (bySlug.set(s.slug, s), true))
      .sort((a, b) => b.importance - a.importance);
    if (stories.length) sections[key] = stories;
  }

  // The lead may be given explicitly or inferred. Either way it must also be
  // reachable by slug so the article view and "more from this edition" work.
  let lead = normaliseStory(raw?.lead_story, "WORLD");
  if (lead && bySlug.has(lead.slug)) {
    lead = bySlug.get(lead.slug); // same story, already in a section
  } else if (lead) {
    bySlug.set(lead.slug, lead);
    // Keep the lead inside its section list so archive counts stay honest.
    const key = lead.section;
    sections[key] = [lead, ...(sections[key] ?? [])].sort((a, b) => b.importance - a.importance);
  } else {
    let best = null;
    for (const s of bySlug.values()) if (!best || s.importance > best.importance) best = s;
    lead = best;
  }

  const markets = (Array.isArray(raw?.markets) ? raw.markets : []).map(normaliseMarket).filter(Boolean);

  const orderedSections = Object.keys(sections).sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a);
    const ib = SECTION_ORDER.indexOf(b);
    return (ia === -1 ? 500 : ia) - (ib === -1 ? 500 : ib) || a.localeCompare(b);
  });

  return {
    date,
    edition: str(raw?.edition) || "Morning Edition",
    generated_at: str(raw?.generated_at),
    coverage: str(raw?.coverage),
    briefing: str(raw?.briefing),
    lead,
    sections,
    orderedSections,
    markets,
    storyCount: bySlug.size,
    bySlug,
  };
}

export function findStory(edition, slug) {
  return edition?.bySlug?.get(slug) ?? null;
}
