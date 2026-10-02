// Same SCANNER view and actions as Jeeves Manor, rendered inside the Review.
const root = document.getElementById("scanner-app");
const state = {
  data: JSON.parse(document.getElementById("scanner-data").textContent),
  view: "priority", open: null, busy: false, message: "",
};
const VIEWS = [
  ["priority", "High priority", ["REVIEW_REQUIRED"]],
  ["librarian", "LIBRARIAN validation", ["LIBRARIAN_REVIEW"]],
  ["experiments", "Experiment queue", ["READY_FOR_EXPERIMENT", "EXPERIMENTING"]],
  ["new", "New discoveries", ["TRIAGED", "DISCOVERED"]],
  ["validated", "Validated / adopted", ["VALIDATED", "ADOPTED"]],
  ["rejected", "Rejected / ignored", ["REJECTED", "IGNORED"]],
  ["deferred", "Deferred", ["DEFERRED"]],
];
const DIMS = ["relevance", "novelty", "expected_benefit", "implementation_effort", "evidence_quality", "maturity", "compatibility", "risk", "dependency_cost", "duplication"];
const ACTIONS = [
  ["Very relevant", { action: "feedback", signal: "very_relevant" }],
  ["More like this", { action: "feedback", signal: "more_like_this" }],
  ["Already have this", { action: "feedback", signal: "already_have" }],
  ["Too speculative", { action: "feedback", signal: "too_speculative" }],
  ["Not useful", { action: "feedback", signal: "not_useful" }],
  ["Send to LIBRARIAN", { action: "refer" }],
  ["Deep dive (first in queue)", { action: "deepdive" }],
  ["Create experiment candidate", { action: "promote" }],
  ["Defer", { action: "status", status: "DEFERRED", why: "deferred in The Jeeves Review" }],
  ["Mark adopted", { action: "status", status: "ADOPTED", why: "adopted" }],
];
const e = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const url = (v) => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : ""; } catch { return ""; } };
const ago = (v) => { if (!v) return "never"; const s = (Date.now() - Date.parse(v)) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const tag = (v, tone = "") => `<span class="mc-tag ${tone}">${e(v)}</span>`;
const panel = (title, body, aside = "") => `<section class="mc-panel"><header><h3>${e(title)}</h3>${aside ? `<span class="mc-aside">${aside}</span>` : ""}</header>${body}</section>`;
const stat = (label, value, note = "") => `<div class="mc-stat"><span>${e(label)}</span><strong>${e(value ?? "—")}</strong>${note ? `<small>${e(note)}</small>` : ""}</div>`;
const kv = (rows) => `<dl class="mc-kv">${rows.filter((r) => r[1] != null).map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join("")}</dl>`;
const statusTone = (v) => v === "HIGH" || v === "LARGE" || v === "MATURE" ? "ok" : v === "LOW" || v === "NONE" || v === "ABANDONED" ? "bad" : "";

function detail(item) {
  if (!item) return panel("Candidate detail", '<p class="mc-gap">Pick a candidate.</p>');
  const s = item.scores ?? {};
  const source = url(item.url);
  const dims = item.scores ? `<div class="mc-wd-dims">${DIMS.map((key) => `<span>${e(key.replaceAll("_", " "))} ${tag(s[key] ?? "—", statusTone(s[key]))}</span>`).join("")}</div>` : "";
  const rows = [
    ["Subsystems", (item.triage?.subsystems ?? []).map((x) => `${x[0]} ${x[1]}`).join(" · ") || "—"],
    ["Closest in Jeeves", (item.triage?.novelty?.closest ?? []).map((x) => x.id).join(" · ") || "—"],
    ["Licence", item.meta?.license ?? "none found"],
    ["Activity", item.meta?.pushed_at ? `pushed ${ago(item.meta.pushed_at)}${item.meta.latest_release ? ` · ${item.meta.latest_release.tag}` : ""}` : null],
    ["Alternatives", (item.alternatives ?? []).map((x) => x.title).join(", ") || "none clustered"],
    ["LIBRARIAN", item.librarian?.audit ? `evidence ${item.librarian.audit.quality} - ${item.librarian.audit.excerpt}` : item.librarian?.question ? `asked: ${item.librarian.question}` : "not referred"],
    ["Experiment", item.engineer ? `${item.engineer.id}: ${item.engineer.status}${item.engineer.result ? ` - ${item.engineer.result.verdict} (${item.engineer.result.why})` : ""}` : item.candidate_id ?? "none"],
    ["Decision", item.decision ? `${item.decision.status} ${ago(item.decision.at)}: ${item.decision.why}${item.decision.reconsider_if ? ` · reconsider if ${item.decision.reconsider_if}` : ""}` : null],
  ];
  const criteria = item.engineer?.result?.criteria?.length ? `<table class="mc-table"><tbody>${item.engineer.result.criteria.map((c) => `<tr><td>${e(c.metric)}</td><td>${e(c.baseline ?? "—")} → ${e(c.candidate ?? "—")}</td><td>${c.passed == null ? "—" : tag(c.passed ? "pass" : "fail", c.passed ? "ok" : "bad")}</td></tr>`).join("")}</tbody></table>` : "";
  const buttons = ACTIONS.map(([label, body], n) => `<button data-action="${n}" ${state.busy || (body.action === "refer" && item.deepdive_id) || (body.action === "promote" && item.candidate_id) ? "disabled" : ""}>${e(label)}</button>${n === 4 ? "<br>" : ""}`).join("");
  return panel(item.title, `<p>${e(item.summary)}</p><p>${tag(item.status)} ${e(item.source_type)} · ${e((item.source_ids ?? []).join(", "))} · found ${e(ago(item.first_seen))}${item.triage?.kind ? ` · ${e(item.triage.kind.replaceAll("_", " ").toLowerCase())}` : ""}</p>${dims}${(item.flags ?? []).length ? `<p>${item.flags.map((f) => tag(f, /untrusted|abandoned|licence/.test(f) ? "bad" : "warn")).join("")}</p>` : ""}${kv(rows)}${criteria}<div class="mc-actions mc-wd-actions">${buttons}</div>${state.message ? `<p class="mc-muted" role="status">${e(state.message)}</p>` : ""}<h4>History</h4><ul class="mc-list tight">${(item.history ?? []).slice(-8).reverse().map((h) => `<li>${e(h.e)}<small>${e(ago(h.at))}</small></li>`).join("")}</ul>`, source ? `<a href="${e(source)}" target="_blank" rel="noopener noreferrer">source</a>` : "");
}

function render() {
  const d = state.data;
  if (!d?.available) { root.innerHTML = `<p class="mc-gap">SCANNER: ${e(d?.reason ?? "not available")}</p>`; return; }
  const m = d.metrics ?? {}, config = d.config ?? {}, all = d.items ?? [];
  const [_, label, statuses] = VIEWS.find(([id]) => id === state.view) ?? VIEWS[0];
  const items = all.filter((item) => statuses.includes(item.status));
  const selected = all.find((item) => item.key === state.open);
  const table = items.length ? `<table class="mc-table"><thead><tr><th>candidate</th><th>subsystem</th><th>relevance / novelty / benefit</th><th>evidence</th></tr></thead><tbody>${items.slice(0, 60).map((item) => `<tr data-item="${e(item.key)}" class="${item.key === state.open ? "sel" : ""}" tabindex="0"><td>${item.tier ? tag(item.tier, item.tier === "HIGH" ? "ok" : "") : ""} <strong>${e(item.title)}</strong><small>${e((item.summary ?? "").slice(0, 120))}</small></td><td>${e((item.subsystems ?? []).join(", ") || "—")}</td><td>${item.scores ? e(`${item.scores.relevance} / ${item.scores.novelty} / ${item.scores.expected_benefit}`) : '<span class="mc-muted">untriaged</span>'}</td><td>${e(item.scores?.evidence_quality ?? "—")}</td></tr>`).join("")}</tbody></table>` : '<p class="mc-gap">Nothing here.</p>';
  const health = `<table class="mc-table"><thead><tr><th>source</th><th>last ok</th><th>items / new</th><th>error</th></tr></thead><tbody>${(d.sources ?? []).map((s) => `<tr><td><code>${e(s.id)}</code></td><td>${e(ago(s.last_ok))}</td><td>${e(`${s.items} / ${s.new_items}`)}</td><td>${e(s.last_error ?? "—")}</td></tr>`).join("")}</tbody></table><p class="mc-muted">Filtered without a model: ${e(Object.entries(d.filtered ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ") || "none")}</p>`;
  const topics = `<ul class="mc-list tight">${Object.entries(config.topics ?? {}).map(([name, value]) => `<li><strong>${e(name)}</strong> ×${e(value.weight)} <small>${e((value.terms ?? []).join(", "))}</small></li>`).join("")}</ul><h4>Sources</h4><ul class="mc-list tight">${(config.sources ?? []).map((s) => `<li>${tag(s.type, s.enabled === false ? "bad" : "")} ${e(s.repo ?? s.query)} <small>${e(s.topic)}</small></li>`).join("")}</ul>`;
  root.innerHTML = `<div class="mc-body mc-overview"><section class="mc-hero"><div><span class="mc-eyebrow">SCANNER is</span><h1>${tag(config.enabled ? "scouting" : "paused", config.enabled ? "ok" : "bad")}</h1><p>digest ${e(config.digest_cadence)} · last sent ${e(ago(d.last_digest))} · ${(config.sources ?? []).filter((s) => s.enabled !== false).length} sources</p></div><div><span class="mc-eyebrow">Precision (the metric that matters)</span><h1>${m.precision?.value == null ? "—" : `${Math.round(m.precision.value * 100)}%`}</h1><p>${e(m.precision?.useful)} useful of ${e(m.precision?.decided)} decided HIGH candidates (${e(m.precision?.surfaced_high)} surfaced)</p></div><div><span class="mc-eyebrow">Idea to decision</span><h1>${m.avg_days_discovery_to_decision == null ? "—" : `${e(m.avg_days_discovery_to_decision)} d`}</h1><p>${e(m.validated_candidates)} validated · ${e(m.rejected_candidates)} rejected · ${e(m.experiments_created)} experiments</p></div></section><div class="mc-stats">${stat(`Discovered (${m.window_days} d)`, m.items_discovered, `${m.sources_scanned} source scans`)}${stat("Filtered without a model", m.items_filtered)}${stat("Jev triage", m.jev_triage_count, `${m.strong_model_calls} strong-model calls`)}${stat("Duplicates suppressed", m.duplicate_suppression_count, `${m.rejected_suppressed} rejected ideas not re-raised`)}${stat("LIBRARIAN referrals", m.librarian_referrals)}${stat("ENGINEER candidates", m.improvement_candidates_created)}</div><nav class="mc-chips">${VIEWS.map(([id, title, st]) => `<button data-view="${id}" class="${state.view === id ? "on" : ""}">${e(title)} (${all.filter((item) => st.includes(item.status)).length})</button>`).join("")}</nav><div class="mc-wd-main">${panel(label, table)}${detail(selected)}</div><div class="mc-grid-2">${panel("Source health", health)}${panel("Topics & watchlist", topics, "change them by telling Jeeves")}</div></div>`;
}

const suffix = new URLSearchParams(location.search).get("k");
const auth = suffix ? `?k=${encodeURIComponent(suffix)}` : "";
root.addEventListener("click", async (event) => {
  const view = event.target.closest("[data-view]");
  if (view) { state.view = view.dataset.view; state.open = null; state.message = ""; render(); return; }
  const item = event.target.closest("[data-item]");
  if (item) { state.open = item.dataset.item; state.message = ""; render(); return; }
  const button = event.target.closest("[data-action]");
  if (!button || state.busy || !state.open) return;
  const action = ACTIONS[Number(button.dataset.action)]?.[1];
  if (!action) return;
  state.busy = true; state.message = "Working…"; render();
  try {
    const response = await fetch(`/news/library/scanner/action${auth}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...action, key: state.open }) });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error ?? `Request failed (${response.status})`);
    state.message = result.candidate_id ? `ENGINEER candidate ${result.candidate_id} created - approve it in Jeeves to start` : "Done.";
    const fresh = await fetch(`/news/library/scanner/data${auth}`, { credentials: "same-origin" });
    if (fresh.ok) state.data = await fresh.json();
  } catch (error) { state.message = `Refused: ${error.message}`; }
  state.busy = false; render();
});
root.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-item]")) { event.preventDefault(); state.open = event.target.dataset.item; render(); }
});
render();
