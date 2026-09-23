// HTML generation. Pure string building — no model tokens are spent here,
// today or ever. Every decision is made from the edition data and the plan.

import { planEdition } from "./layout.js";

// Straight quotes and hyphen ranges come through the wires and look cheap in
// a display serif. Fixing them is a typesetter's job, so it happens here
// rather than costing a model any thought.
function typeset(s) {
  return String(s ?? "")
    .replace(/(\d)\s?-\s?(\d)/g, "$1–$2") // 2019-2024 → en dash
    .replace(/ - /g, " — ") // spaced hyphen → em dash
    .replace(/(^|[\s(\[{"“])'/g, "$1‘")
    .replace(/'/g, "’")
    .replace(/(^|[\s(\[{'‘])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/\.\.\./g, "…");
}

const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Prose: typeset, then escape. */
const esc = (s) => escapeHtml(typeset(s));

/** Attributes (URLs included): escape only — never typeset a machine value. */
const attr = (s) => escapeHtml(s).replace(/'/g, "&#39;");

/** A missing value should collapse the element, not print "undefined". */
const when = (value, fn) => (value ? fn(value) : "");

function fmtDate(iso, opts) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", ...opts }).format(d);
}

function fmtTimestamp(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value; // REPORTER may write prose; print it as-is
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function paragraphs(text) {
  return String(text ?? "")
    .split(/\n{2,}|\r\n\r\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// ── fragments ─────────────────────────────────────────────────────────────

function figure(story, { caption = true } = {}) {
  if (!story.image_url) return "";
  const cap = caption && story.image_caption;
  return `<figure class="figure">
<span class="frame"><img src="${attr(story.image_url)}" alt="${attr(story.image_caption || story.headline)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.closest('figure').hidden=true"></span>
${when(cap, (c) => `<figcaption>${esc(c)}${when(story.source, (s) => `<span class="credit">${esc(s)}</span>`)}</figcaption>`)}
</figure>`;
}

function byline(story, ctx, { section = false } = {}) {
  const bits = [];
  if (section) bits.push(`<span>${esc(story.section)}</span>`);
  if (story.source) bits.push(`<span>${esc(story.source)}</span>`);
  const ts = fmtTimestamp(story.published_at);
  if (ts) bits.push(`<span>${esc(ts)}</span>`);
  if (story.url) bits.push(`<a class="plain" href="${attr(story.url)}" rel="noopener noreferrer nofollow" target="_blank">Source&nbsp;&#8599;</a>`);
  if (!bits.length) return "";
  return `<div class="byline">${bits.join('<span class="sep">&middot;</span>')}</div>`;
}

const storyHref = (ctx, story) => ctx.link(`/${ctx.date}/s/${story.slug}`);

function pullQuote(story) {
  if (!story?.pull_quote) return "";
  return `<blockquote class="pullquote">&ldquo;${esc(story.pull_quote)}&rdquo;${when(
    story.source,
    (s) => `<cite>${esc(s)}</cite>`,
  )}</blockquote>`;
}

function leadStory(story, ctx) {
  const hasArt = Boolean(story.image_url);
  const body = paragraphs(story.summary)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");
  // A short summary set in two columns makes a stubby, awkward block.
  const single = story.summary.length < 420 ? " single" : "";
  return `<article class="s-lead${hasArt ? "" : " no-art"}">
<a href="${attr(storyHref(ctx, story))}">
<span class="kicker">${esc(story.section)}</span>
<h1 class="hed">${esc(story.headline)}</h1>
${when(story.deck, (d) => `<p class="deck">${esc(d)}</p>`)}
</a>
${figure(story)}
${when(body, (b) => `<div class="body${single}">${b}</div>`)}
<a class="readmore" href="${attr(storyHref(ctx, story))}">Full report</a>
${byline(story, ctx)}
</article>`;
}

/** Second story in the main well, set across it beneath a rule. */
function secondLead(story, ctx) {
  const hasArt = Boolean(story.image_url);
  return `<article class="s-second${hasArt ? "" : " no-art"}">
<div class="text">
<a href="${attr(storyHref(ctx, story))}">
<span class="kicker">${esc(story.section)}</span>
<h2 class="hed">${esc(story.headline)}</h2>
${when(story.deck, (d) => `<p class="deck">${esc(d)}</p>`)}
</a>
${when(story.summary, (s) => `<p class="sumry">${esc(paragraphs(s)[0] ?? "")}</p>`)}
${byline(story, ctx)}
</div>
${figure(story, { caption: false })}
</article>`;
}

function railStory(story, ctx) {
  return `<article class="s-rail">
<a href="${attr(storyHref(ctx, story))}">
${figure(story, { caption: false })}
<span class="kicker">${esc(story.section)}</span>
<h2 class="hed">${esc(story.headline)}</h2>
${when(story.deck, (d) => `<p class="deck">${esc(d)}</p>`)}
</a>
${byline(story, ctx)}
</article>`;
}

function featureStory(story, ctx) {
  const hasArt = Boolean(story.image_url);
  return `<article class="s-feature${hasArt ? "" : " no-art"}">
${figure(story)}
<div class="text">
<a href="${attr(storyHref(ctx, story))}">
<h2 class="hed">${esc(story.headline)}</h2>
${when(story.deck, (d) => `<p class="deck">${esc(d)}</p>`)}
</a>
${when(story.summary, (s) => `<p class="sumry">${esc(paragraphs(s)[0] ?? "")}</p>`)}
${byline(story, ctx)}
</div>
</article>`;
}

// Art, headline, summary and byline are siblings rather than one big anchor:
// on narrow screens they are rearranged into a ruled list with the picture
// beside the type, which is only possible if they are all grid children.
function standardStory(story, ctx) {
  const href = attr(storyHref(ctx, story));
  return `<article class="s-standard">
${when(figure(story, { caption: false }), (f) => `<a class="art" href="${href}" tabindex="-1" aria-hidden="true">${f}</a>`)}
<a class="hl" href="${href}">
<h3 class="hed">${esc(story.headline)}</h3>
${when(story.deck, (d) => `<p class="deck">${esc(d)}</p>`)}
</a>
${when(story.summary, (s) => `<p class="sumry">${esc(paragraphs(s)[0] ?? "")}</p>`)}
${byline(story, ctx)}
</article>`;
}

function briefStory(story, ctx) {
  return `<article class="s-brief">
<a href="${attr(storyHref(ctx, story))}"><h3 class="hed">${esc(story.headline)}</h3></a>
${when(story.summary, (s) => `<p class="sumry">${esc(paragraphs(s)[0] ?? "")}</p>`)}
${byline(story, ctx)}
</article>`;
}

function briefingBox(edition) {
  if (!edition.briefing) return "";
  const body = paragraphs(edition.briefing)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");
  return `<aside class="briefing">
<span class="stamp">From the desk</span>
<h2>Jeeves&rsquo; Briefing</h2>
${body}
</aside>`;
}

/** Full-width ruled ticker band, the way a financial paper sets its front. */
function tickerBand(groups) {
  if (!groups.length) return "";
  const segs = groups
    .map(
      (g) => `<div class="tgroup">
<span class="tname">${esc(g.name)}</span>
${g.rows
        .map(
          (r) => `<span class="tick">
<span class="t-label">${esc(r.label)}</span>
<span class="t-val">${esc(r.value)}</span>
<span class="t-chg ${attr(r.direction)}">${esc(r.change)}</span>
</span>`,
        )
        .join("")}
</div>`,
    )
    .join("");
  return `<section class="ticker" aria-label="Market snapshot">${segs}</section>`;
}

function sectionBlock(sec, ctx) {
  const anchor = sec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // Two stories should not sit in a three-column grid with a hole beside them.
  const cols = Math.min(3, Math.max(1, sec.standard.length));
  const wells = [
    sec.feature ? featureStory(sec.feature, ctx) : "",
    sec.feature ? pullQuote(sec.feature) : "",
    sec.standard.length
      ? `<div class="grid3 cols-${cols}">${sec.standard.map((s) => standardStory(s, ctx)).join("")}</div>`
      : "",
  ].join("");

  const briefs = sec.briefs.length
    ? `<aside class="briefs"><h3>In Brief</h3>${sec.briefs.map((s) => briefStory(s, ctx)).join("")}</aside>`
    : "";

  return `<section class="section" id="sec-${attr(anchor)}">
<header class="sectionhead">
<h2>${esc(sec.name)}</h2>
<span class="fill"></span>
<span class="count">${sec.count} ${sec.count === 1 ? "report" : "reports"}</span>
</header>
<div class="section-body${briefs ? " with-briefs" : ""}">
<div class="wells">${wells}</div>
${briefs}
</div>
</section>`;
}

// ── page shell ────────────────────────────────────────────────────────────

function shell({ title, ctx, body, description = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
${when(description, (d) => `<meta name="description" content="${attr(d)}">`)}
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=Bodoni+Moda:opsz,wght@6..96,400;6..96,500;6..96,700&family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,300;1,6..72,400&display=swap">
<link rel="stylesheet" href="${attr(ctx.css ?? ctx.link("/style.css"))}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23faf7f0'/%3E%3Ctext x='16' y='24' font-family='Georgia,serif' font-size='22' font-weight='700' text-anchor='middle' fill='%2315110c'%3EJ%3C/text%3E%3C/svg%3E">
</head>
<body>
<div class="sheet">
${body}
</div>
</body>
</html>`;
}

function nameplate(ctx, { dateIso, edition, editionNo, index = [] }) {
  const long = fmtDate(dateIso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return `<header>
<div class="folio">
<span>${esc(long)}</span>
<span>${esc(edition)}</span>
<span>${editionNo ? `No.&nbsp;${editionNo}` : "Jeeves Intelligence"}</span>
</div>
<a class="masthead" href="${attr(ctx.link("/"))}"><span class="the">The</span>Jeeves Daily</a>
<div class="rule-double"></div>
<nav class="indexstrip">${
    index.length
      ? index
          .map((n) => `<a href="#sec-${attr(n.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">${esc(n)}</a>`)
          .join("")
      : `<a href="${attr(ctx.link("/"))}">Front Page</a>`
  }<a class="ix-archive" href="${attr(ctx.link("/archive"))}">Archive</a></nav>
</header>`;
}

function colophon(ctx, edition) {
  const bits = [
    `<span>The Jeeves Daily &middot; compiled by REPORTER</span>`,
    edition?.coverage ? `<span>Coverage: ${esc(edition.coverage)}</span>` : "",
    edition?.generated_at ? `<span>Filed ${esc(fmtTimestamp(edition.generated_at))}</span>` : "",
    `<span><a href="${attr(ctx.link("/archive"))}">Past editions</a></span>`,
  ];
  return `<footer class="colophon">${bits.filter(Boolean).join("")}</footer>`;
}

// ── pages ─────────────────────────────────────────────────────────────────

export function renderFrontPage(edition, ctx) {
  const plan = planEdition(edition);
  const railInner = [briefingBox(edition), plan.rail.map((s) => railStory(s, ctx)).join("")].join("");

  const body = `${nameplate(ctx, {
    dateIso: edition.date,
    edition: edition.edition,
    editionNo: ctx.editionNo,
    index: plan.index,
  })}
${tickerBand(plan.markets)}
<main>
<div class="frontpage${railInner ? "" : " solo"}">
<div class="leadwell">${plan.lead ? leadStory(plan.lead, ctx) : ""}${plan.subLead ? secondLead(plan.subLead, ctx) : ""}</div>
${railInner ? `<div class="rail">${railInner}</div>` : ""}
</div>
${plan.sections.map((s) => sectionBlock(s, ctx)).join("")}
</main>
${colophon(ctx, edition)}`;

  return shell({
    title: `The Jeeves Daily — ${fmtDate(edition.date, { day: "numeric", month: "long", year: "numeric" })}`,
    description: plan.lead?.headline ?? "",
    ctx,
    body,
  });
}

export function renderArticle(edition, story, ctx) {
  const more = [...edition.bySlug.values()].filter((s) => s.slug !== story.slug).slice(0, 5);
  const prose = paragraphs(story.summary)
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");

  const body = `${nameplate(ctx, {
    dateIso: edition.date,
    edition: edition.edition,
    editionNo: ctx.editionNo,
  })}
<main class="article">
<span class="kicker">${esc(story.section)}</span>
<h1 class="hed">${esc(story.headline)}</h1>
${when(story.deck, (d) => `<p class="deck">${esc(d)}</p>`)}
${byline(story, ctx)}
${figure(story)}
<div class="prose">
${prose}
${when(story.why_it_matters, (t) => `<span class="label">Why it matters</span><p>${esc(t)}</p>`)}
${when(story.what_to_watch, (t) => `<span class="label">What to watch</span><p>${esc(t)}</p>`)}
</div>
${pullQuote(story)}
<div class="origin">
${
  story.url
    ? `This is REPORTER&rsquo;s summary. Read the full piece at <a href="${attr(story.url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(story.source || new URL(story.url).hostname.replace(/^www\./, ""))}&nbsp;&#8599;</a>.`
    : `Filed by REPORTER${when(story.source, (s) => ` from ${esc(s)}`)}. No public link was available.`
}
</div>
</main>
${
  more.length
    ? `<section class="moreedition">
<header class="sectionhead"><h2>Elsewhere in this edition</h2><span class="fill"></span></header>
<ol>${more
        .map(
          (s) =>
            `<li><a href="${attr(storyHref(ctx, s))}"><span class="kicker">${esc(s.section)}</span><h3 class="hed">${esc(s.headline)}</h3></a></li>`,
        )
        .join("")}</ol>
</section>`
    : ""
}
${colophon(ctx, edition)}`;

  return shell({ title: `${story.headline} — The Jeeves Daily`, description: story.deck, ctx, body });
}

export function renderArchive(entries, ctx) {
  const months = [];
  let current = null;
  for (const e of entries) {
    const key = e.date.slice(0, 7);
    if (!current || current.key !== key) {
      current = { key, label: fmtDate(`${key}-01`, { month: "long", year: "numeric" }), rows: [] };
      months.push(current);
    }
    current.rows.push(e);
  }

  const body = `${nameplate(ctx, {
    dateIso: entries[0]?.date ?? ctx.date,
    edition: "Archive",
    editionNo: null,
  })}
<main class="archive">
${
  months.length
    ? months
        .map(
          (m) => `<h2>${esc(m.label)}</h2>
${m.rows
            .map(
              (r) => `<div class="row">
<span class="day">${esc(fmtDate(r.date, { weekday: "short", day: "2-digit" }))}</span>
<a class="lede plain" href="${attr(ctx.link(`/${r.date}`))}">${esc(r.headline || "Edition")}</a>
<span class="n">${r.storyCount} ${r.storyCount === 1 ? "story" : "stories"}</span>
</div>`,
            )
            .join("")}`,
        )
        .join("")
    : `<div class="empty"><h2>No editions yet</h2><p>The first edition will appear here after REPORTER&rsquo;s next morning run.</p></div>`
}
</main>
${colophon(ctx, null)}`;

  return shell({ title: "Archive — The Jeeves Daily", ctx, body });
}

export function renderEmpty(ctx, message) {
  const body = `${nameplate(ctx, { dateIso: ctx.date, edition: "Morning Edition", editionNo: null })}
<main class="empty">
<h2>No edition for this date</h2>
<p>${esc(message)}</p>
<p><a class="plain" href="${attr(ctx.link("/archive"))}">Browse past editions &#8594;</a></p>
</main>`;
  return shell({ title: "The Jeeves Daily", ctx, body });
}
