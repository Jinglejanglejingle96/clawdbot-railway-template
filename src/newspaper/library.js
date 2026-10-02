// The Jeeves Review: a monthly, private record of every LIBRARIAN cron run.
// The scheduler remains the source of truth; snapshots make past months durable.
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const exec = promisify(execFile);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const VIEWS = [
  ["High priority", ["REVIEW_REQUIRED"]],
  ["LIBRARIAN validation", ["LIBRARIAN_REVIEW"]],
  ["Experiment queue", ["READY_FOR_EXPERIMENT", "EXPERIMENTING"]],
  ["New discoveries", ["TRIAGED", "DISCOVERED"]],
  ["Validated / adopted", ["VALIDATED", "ADOPTED"]],
  ["Rejected / ignored", ["REJECTED", "IGNORED"]],
  ["Deferred", ["DEFERRED"]],
];
const escape = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const validUrl = (v) => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : ""; } catch { return ""; } };
const monthNow = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit" }).format(now);
const directory = (workspaceDir) => path.join(workspaceDir, "data", "library");
const issuePath = (workspaceDir, month) => path.join(directory(workspaceDir), `${month}.json`);
const readIssue = (workspaceDir, month) => { try { return JSON.parse(fs.readFileSync(issuePath(workspaceDir, month), "utf8")); } catch { return null; } };

async function command(argv, options = {}) {
  const { stdout } = await exec(argv[0], argv.slice(1), { timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...options });
  return JSON.parse(stdout);
}

export function librarianJobs(jobs) {
  return jobs.filter((job) => /^librarian[-:]/i.test(job.name ?? "") || /^librarian:/i.test(job.declarationKey ?? ""));
}

function fullResults(workspaceDir, job) {
  const dir = path.join(directory(workspaceDir), "full", job.id);
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return null; }
    }).filter((entry) => entry && typeof entry.content === "string" && Number.isFinite(Date.parse(entry.started_at)));
  } catch { return []; }
}

export function assembleIssue(month, jobs, histories, scanner, captures = {}) {
  return {
    month,
    refreshed_at: new Date().toISOString(),
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.displayName || job.name,
      schedule: job.schedule?.expr ?? "",
      enabled: job.enabled,
      runs: (histories[job.id] ?? []).filter((run) => {
        const at = run.runAtMs ?? run.ts;
        return Number.isFinite(at) && monthNow(new Date(at)) === month && run.action === "finished";
      }).sort((a, b) => (b.runAtMs ?? b.ts) - (a.runAtMs ?? a.ts)).map((run) => ({
        at: run.runAtIso ?? new Date(run.runAtMs ?? run.ts).toISOString(),
        status: run.status ?? "unknown",
        summary: (captures[job.id] ?? []).find((entry) => Math.abs(Date.parse(entry.started_at) - (run.runAtMs ?? run.ts)) < 5 * 60_000)?.content ?? run.summary ?? "No user-facing result recorded.",
        delivery: run.deliveryStatus ?? "",
        runId: run.sessionId ?? "",
      })),
    })),
    scanner: scanner?.available ? scanner : null,
  };
}

export async function refreshIssue(workspaceDir, month = monthNow(), run = command) {
  if (!MONTH.test(month)) throw new Error("invalid month");
  const cli = process.env.OPENCLAW_ENTRY?.trim();
  const openclaw = (...args) => run(cli ? [process.execPath, cli, ...args] : ["openclaw", ...args]);
  const listing = await openclaw("cron", "list", "--json");
  const jobs = librarianJobs(listing.jobs ?? []);
  const results = await Promise.allSettled(jobs.map((job) => openclaw("cron", "runs", "--id", job.id, "--limit", "200", "--json")));
  const prior = readIssue(workspaceDir, month);
  const histories = {};
  for (let i = 0; i < jobs.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") histories[jobs[i].id] = result.value.entries ?? [];
    else histories[jobs[i].id] = (prior?.jobs.find((j) => j.id === jobs[i].id)?.runs ?? []).map((r) => ({ ...r, runAtIso: r.at, runAtMs: Date.parse(r.at), action: "finished" }));
  }
  let scanner = prior?.scanner ?? null;
  try {
    scanner = await run(["python3", "-c", "import json; from scripts.observability_cli import op_scanner; print(json.dumps(op_scanner({}), default=str))"], { cwd: workspaceDir });
  } catch { /* Keep the most recent snapshot. */ }
  const captures = Object.fromEntries(jobs.map((job) => [job.id, fullResults(workspaceDir, job)]));
  const issue = assembleIssue(month, jobs, histories, scanner, captures);
  fs.mkdirSync(directory(workspaceDir), { recursive: true });
  const target = issuePath(workspaceDir, month);
  fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(issue, null, 2)}\n`);
  fs.renameSync(`${target}.tmp`, target);
  return issue;
}

function scannerSection(scanner) {
  if (!scanner) return '<section class="section" id="scanner"><header class="sectionhead"><h2>SCANNER</h2></header><p>SCANNER data is temporarily unavailable.</p></section>';
  const m = scanner.metrics ?? {};
  const items = scanner.items ?? [];
  const stat = (label, value) => `<div class="library-stat"><small>${escape(label)}</small><strong>${escape(value ?? "—")}</strong></div>`;
  return `<section class="section" id="scanner"><header class="sectionhead"><h2>SCANNER</h2><span class="fill"></span><span class="count">Jeeves Manor view</span></header>
<div class="library-scanner-hero">${stat("SCANNER is", scanner.config?.enabled ? "scouting" : "paused")}${stat("Precision", m.precision?.value == null ? "—" : `${Math.round(m.precision.value * 100)}%`)}${stat("Idea to decision", m.avg_days_discovery_to_decision == null ? "—" : `${m.avg_days_discovery_to_decision} d`)}</div>
<div class="library-scanner-stats">${[["Discovered", m.items_discovered], ["Filtered without a model", m.items_filtered], ["Jev triage", m.jev_triage_count], ["Duplicates suppressed", m.duplicate_suppression_count], ["LIBRARIAN referrals", m.librarian_referrals], ["ENGINEER candidates", m.improvement_candidates_created]].map(([k,v]) => stat(k,v)).join("")}</div>
<div class="library-scanner-views">${VIEWS.map(([label, statuses], n) => `<details ${n === 0 ? "open" : ""}><summary>${escape(label)} (${items.filter((item) => statuses.includes(item.status)).length})</summary><div class="library-scanner-grid"><table><thead><tr><th>candidate</th><th>subsystem</th><th>relevance / novelty / benefit</th><th>evidence</th></tr></thead><tbody>${items.filter((item) => statuses.includes(item.status)).map((item) => `<tr><td><details><summary><strong>${escape(item.title)}</strong></summary><p>${escape(item.summary)}</p><p>${escape(item.status)} · ${escape(item.source_type)} · ${escape(item.first_seen)}</p>${validUrl(item.url) ? `<a href="${escape(validUrl(item.url))}" target="_blank" rel="noopener noreferrer">Source ↗</a>` : ""}<p>${escape(item.librarian?.audit?.excerpt ?? item.librarian?.question ?? "")}</p><p>${escape(item.decision?.why ?? "")}</p></details></td><td>${escape((item.subsystems ?? []).join(", "))}</td><td>${escape(item.scores ? `${item.scores.relevance} / ${item.scores.novelty} / ${item.scores.expected_benefit}` : "untriaged")}</td><td>${escape(item.scores?.evidence_quality ?? "—")}</td></tr>`).join("") || '<tr><td colspan="4">Nothing here.</td></tr>'}</tbody></table></div></details>`).join("")}</div>
<div class="library-scanner-grid"><div><h3>Source health</h3><table><thead><tr><th>source</th><th>last ok</th><th>items / new</th><th>error</th></tr></thead><tbody>${(scanner.sources ?? []).map((s) => `<tr><td>${escape(s.id)}</td><td>${escape(s.last_ok ?? "—")}</td><td>${escape(`${s.items ?? 0} / ${s.new_items ?? 0}`)}</td><td>${escape(s.last_error ?? "—")}</td></tr>`).join("")}</tbody></table></div><div><h3>Topics & watchlist</h3><ul>${Object.entries(scanner.config?.topics ?? {}).map(([name, value]) => `<li>${escape(name)} ×${escape(value.weight)} <small>${escape((value.terms ?? []).join(", "))}</small></li>`).join("")}</ul></div></div></section>`;
}

export function renderLibrary(issue, { link, css }) {
  const month = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${issue.month}-01T12:00:00Z`));
  const count = issue.jobs.reduce((sum, job) => sum + job.runs.length, 0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>The Jeeves Review — ${escape(month)}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=Bodoni+Moda:opsz,wght@6..96,400;6..96,500;6..96,700&family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,300;1,6..72,400&display=swap"><link rel="stylesheet" href="${escape(css)}"><style>
.library-intro{font-family:var(--sans);color:var(--muted);font-size:.85rem;margin:2rem 0}.library-jobs{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.5rem}.library-job{border-top:2px solid var(--ink);padding-top:.7rem}.library-job h2{font:600 1.3rem var(--serif);margin:.2rem 0}.library-run{border-top:1px solid var(--rule);padding:.6rem 0}.library-run summary{cursor:pointer;font-family:var(--sans);font-size:.8rem}.library-run pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}.library-scanner-hero,.library-scanner-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1rem;margin:1rem 0}.library-stat{border-top:1px solid var(--rule);padding:.6rem 0}.library-stat small{display:block;font:600 .65rem var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.library-stat strong{font-size:1.3rem}.library-scanner-views details{border-top:1px solid var(--rule);padding:.6rem 0}.library-scanner-views summary{cursor:pointer}.library-scanner-grid{overflow-x:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}.library-scanner-grid table{border-collapse:collapse;width:100%;font: .78rem var(--sans)}.library-scanner-grid td,.library-scanner-grid th{border-bottom:1px solid var(--rule);padding:.5rem;text-align:left;vertical-align:top}.library-scanner-grid td summary{list-style:none}.library-scanner-grid li{margin:.5rem 0}
</style></head><body><div class="sheet"><header><div class="folio"><span>${escape(month)}</span><span>Monthly Edition</span><span>${count} runs</span></div><a class="masthead" href="${escape(link(""))}"><span class="the">The</span>Jeeves Review</a><div class="rule-double"></div><nav class="indexstrip"><a href="#librarian">LIBRARIAN</a><a href="#scanner">SCANNER</a><a href="${escape(link("/daily"))}">Jeeves Daily</a><a class="ix-archive" href="${escape(link("/archive"))}">Archive</a></nav></header><main><p class="library-intro">LIBRARIAN’s scheduled work for ${escape(month)}. Updated ${escape(issue.refreshed_at)}. Full results appear where archived; older long results may show the scheduler’s shortened summary.</p><section class="section" id="librarian"><header class="sectionhead"><h2>LIBRARIAN</h2><span class="fill"></span><span class="count">${issue.jobs.length} jobs</span></header><div class="library-jobs">${issue.jobs.map((job) => `<div class="library-job"><h2>${escape(job.name)}</h2><p>${escape(job.schedule)} · ${job.enabled ? "enabled" : "disabled"} · ${job.runs.length} runs</p>${job.runs.map((run) => `<details class="library-run"><summary>${escape(run.at)} · ${escape(run.status)}${run.delivery ? ` · ${escape(run.delivery)}` : ""}</summary><pre>${escape(run.summary)}</pre></details>`).join("") || '<p>No runs this month.</p>'}</div>`).join("")}</div></section>${scannerSection(issue.scanner)}</main><footer class="colophon">The Jeeves Review · compiled from LIBRARIAN cron history and SCANNER’s Manor data</footer></div></body></html>`;
}

export function listIssues(workspaceDir) {
  try { return fs.readdirSync(directory(workspaceDir)).filter((n) => MONTH.test(n.slice(0, -5)) && n.endsWith(".json")).map((n) => n.slice(0, -5)).sort().reverse(); } catch { return []; }
}
export { monthNow, readIssue, MONTH };
