// SCANNER data (~800 KB) is fetched by scanner.js after the page renders; inlining it made the Review stall on slow
// (relayed) connections while the 44 KB Daily loaded fine.
export function renderScannerSection() {
  return `<section class="section" id="scanner"><header class="sectionhead"><h2>SCANNER</h2><span class="fill"></span><span class="count">Jeeves Manor controls</span></header><div id="scanner-app" class="mc"><div class="mc-loading">Loading SCANNER…</div></div><script type="module" src="/news/library/scanner.js"></script></section>`;
}
