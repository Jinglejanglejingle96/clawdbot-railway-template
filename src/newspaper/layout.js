// The editorial desk, in code.
//
// Turns a normalised edition into a page plan: which story leads, what sits
// in the right-hand rail, and what role each remaining story plays inside its
// section. Importance drives prominence; the reader never sees the number.
//
//   9-10  lead candidate
//   7-8   section feature
//   4-6   standard article
//   1-3   brief / column filler
//
// Pure functions, no I/O — so the layout is testable without a server.

const FEATURE_FLOOR = 7;
const BRIEF_CEILING = 3;
const RAIL_MAX = 4;
const RAIL_MIN_EDITION_SIZE = 4; // below this, a rail just looks like a stub
const SHORT_LEAD_CHARS = 420; // under this the lead cannot hold the well alone

/** Group the market table by its `group` field, preserving first-seen order. */
export function planMarkets(markets) {
  const groups = [];
  const index = new Map();
  for (const row of markets) {
    let g = index.get(row.group);
    if (!g) {
      g = { name: row.group, rows: [] };
      index.set(row.group, g);
      groups.push(g);
    }
    g.rows.push(row);
  }
  return groups;
}

export function planEdition(edition) {
  const used = new Set();
  const lead = edition.lead ?? null;
  if (lead) used.add(lead.slug);

  const remaining = [];
  for (const name of edition.orderedSections) {
    for (const s of edition.sections[name]) if (!used.has(s.slug)) remaining.push(s);
  }

  // The rail carries the strongest stories that are not the lead, drawn from
  // anywhere in the paper — that is what a front page actually does. But it
  // takes at most one story per section and never the last one, or a section
  // gets emptied onto the front page and vanishes from the paper below.
  const rail = [];
  if (edition.storyCount >= RAIL_MIN_EDITION_SIZE) {
    const left = new Map();
    for (const s of remaining) left.set(s.section, (left.get(s.section) ?? 0) + 1);
    const taken = new Set();

    for (const s of [...remaining].sort((a, b) => b.importance - a.importance)) {
      if (rail.length >= RAIL_MAX) break;
      // Once we are past the strong stories, stop rather than pad the rail.
      if (rail.length >= 2 && s.importance < 5) break;
      if (taken.has(s.section) || left.get(s.section) <= 1) continue;
      rail.push(s);
      taken.add(s.section);
      left.set(s.section, left.get(s.section) - 1);
      used.add(s.slug);
    }
  }

  // A short lead leaves the main well far shorter than the rail beside it.
  // Print solves this by running a second story above the fold rather than
  // by padding the first, so do the same: promote the strongest rail item.
  let subLead = null;
  if (lead && (lead.summary?.length ?? 0) < SHORT_LEAD_CHARS && rail.length >= 3) {
    subLead = rail.shift();
  }

  const sections = [];
  for (const name of edition.orderedSections) {
    const stories = edition.sections[name].filter((s) => !used.has(s.slug));
    if (!stories.length) continue; // never print an empty section

    let feature = null;
    const standard = [];
    const briefs = [];
    // A section leads with a feature when its top story earns it, or when the
    // section is long enough that an unbroken run of equal-weight columns
    // would read as a list rather than a page.
    const featureFloor = stories.length >= 4 ? FEATURE_FLOOR - 2 : FEATURE_FLOOR;
    for (const s of stories) {
      if (!feature && s.importance >= featureFloor) {
        feature = s;
      } else if (s.importance <= BRIEF_CEILING) {
        briefs.push(s);
      } else {
        standard.push(s);
      }
    }
    // A section made only of briefs reads as filler; promote its best item so
    // every section has at least one properly-set story.
    if (!feature && !standard.length && briefs.length) standard.push(briefs.shift());

    sections.push({ name, feature, standard, briefs, count: stories.length });
  }

  return {
    lead,
    subLead,
    rail,
    sections,
    markets: planMarkets(edition.markets),
    hasBriefing: Boolean(edition.briefing),
    // Section names to print in the nameplate strip.
    index: sections.map((s) => s.name),
  };
}
