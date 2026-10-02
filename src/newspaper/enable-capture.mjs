// One-time, additive migration for the five existing LIBRARIAN agent crons.
// Preview by default; --apply appends the archival instruction in place.
import { execFileSync } from "node:child_process";

const cli = process.env.OPENCLAW_ENTRY?.trim();
const openclaw = (...args) => execFileSync(cli ? process.execPath : "openclaw", cli ? [cli, ...args] : args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const jobs = JSON.parse(openclaw("cron", "list", "--json")).jobs ?? [];
const marker = "THE JEEVES REVIEW ARCHIVE";
const selected = jobs.filter((job) => /^librarian-/i.test(job.name ?? "") && job.payload?.kind === "agentTurn");
for (const job of selected) {
  if (job.payload.message.includes(marker)) {
    process.stdout.write(`${job.name}: already enabled\n`);
    continue;
  }
  const appendix = `\n\n${marker}: At the start of this run, note the current UTC timestamp as started_at. After preparing the complete final result and before finishing, write one UTF-8 JSON file at /data/workspace/data/library/full/${job.id}/<started_at-without-punctuation>.json with fields started_at (ISO 8601) and content (the complete user-facing result, verbatim). Create the directory if needed. For a silent run, write content as an empty string. This is a private archive copy; do not include credentials or unrelated tool output. Keep every existing instruction, delivery rule and normal Telegram behavior. If the archive write fails, report that operational failure in the cron result.`;
  if (process.argv.includes("--apply")) {
    openclaw("cron", "edit", job.id, "--message", `${job.payload.message}${appendix}`);
    process.stdout.write(`${job.name}: enabled\n`);
  } else {
    process.stdout.write(`${job.name}: would append archive instruction\n`);
  }
}
