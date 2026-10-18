import { normaliseEdition } from "./store.js";

const clean = (value) => String(value ?? "").replace(/\*\*/g, "").trim();
const sourceUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch { return ""; }
};

// LIBRARIAN writes free-form categories ("AI / Data engineering", "Clinical neurology"), which used to give
// the Review ~50 one-story sections a week. Fold them into a fixed set of desks; first match wins.
const DESKS = [
  ["NEUROSCIENCE & BCI", /neuro|\bbci\b|brain|cognit|psychiat|sleep|dementia/i],
  ["MEDICINE & HEALTH", /medic|clinic|health|pharma|drug|disease|patient|surg/i],
  ["AI & AGENTS", /\bai\b|agent|\bllm|language model|machine learning|\bml\b|transformer|interpretab|inference|scaling|deep learning|model/i],
  ["TECH & ENGINEERING", /secur|software|engineer|data|hardware|semicond|chip|cloud|infra|program|developer|devops|database|compute|tech/i],
  ["ECONOMY & BUSINESS", /financ|market|econom|business|invest|trade|startup|industr|compan/i],
  ["SCIENCE & NATURE", /scien|climat|biolog|biotech|physic|chemi|animal|ecolog|space|astro|genet|evolution/i],
  ["SOCIETY & IDEAS", /polic|polit|societ|law|ethic|philosoph|histor|cultur|career|education|geopolit|govern/i],
];

export function desk(category, title = "") {
  for (const [name, re] of DESKS) if (re.test(category)) return name;
  for (const [name, re] of DESKS) if (re.test(title)) return name;
  return "MORE READING";
}

// The front of the Review should be this week's reading, not an old paper that ranked highly; older items are demoted.
const LEAD_MAX_AGE_DAYS = 45;

// The reading feed rolls over at 23:00 Sunday in London, including DST weeks.
export function weekStart(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const localDay = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const daysBack = new Date(localDay).getUTCDay() + (new Date(localDay).getUTCDay() === 0 && Number(parts.hour) < 23 ? 7 : 0);
  const sundayAt23 = localDay - daysBack * 86400000 + 23 * 3600000;
  const zone = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" })
    .formatToParts(new Date(sundayAt23)).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const offset = Number(zone.match(/^GMT\+?(\d+)/)?.[1] ?? 0);
  return new Date(sundayAt23 - offset * 3600000).toISOString();
}

// Older cron output has prose rather than structured items. Recover only
// titled blocks with an actual source URL; never invent a link or analysis.
export function linkedArticles(text) {
  const source = String(text ?? "");
  const bullet = /^\*\s+\*\*\[([1-5])\/5\]\s+(.+?)\*\*\s*$/gm;
  const matches = [...source.matchAll(bullet)];
  if (matches.length) return matches.flatMap((match, i) => {
    const block = source.slice(match.index + match[0].length, matches[i + 1]?.index ?? source.length);
    const field = (name) => clean(block.match(new RegExp(`^\\s*\\*\\s+\\*\\*(?:${name}):\\*\\*\\s*(.+)$`, "im"))?.[1]);
    const url = sourceUrl(field("Link").replace(/[.,;]+$/, ""));
    if (!url) return [];
    return [{ title: clean(match[2]), url, priority: Number(match[1]),
      summary: field("Summary"), analysis: field("Why it matters|Analysis|Relevance"),
      limitations: field("Limitation|Limitations"), category: "Newsletters" }];
  });
  const parts = source.split(/^#{2,4}\s+(?:\d+[.)]\s*)?/m).slice(1);
  return parts.flatMap((part) => {
    const [titleLine, ...bodyLines] = part.split(/\r?\n/);
    const body = bodyLines.join("\n");
    const url = sourceUrl(body.match(/https?:\/\/[^\s<>)\]]+/)?.[0]?.replace(/[.,;]+$/, ""));
    if (!url || !clean(titleLine)) return [];
    const field = (name) => clean(body.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*([^\\n]+)`, "i"))?.[1]);
    return [{
      title: clean(titleLine), url,
      source: field("Source(?:\\s*\\/\\s*Date)?"),
      category: field("Category"),
      summary: field("Summary") || clean(body.split(/\n\s*\n/).find((p) => !/^\s*[-*#]|https?:\/\//.test(p.trim())) ?? ""),
      analysis: field("Why it matters(?: to you)?") || field("Relevance"),
      limitations: field("Limitations?"),
      priority: Number(body.match(/Priority\s*:\s*([1-5])\s*\/\s*5/i)?.[1]) || 3,
    }];
  });
}

export function articlesFromIssue(issue, { since, extraIssues = [] } = {}) {
  const seen = new Set();
  const sections = {};
  for (const job of [issue, ...extraIssues].flatMap((source) => source?.jobs ?? [])) {
    for (const run of [...(job.runs ?? [])].reverse()) {
      if (since && (!Number.isFinite(Date.parse(run.at)) || Date.parse(run.at) < Date.parse(since))) continue;
      const items = Array.isArray(run.items) && run.items.length ? run.items : linkedArticles(run.summary);
      for (const item of items) {
        const url = sourceUrl(item.url);
        const title = clean(item.title ?? item.headline);
        if (!title || !url || seen.has(url)) continue;
        seen.add(url);
        const category = clean(item.category);
        const section = desk(category, title);
        const priority = Number(item.priority);
        (sections[section] ??= []).push({
          headline: title,
          // The desk replaces the old per-item section label; keep LIBRARIAN's finer label as the deck.
          deck: clean(item.deck) || category,
          summary: clean(item.summary),
          why_it_matters: clean(item.analysis ?? item.why_it_matters),
          what_to_watch: clean(item.limitations ?? item.what_to_watch),
          section,
          importance: Number.isFinite(priority) ? Math.max(1, Math.min(10, priority * 2)) : 5,
          source: clean(item.source),
          url,
          published_at: clean(item.published_at || run.at),
        });
      }
    }
  }
  // Old items stay in their desk but lose prominence, so the lead, rail and features are recent reading. The
  // lead is the highest-priority item, newest first among equals (normaliseEdition would take the first one).
  const now = Date.parse(issue.refreshed_at) || Date.now();
  const age = (s) => (now - (Date.parse(s.published_at) || now)) / 86400000;
  const all = Object.values(sections).flat();
  for (const s of all) if (age(s) > LEAD_MAX_AGE_DAYS) s.importance = Math.max(1, s.importance - 4);
  const lead = [...all].sort((a, b) => b.importance - a.importance || age(a) - age(b))[0];
  return normaliseEdition({
    date: `${issue.month}-01`,
    edition: "Monthly Edition",
    generated_at: issue.refreshed_at,
    coverage: issue.month,
    lead_story: lead,
    sections,
  }, `${issue.month}-01`);
}
