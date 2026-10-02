import { articlesFromIssue } from "./library-articles.js";
import { renderFrontPage } from "./render.js";
import { renderScannerSection } from "./scanner-view.js";

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function libraryEdition(issue, ctx = {}) {
  return articlesFromIssue(issue, { since: ctx.since, extraIssues: ctx.extraIssues });
}

export function renderLibraryPage(issue, ctx) {
  const edition = libraryEdition(issue, ctx);
  const count = issue.jobs.reduce((n, job) => n + job.runs.length, 0);
  const logs = `<section class="section" id="runs"><header class="sectionhead"><h2>Run archive</h2><span class="fill"></span><span class="count">${count} runs from ${issue.jobs.length} jobs</span></header><p class="library-note">LIBRARIAN’s complete scheduled work for this month. Earlier results may only have the scheduler’s shortened summary.</p><div class="library-jobs">${issue.jobs.map((job) => `<div class="library-job"><h3>${esc(job.name)}</h3><p>${esc(job.schedule)} · ${job.enabled ? "enabled" : "disabled"} · ${job.runs.length} runs</p>${job.runs.map((run) => `<details><summary>${esc(run.at)} · ${esc(run.status)}</summary><pre>${esc(run.summary)}</pre></details>`).join("") || "<p>No runs this month.</p>"}</div>`).join("")}</div></section>`;
  return renderFrontPage(edition, {
    ...ctx,
    date: edition.date,
    publication: "Jeeves Review",
    compiler: "LIBRARIAN",
    dateLabel: new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${issue.month}-01T12:00:00Z`)),
    extraCss: ctx.scannerCss,
    index: [],
    extraIndex: '<a href="#librarian">LIBRARIAN</a><a href="#scanner">SCANNER</a><a href="#runs">Run archive</a>',
    beforeSections: `<section id="librarian"><p class="library-note">${edition.storyCount} curated articles, papers and other reading items ${ctx.since ? "this week" : "this month"}. Each report links to its original source.${ctx.since ? " The reading feed starts fresh every Sunday at 23:00 London time." : ""}</p></section>`,
    afterSections: `${edition.storyCount ? "" : '<section class="section" id="sec-librarian"><header class="sectionhead"><h2>LIBRARIAN</h2></header><p>No curated articles with original links have been filed in this period yet.</p></section>'}${renderScannerSection(issue.scanner)}${logs}`,
  });
}
