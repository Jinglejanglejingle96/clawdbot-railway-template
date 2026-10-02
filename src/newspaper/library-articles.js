import { normaliseEdition } from "./store.js";

const clean = (value) => String(value ?? "").replace(/\*\*/g, "").trim();
const sourceUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch { return ""; }
};

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

export function articlesFromIssue(issue) {
  const seen = new Set();
  const sections = {};
  for (const job of issue.jobs ?? []) {
    for (const run of [...(job.runs ?? [])].reverse()) {
      const items = Array.isArray(run.items) && run.items.length ? run.items : linkedArticles(run.summary);
      for (const item of items) {
        const url = sourceUrl(item.url);
        const title = clean(item.title ?? item.headline);
        if (!title || !url || seen.has(url)) continue;
        seen.add(url);
        const category = clean(item.category || "Research").toUpperCase();
        const section = category.slice(0, 48);
        const priority = Number(item.priority);
        (sections[section] ??= []).push({
          headline: title,
          deck: clean(item.deck),
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
  return normaliseEdition({
    date: `${issue.month}-01`,
    edition: "Monthly Edition",
    generated_at: issue.refreshed_at,
    coverage: issue.month,
    sections,
  }, `${issue.month}-01`);
}
