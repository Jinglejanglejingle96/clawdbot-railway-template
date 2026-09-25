import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractImage } from "../src/newspaper/images.js";
import { planEdition } from "../src/newspaper/layout.js";
import { renderArchive, renderArticle, renderFrontPage } from "../src/newspaper/render.js";
import {
  listEditions,
  normaliseEdition,
  pruneEditions,
  readEdition,
  readLatestEdition,
  writeEdition,
} from "../src/newspaper/store.js";

const ctx = (date = "2026-09-23") => ({ date, editionNo: "12", link: (p) => `/news${p === "/" ? "" : p}` });

const story = (o) => ({ summary: "A summary.", importance: 5, source: "Reuters", url: "https://example.com/a", ...o });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jd-"));

// ── store ─────────────────────────────────────────────────────────────────

test("normalise drops junk and sorts sections by importance", () => {
  const ed = normaliseEdition(
    {
      date: "2026-09-23",
      sections: {
        world: [story({ headline: "Low", importance: 2 }), story({ headline: "High", importance: 9 }), { no: "headline" }],
        Empty: [],
        Broken: "not an array",
      },
    },
    "2026-09-23",
  );
  assert.deepEqual(Object.keys(ed.sections), ["WORLD"]); // empty + malformed sections gone
  assert.deepEqual(ed.sections.WORLD.map((s) => s.headline), ["High", "Low"]);
  assert.equal(ed.storyCount, 2);
});

test("importance is clamped and defaulted", () => {
  const ed = normaliseEdition(
    { date: "2026-09-23", sections: { WORLD: [story({ headline: "A", importance: 99 }), story({ headline: "B", importance: "x" })] } },
    "2026-09-23",
  );
  assert.equal(ed.sections.WORLD[0].importance, 10);
  assert.equal(ed.sections.WORLD[1].importance, 5);
});

test("javascript: urls are rejected, http(s) kept", () => {
  const ed = normaliseEdition(
    { date: "2026-09-23", sections: { WORLD: [story({ headline: "A", url: "javascript:alert(1)", image_url: "javascript:x" })] } },
    "2026-09-23",
  );
  assert.equal(ed.sections.WORLD[0].url, "");
  assert.equal(ed.sections.WORLD[0].image_url, "");
});

test("lead is inferred from importance when not supplied, and stays in its section", () => {
  const ed = normaliseEdition(
    { date: "2026-09-23", sections: { WORLD: [story({ headline: "Mid", importance: 5 })], UK: [story({ headline: "Top", importance: 9 })] } },
    "2026-09-23",
  );
  assert.equal(ed.lead.headline, "Top");
  assert.equal(ed.storyCount, 2);
});

test("an explicit lead that also appears in a section is not duplicated", () => {
  const s = story({ headline: "Same", importance: 9, section: "WORLD" });
  const ed = normaliseEdition({ date: "2026-09-23", lead_story: s, sections: { WORLD: [s] } }, "2026-09-23");
  assert.equal(ed.storyCount, 1);
  assert.equal(ed.lead.headline, "Same");
});

test("write then read round-trips through the workspace", () => {
  const ws = tmp();
  writeEdition(ws, { date: "2026-09-23", sections: { WORLD: [story({ headline: "Hello" })] } });
  writeEdition(ws, { date: "2026-09-22", sections: { WORLD: [story({ headline: "Older" })] } });
  assert.deepEqual(listEditions(ws), ["2026-09-23", "2026-09-22"]);
  assert.equal(readEdition(ws, "2026-09-23").lead.headline, "Hello");
  assert.equal(readLatestEdition(ws, "2026-09-22").lead.headline, "Older");
  assert.equal(readEdition(ws, "nope"), null);
  assert.equal(readEdition(ws, "2020-01-01"), null);
});

test("prune keeps only the newest edition, leaving other files alone", () => {
  const ws = tmp();
  for (const date of ["2026-09-21", "2026-09-22", "2026-09-23"]) writeEdition(ws, { date, sections: {} });
  fs.writeFileSync(path.join(ws, "data", "newspaper", "link.txt"), "x");
  pruneEditions(ws, "2026-09-23");
  assert.deepEqual(listEditions(ws), ["2026-09-23"]);
  assert.ok(fs.existsSync(path.join(ws, "data", "newspaper", "link.txt")));
});

test("a corrupt edition file reads as null rather than throwing", () => {
  const ws = tmp();
  fs.mkdirSync(path.join(ws, "data", "newspaper"), { recursive: true });
  fs.writeFileSync(path.join(ws, "data", "newspaper", "2026-09-23.json"), "{not json");
  assert.equal(readEdition(ws, "2026-09-23"), null);
});

// ── layout ────────────────────────────────────────────────────────────────

test("the rail never empties a section", () => {
  const ed = normaliseEdition(
    {
      date: "2026-09-23",
      sections: {
        WORLD: [story({ headline: "W1", importance: 10 }), story({ headline: "W2", importance: 9 }), story({ headline: "W3", importance: 8 })],
        UK: [story({ headline: "U1", importance: 9 })],
      },
    },
    "2026-09-23",
  );
  const plan = planEdition(ed);
  assert.equal(plan.lead.headline, "W1");
  // U1 is strong but is the only UK story, so it stays in the UK section.
  assert.ok(!plan.rail.some((s) => s.headline === "U1"));
  assert.ok(plan.sections.some((s) => s.name === "UK"));
});

test("the rail takes at most one story per section", () => {
  const sections = { WORLD: [], UK: [], BUSINESS: [] };
  for (const k of Object.keys(sections)) {
    for (let i = 0; i < 4; i++) sections[k].push(story({ headline: `${k}${i}`, importance: 9 }));
  }
  const plan = planEdition(normaliseEdition({ date: "2026-09-23", sections }, "2026-09-23"));
  const counts = {};
  for (const s of plan.rail) counts[s.section] = (counts[s.section] ?? 0) + 1;
  assert.ok(Object.values(counts).every((n) => n === 1), JSON.stringify(counts));
});

test("importance maps to role", () => {
  // "Rail" is the strongest non-lead story; the roles below it are what this
  // test pins down.
  const plan = planEdition(
    normaliseEdition(
      {
        date: "2026-09-23",
        lead_story: story({ headline: "Lead", importance: 10, section: "WORLD" }),
        sections: {
          WORLD: [
            story({ headline: "Rail", importance: 9 }),
            story({ headline: "Feature", importance: 8 }),
            story({ headline: "Standard", importance: 5 }),
            story({ headline: "Brief", importance: 2 }),
          ],
        },
      },
      "2026-09-23",
    ),
  );
  const world = plan.sections.find((s) => s.name === "WORLD");
  assert.equal(plan.lead.headline, "Lead");
  assert.deepEqual(plan.rail.map((s) => s.headline), ["Rail"]);
  assert.equal(world.feature.headline, "Feature");
  assert.deepEqual(world.standard.map((s) => s.headline), ["Standard"]);
  assert.deepEqual(world.briefs.map((s) => s.headline), ["Brief"]);
});

test("the front page never reprints a story that is already in the rail or lead", () => {
  const sections = {
    WORLD: Array.from({ length: 4 }, (_, i) => story({ headline: `W${i}`, importance: 9 - i })),
    UK: Array.from({ length: 4 }, (_, i) => story({ headline: `U${i}`, importance: 8 - i })),
  };
  const ed = normaliseEdition({ date: "2026-09-23", sections }, "2026-09-23");
  const plan = planEdition(ed);
  const seen = new Set([plan.lead.slug, ...plan.rail.map((s) => s.slug)]);
  for (const sec of plan.sections) {
    for (const s of [sec.feature, ...sec.standard, ...sec.briefs].filter(Boolean)) {
      assert.ok(!seen.has(s.slug), `${s.headline} printed twice`);
      seen.add(s.slug);
    }
  }
  assert.equal(seen.size, ed.storyCount); // every story placed exactly once
});

test("a section of only briefs still gets one properly-set story", () => {
  const plan = planEdition(
    normaliseEdition(
      { date: "2026-09-23", sections: { CULTURE: [story({ headline: "A", importance: 2 }), story({ headline: "B", importance: 1 })] } },
      "2026-09-23",
    ),
  );
  const culture = plan.sections.find((s) => s.name === "CULTURE");
  assert.equal(culture.standard.length, 1);
});

test("empty sections never reach the plan", () => {
  const plan = planEdition(
    normaliseEdition(
      {
        date: "2026-09-23",
        sections: { WORLD: [story({ headline: "A", importance: 9 }), story({ headline: "B", importance: 4 })], SCIENCE: [], HEALTH: [] },
      },
      "2026-09-23",
    ),
  );
  assert.deepEqual(plan.index, ["WORLD"]); // A leads, B keeps WORLD alive
});

test("a section whose only story leads the paper is not printed twice", () => {
  const plan = planEdition(normaliseEdition({ date: "2026-09-23", sections: { WORLD: [story({ headline: "A" })] } }, "2026-09-23"));
  assert.equal(plan.lead.headline, "A");
  assert.deepEqual(plan.index, []);
});

// ── render ────────────────────────────────────────────────────────────────

const bigEdition = normaliseEdition(
  {
    date: "2026-09-23",
    briefing: "A synthesis.",
    lead_story: story({
      headline: "Lead headline",
      section: "WORLD",
      importance: 10,
      image_url: "https://img.example.com/a.jpg",
      image_caption: "A caption",
    }),
    sections: {
      WORLD: [story({ headline: "W2", importance: 7 }), story({ headline: "W3", importance: 3 })],
      UK: [story({ headline: "U1", importance: 6 }), story({ headline: "U2", importance: 5 })],
    },
    markets: [{ group: "International", label: "S&P 500", value: "6,743.21", change: "+0.62%" }],
  },
  "2026-09-23",
);

test("front page renders every required part", () => {
  const html = renderFrontPage(bigEdition, ctx());
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Jeeves Daily/);
  assert.match(html, /Jeeves&rsquo; Briefing/);
  assert.match(html, /class="ticker"/);
  assert.match(html, /S&amp;P 500/);
  assert.match(html, /Lead headline/);
  assert.match(html, /onerror=/); // broken-image guard is present
  // The numeric importance score must never reach the reader.
  assert.doesNotMatch(html, /importance/i);
});

test("a story with no image renders no figure and no empty frame", () => {
  const ed = normaliseEdition({ date: "2026-09-23", sections: { WORLD: [story({ headline: "No art" })] } }, "2026-09-23");
  const html = renderFrontPage(ed, ctx());
  assert.doesNotMatch(html, /<figure/);
  assert.match(html, /no-art/); // lead switches to its typographic treatment
});

test("headlines and urls are escaped, and urls are not typeset", () => {
  const ed = normaliseEdition(
    {
      date: "2026-09-23",
      sections: {
        WORLD: [story({ headline: `<script>alert("x")</script>`, url: "https://e.com/2026-09-23/a?b=1&c=2" })],
      },
    },
    "2026-09-23",
  );
  const html = renderFrontPage(ed, ctx());
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /https:\/\/e\.com\/2026-09-23\/a\?b=1&amp;c=2/); // hyphens intact
});

test("prose gets typographic quotes but attributes do not", () => {
  const ed = normaliseEdition(
    { date: "2026-09-23", sections: { WORLD: [story({ headline: `Iran's 'red line'`, url: "https://e.com/a-b-c" })] } },
    "2026-09-23",
  );
  const html = renderFrontPage(ed, ctx());
  assert.match(html, /Iran’s ‘red line’/);
  assert.match(html, /href="https:\/\/e\.com\/a-b-c"/);
});

test("article view shows the summary and links back to the source", () => {
  const html = renderArticle(bigEdition, bigEdition.lead, ctx());
  assert.match(html, /Lead headline/);
  assert.match(html, /REPORTER&rsquo;s summary/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /Elsewhere in this edition/);
});

test("article view without a url says so instead of printing a dead link", () => {
  const ed = normaliseEdition({ date: "2026-09-23", sections: { WORLD: [story({ headline: "A", url: "" })] } }, "2026-09-23");
  const html = renderArticle(ed, ed.lead, ctx());
  assert.match(html, /No public link was available/);
});

test("archive groups by month and survives being empty", () => {
  const html = renderArchive(
    [
      { date: "2026-09-23", headline: "Sept lead", storyCount: 9 },
      { date: "2026-08-02", headline: "Aug lead", storyCount: 4 },
    ],
    ctx(),
  );
  assert.match(html, /September 2026/);
  assert.match(html, /August 2026/);
  assert.match(renderArchive([], ctx()), /No editions yet/);
});

test("an enormous edition renders without blowing up", () => {
  const sections = {};
  for (const name of ["WORLD", "UK", "BUSINESS", "TECHNOLOGY", "AI", "SCIENCE", "HEALTH"]) {
    sections[name] = Array.from({ length: 12 }, (_, i) => story({ headline: `${name} ${i}`, importance: (i % 10) + 1 }));
  }
  const ed = normaliseEdition({ date: "2026-09-23", sections }, "2026-09-23");
  assert.equal(ed.storyCount, 84);
  const html = renderFrontPage(ed, ctx());
  assert.ok(html.length > 10000);
});

test("a one-story edition renders with no rail", () => {
  const ed = normaliseEdition({ date: "2026-09-23", sections: { WORLD: [story({ headline: "Only" })] } }, "2026-09-23");
  const html = renderFrontPage(ed, ctx());
  assert.match(html, /frontpage solo/);
});

// ── images ────────────────────────────────────────────────────────────────

test("og:image is preferred over twitter:image", () => {
  const html = `<meta name="twitter:image" content="https://x/t.jpg"><meta property="og:image" content="https://x/o.jpg">`;
  assert.equal(extractImage(html, "https://x/"), "https://x/o.jpg");
});

test("og:image:width is not mistaken for og:image", () => {
  const html = `<meta property="og:image:width" content="1200"><meta property="og:image" content="https://i.guim.co.uk/img/a.jpg?width=1200">`;
  assert.equal(extractImage(html, "https://www.theguardian.com/a/b/c"), "https://i.guim.co.uk/img/a.jpg?width=1200");
});

test("relative og:image resolves against the article url", () => {
  assert.equal(extractImage(`<meta property="og:image" content="/img/a.jpg">`, "https://x.com/news/story"), "https://x.com/img/a.jpg");
});

test("svg logos and generic fallbacks are skipped", () => {
  assert.equal(extractImage(`<meta property="og:image" content="https://x/logo.svg">`, "https://x/"), "");
  assert.equal(extractImage(`<meta property="og:image" content="https://x/news-facebook-default.png">`, "https://x/"), "");
});

test("a page with no image tags yields no image", () => {
  assert.equal(extractImage("<html><head><title>x</title></head>", "https://x/"), "");
});

// ── wiring ────────────────────────────────────────────────────────────────

test("server mounts the newspaper before the dashboard catch-all", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.ok(src.indexOf('app.use(\n    "/news"') < src.indexOf("app.use(requireDashboardAuth"));
});
