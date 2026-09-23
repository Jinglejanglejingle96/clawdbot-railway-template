// Local preview / visual test harness for THE JEEVES DAILY.
//
//   node scripts/newspaper-preview.mjs           fixtures only (offline)
//   node scripts/newspaper-preview.mjs --live    also builds a realistic
//                                                edition from public RSS and
//                                                resolves real OG images
//
// Writes a self-contained set of HTML pages to .preview/ so the layout can be
// eyeballed at desktop, tablet and phone widths without deploying.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureImages } from "../src/newspaper/images.js";
import { renderArchive, renderArticle, renderFrontPage } from "../src/newspaper/render.js";
import { normaliseEdition, writeEdition } from "../src/newspaper/store.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, ".preview");
const workspace = path.join(out, "workspace");
const live = process.argv.includes("--live");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.copyFileSync(path.join(root, "src", "newspaper", "theme.css"), path.join(out, "style.css"));

const ctx = (date) => ({ date, editionNo: "128", link: (p) => (p === "/" ? "index.html" : `${p.replace(/^\//, "").replace(/\//g, "_")}.html`) });

// --- fixtures -------------------------------------------------------------

const LOREM =
  "Officials confirmed the decision late on Tuesday after a session that ran several hours beyond its scheduled close, and said implementation would begin within the month. Two people briefed on the talks said the final text was narrowed substantially from the draft circulated last week.\n\nAnalysts described the outcome as the minimum needed to keep the process alive, and noted that the harder questions have been deferred rather than settled.";

const story = (o) => ({
  summary: LOREM,
  importance: 5,
  source: "Reuters",
  url: "https://www.reuters.com/",
  published_at: "2026-09-23T05:10:00Z",
  ...o,
});

const fixtures = {
  // Edge cases deliberately stacked into one page.
  "2026-09-20": {
    date: "2026-09-20",
    edition: "Morning Edition",
    generated_at: "2026-09-20T06:48:00+01:00",
    coverage: "19 Sep 06:40 – 20 Sep 06:40 BST",
    briefing:
      "Sterling held its ground through a thin session while the Treasury signalled that November's statement will lean on spending restraint rather than new revenue. In Seoul, the central bank's tone shifted more than its rate did. The semiconductor cycle remains the single variable with the widest downstream effect on both.\n\nWatch the gilt curve rather than the headline rate: the long end has been doing the work all week.",
    lead_story: story({
      headline:
        "A Deliberately, Almost Comically Long Headline That Runs Well Past Any Reasonable Sub-Editor's Patience And Keeps Going To Prove The Type Still Sets Cleanly",
      deck: "A deck that is itself rather long, testing how the italic subhead wraps beneath an oversized headline without losing its shape.",
      section: "WORLD",
      importance: 10,
      image_url: "https://example.invalid/this-image-does-not-exist.jpg", // broken on purpose
      image_caption: "This caption belongs to an image that will fail to load.",
      source: "Financial Times",
      url: "https://www.ft.com/",
    }),
    sections: {
      WORLD: [
        story({ headline: "Talks resume", deck: "Short one.", section: "WORLD", importance: 8, url: "https://www.bbc.co.uk/news" }),
        story({
          headline: "Cabinet reshuffle leaves two departments without a permanent secretary",
          section: "WORLD",
          importance: 6,
          source: "The Guardian",
          url: "https://www.theguardian.com/uk",
        }),
        story({ headline: "Port strike ends", section: "WORLD", importance: 3, summary: "Ten-day stoppage concluded after arbitration.", url: "" }),
        story({ headline: "Census delayed", section: "WORLD", importance: 2, summary: "Statistics agency cites funding.", url: "" }),
        story({ headline: "Envoy recalled", section: "WORLD", importance: 1, summary: "No reason given publicly.", url: "" }),
      ],
      UK: [
        story({
          headline: "Gilt yields ease as the Treasury trails a restraint-first autumn statement",
          deck: "The long end did most of the moving.",
          section: "UK",
          importance: 7,
          source: "Financial Times",
          pull_quote: "The long end has been doing the work all week.",
          url: "https://www.ft.com/",
        }),
        story({ headline: "NHS waiting list falls for a fourth month", section: "UK", importance: 5, url: "https://www.bbc.co.uk/news" }),
      ],
      SCIENCE: [], // empty section — must not print
      CULTURE: [
        story({ headline: "A restored print, forty years on", section: "CULTURE", importance: 4, summary: "The archive's new transfer runs two minutes longer.", url: "" }),
      ],
    },
    markets: [
      { group: "International", label: "S&P 500", value: "6,743.21", change: "+0.62%", status: "previous close", direction: "up" },
      { group: "International", label: "STOXX Europe 600", value: "589.40", change: "-0.18%" },
      { group: "International", label: "US 10-year", value: "3.94%", change: "-4bp", status: "live" },
      { group: "Korea", label: "KOSPI", value: "3,118.77", change: "+1.04%" },
      { group: "Korea", label: "USD/KRW", value: "1,318.20", change: "0.00%" },
    ],
  },

  // A thin edition: three stories, no briefing, no markets, no images.
  "2026-09-21": {
    date: "2026-09-21",
    edition: "Sunday Edition",
    sections: {
      WORLD: [
        story({ headline: "Ceasefire monitors arrive ahead of schedule", section: "WORLD", importance: 9, url: "https://www.bbc.co.uk/news", image_url: "" }),
        story({ headline: "Fuel subsidy extended", section: "WORLD", importance: 4, url: "" }),
      ],
      TECHNOLOGY: [story({ headline: "Open weights, closed questions", section: "TECHNOLOGY", importance: 5, url: "" })],
    },
  },

  // An overloaded edition: 64 stories across many sections.
  "2026-09-22": {
    date: "2026-09-22",
    edition: "Morning Edition",
    briefing: "A heavy news day, compressed.",
    sections: Object.fromEntries(
      ["WORLD", "UK", "BUSINESS", "TECHNOLOGY", "AI", "SCIENCE", "NEUROSCIENCE", "HEALTH"].map((sec, si) => [
        sec,
        Array.from({ length: 8 }, (_, i) =>
          story({
            headline: `${sec} report ${i + 1}: a headline of ordinary, unremarkable length`,
            deck: i % 3 === 0 ? "A supporting line of context." : "",
            section: sec,
            importance: ((si + i * 3) % 10) + 1,
            url: "",
          }),
        ),
      ]),
    ),
  },
};

// --- optional live edition ------------------------------------------------

const FEEDS = [
  ["WORLD", "https://feeds.bbci.co.uk/news/world/rss.xml", "BBC News", 5],
  ["UK", "https://www.theguardian.com/uk-news/rss", "The Guardian", 4],
  ["TECHNOLOGY", "https://feeds.arstechnica.com/arstechnica/index", "Ars Technica", 4],
  ["SCIENCE", "https://www.nature.com/nature.rss", "Nature", 3],
  ["BUSINESS", "https://feeds.bbci.co.uk/news/business/rss.xml", "BBC Business", 3],
];

const tag = (xml, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return (m?.[1] ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;[^&]*?&gt;/g, "") // feeds that double-escape their HTML
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, " ")
    .trim();
};

async function liveEdition(date) {
  const sections = {};
  for (const [section, url, source, take] of FEEDS) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "JeevesDaily/1.0" }, signal: AbortSignal.timeout(10000) });
      const xml = await res.text();
      const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].slice(0, take);
      sections[section] = items.map((m, i) => ({
        headline: tag(m[0], "title"),
        deck: "",
        summary: tag(m[0], "description").slice(0, 420),
        section,
        importance: 10 - i * 2 - FEEDS.findIndex((f) => f[0] === section),
        source,
        url: tag(m[0], "link"),
        published_at: tag(m[0], "pubDate"),
      }));
      console.log(`  ${section}: ${sections[section].length} from ${source}`);
    } catch (err) {
      console.warn(`  ${section}: feed failed (${err.message})`);
    }
  }
  return {
    date,
    edition: "Morning Edition",
    generated_at: new Date().toISOString(),
    coverage: "rolling 24 hours",
    briefing:
      "Assembled live from public wires for layout review. The real edition is written by REPORTER during its 06:40 run, and this paragraph is where its Morning Pour synthesis lands: two or three sentences on the single development that matters most, what moved underneath it, and the one thing worth watching before the close.",
    sections,
    markets: [
      { group: "International", label: "S&P 500", value: "6,743.21", change: "+0.62%", status: "previous close" },
      { group: "International", label: "Nikkei 225", value: "44,980.11", change: "-0.31%" },
      { group: "International", label: "US 10-year", value: "3.94%", change: "-4bp", status: "live" },
      { group: "Korea", label: "KOSPI", value: "3,118.77", change: "+1.04%" },
      { group: "Korea", label: "USD/KRW", value: "1,318.20", change: "-0.22%" },
    ],
  };
}

// --- build ----------------------------------------------------------------

const written = [];

for (const [date, raw] of Object.entries(fixtures)) {
  writeEdition(workspace, raw);
  written.push(date);
}

if (live) {
  console.log("Fetching live feeds…");
  const raw = await liveEdition("2026-09-23");
  writeEdition(workspace, raw);
  written.push("2026-09-23");
}

const entries = [];
for (const date of written.sort().reverse()) {
  const edition = normaliseEdition(JSON.parse(fs.readFileSync(path.join(workspace, "data", "newspaper", `${date}.json`), "utf8")), date);
  if (live) {
    process.stdout.write(`Resolving images for ${date}… `);
    await ensureImages(workspace, edition, { budgetMs: 25000 });
    const n = [...edition.bySlug.values()].filter((s) => s.image_url).length;
    console.log(`${n}/${edition.storyCount} with art`);
  }
  const c = ctx(date);
  const name = date === written[0] ? "index" : date;
  fs.writeFileSync(path.join(out, `${name}.html`), renderFrontPage(edition, c));
  if (name !== date) fs.writeFileSync(path.join(out, `${date}.html`), renderFrontPage(edition, c));
  entries.push({ date, headline: edition.lead?.headline ?? "", storyCount: edition.storyCount });

  const first = edition.lead ?? [...edition.bySlug.values()][0];
  if (first) {
    fs.writeFileSync(path.join(out, `${date}_s_${first.slug}.html`), renderArticle(edition, first, c));
  }
}

fs.writeFileSync(path.join(out, "archive.html"), renderArchive(entries, ctx(entries[0]?.date)));

// The preview writes flat files, so point the stylesheet at the local copy.
for (const f of fs.readdirSync(out).filter((f) => f.endsWith(".html"))) {
  const p = path.join(out, f);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll('href="style.css"', 'href="style.css"'));
}

console.log(`\nPreview written to ${out}`);
for (const f of fs.readdirSync(out).filter((f) => f.endsWith(".html"))) console.log(`  ${path.join(out, f)}`);
