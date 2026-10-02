export function renderScannerSection(scanner) {
  const data = JSON.stringify(scanner ?? { available: false, reason: "SCANNER has not run yet" })
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<section class="section" id="scanner"><header class="sectionhead"><h2>SCANNER</h2><span class="fill"></span><span class="count">Jeeves Manor controls</span></header><div id="scanner-app" class="mc"><div class="mc-loading">Loading SCANNER…</div></div><script id="scanner-data" type="application/json">${data}</script><script type="module" src="/news/library/scanner.js"></script></section>`;
}
