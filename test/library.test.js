import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assembleIssue, librarianJobs, monthNow, readIssue, refreshIssue, renderLibrary } from "../src/newspaper/library.js";
import { articlesFromIssue, linkedArticles } from "../src/newspaper/library-articles.js";
import { renderLibraryPage } from "../src/newspaper/library-page.js";
import { validScannerAction } from "../src/newspaper/library.js";

test("every LIBRARIAN job is included, including silent and failed runs, within the London month", () => {
  const jobs = [
    { id: "a", name: "librarian-digest-daily", enabled: true },
    { id: "b", name: "librarian-phone-triage", enabled: true },
    { id: "c", name: "reporter-morning", enabled: true },
  ];
  assert.equal(monthNow(new Date("2026-09-30T23:30:00Z")), "2026-10");
  const chosen = librarianJobs(jobs);
  const issue = assembleIssue("2026-10", chosen, {
    a: [{ action: "finished", runAtMs: Date.parse("2026-09-30T23:30:00Z"), status: "ok", summary: "Paper" }],
    b: [{ action: "finished", runAtMs: Date.parse("2026-10-01T08:00:00Z"), status: "error" },
      { action: "finished", runAtMs: Date.parse("2026-09-30T08:00:00Z"), status: "ok" }],
  }, null);
  assert.equal(issue.jobs.length, 2);
  assert.deepEqual(issue.jobs.map((j) => j.runs.length), [1, 1]);
  assert.equal(issue.jobs[1].runs[0].summary, "No user-facing result recorded.");
});

test("publication escapes cron and SCANNER text", () => {
  const issue = assembleIssue("2026-10", [{ id: "a", name: "librarian-digest", enabled: true }], {
    a: [{ action: "finished", runAtMs: Date.parse("2026-10-01T12:00:00Z"), summary: "<script>alert(1)</script>" }],
  }, { available: true, items: [{ title: "<img src=x>", status: "REVIEW_REQUIRED" }], metrics: {}, config: {}, sources: [] });
  const html = renderLibrary(issue, { link: (p) => `/news/library${p}`, css: "/news/style.css" });
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /SCANNER/);
});

test("complete archival copy replaces the scheduler's shortened summary", () => {
  const at = Date.parse("2026-10-01T20:00:00Z");
  const issue = assembleIssue("2026-10", [{ id: "a", name: "librarian-digest", enabled: true }], {
    a: [{ action: "finished", runAtMs: at, summary: "Short…" }],
  }, null, { a: [{ started_at: "2026-10-01T20:00:10Z", content: "Complete report with every item" }] });
  assert.equal(issue.jobs[0].runs[0].summary, "Complete report with every item");
});

test("curated items render as linked reports with source, summary and analysis", () => {
  const at = Date.parse("2026-10-01T20:00:00Z");
  const issue = assembleIssue("2026-10", [{ id: "a", name: "librarian-digest", enabled: true }], {
    a: [{ action: "finished", runAtMs: at, summary: "Short" }],
  }, { available: true, items: [], metrics: {}, config: {}, sources: [] }, {
    a: [{ started_at: "2026-10-01T20:00:10Z", content: "Complete", items: [
      { title: "A useful paper", url: "https://example.org/paper", source: "Journal", summary: "Findings", analysis: "Relevant to Jeeves", limitations: "Small sample", priority: 5 },
      { title: "No source", summary: "Must not invent a link" },
    ] }],
  });
  const edition = articlesFromIssue(issue);
  assert.equal(edition.storyCount, 1);
  const html = renderLibraryPage(issue, { link: (p) => `/news/library${p}`, css: "/news/style.css", scannerCss: "/news/library/scanner.css" });
  assert.match(html, /A useful paper/);
  assert.match(html, /Findings/);
  assert.match(html, /https:\/\/example.org\/paper/);
  assert.match(html, /id="scanner-app"/);
  assert.match(html, /Run archive/);
  assert.doesNotMatch(html, /No source/);
  assert.equal(edition.lead.why_it_matters, "Relevant to Jeeves");
});

test("SCANNER action endpoint accepts only Manor actions", () => {
  assert.equal(validScannerAction({ action: "feedback", key: "candidate", signal: "very_relevant" }), true);
  assert.equal(validScannerAction({ action: "deepdive", key: "candidate" }), true);
  assert.equal(validScannerAction({ action: "status", key: "candidate", status: "ADOPTED" }), true);
  assert.equal(validScannerAction({ action: "status", key: "candidate", status: "DELETED" }), false);
  assert.equal(validScannerAction({ action: "feedback", key: "candidate", signal: "erase" }), false);
});

test("old ranked newsletter entries keep each article's own link", () => {
  const items = linkedArticles("## TLDR Data\n* **[5/5] First paper**\n  * **Link:** https://example.org/one\n  * **Summary:** First summary\n* **[4/5] Second paper**\n  * **Link:** https://example.org/two\n  * **Summary:** Second summary");
  assert.deepEqual(items.map((item) => [item.title, item.url]), [
    ["First paper", "https://example.org/one"], ["Second paper", "https://example.org/two"],
  ]);
});

test("refresh writes the monthly snapshot from scheduler and SCANNER", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "jr-"));
  try {
    const calls = [];
    const run = async (argv) => {
      calls.push(argv);
      if (argv.includes("list")) return { jobs: [{ id: "a", name: "librarian-digest-daily", enabled: true }] };
      if (argv.includes("runs")) return { entries: [{ action: "finished", runAtMs: Date.parse("2026-10-01T20:00:00Z"), summary: "Full result" }] };
      return { available: true, items: [], metrics: {}, config: {}, sources: [] };
    };
    const issue = await refreshIssue(ws, "2026-10", run);
    assert.equal(issue.jobs[0].runs[0].summary, "Full result");
    assert.equal(readIssue(ws, "2026-10").scanner.available, true);
    assert.equal(calls.length, 3);
    assert.ok(calls[1].includes("200"));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
