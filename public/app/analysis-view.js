// Analysis tab: which slot options predict high ratings, limiting factors per model, CSV/JSONL export.

import { $, store, state, escapeHtml, fmtCost, on, emit, optionsHtml, modelName, download } from "./util.js";
import { RATINGS, SOLID, isRated } from "../lib/ratings.js";
import { slotStats, modelStats, overallStats, imagesCSV, slotStatsCSV, toJSONL, exportRecord, listBatches, DEFAULT_MIN_SAMPLES } from "../lib/analysis.js";

// batch: "" = all images, "*" = every batch image, otherwise one batch id.
let opts = { model: "", batch: "", minSamples: DEFAULT_MIN_SAMPLES, ...store.get("analysis:opts", {}) };
if (opts.batchOnly) opts.batch = "*"; // setting from before the batch picker existed
delete opts.batchOnly;
const isActive = () => !$("tab-analysis").classList.contains("hidden");

export function initAnalysis() {
  $("aMin").value = opts.minSamples;
  render();
}

const inBatch = (r) => !opts.batch || (opts.batch === "*" ? r.kind === "batch" : r.batch_id === opts.batch);
const records = () => state.library.filter((r) => (!opts.model || r.model === opts.model) && inBatch(r));

// Batch ids are ISO timestamps with ":" and "." replaced by "-".
const batchDate = (id) => new Date(id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z"));
function batchLabel(b) {
  const when = batchDate(b.id).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const models = b.models.length > 1 ? `${b.models.length} models` : modelName(b.models[0]);
  return `${b.name ? `${b.name} · ` : ""}${when} · ${b.count} images, ${b.rated} rated · ${models}`;
}

function renderBatchOptions() {
  const batches = listBatches(state.library);
  const entries = batches.map((b) => [b.id, batchLabel(b)]);
  // A batch that was just started has no images yet; keep it selectable.
  if (opts.batch && opts.batch !== "*" && !batches.some((b) => b.id === opts.batch)) entries.unshift([opts.batch, "Selected batch (no images yet)"]);
  $("aBatch").innerHTML = [["", "All images"], ["*", "All batches"], ...entries]
    .map(([v, l]) => `<option value="${escapeHtml(v)}" ${v === opts.batch ? "selected" : ""}>${escapeHtml(l)}</option>`).join("");
}

const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const avg = (x) => (x == null ? "—" : x.toFixed(2));
// x is a 1–7 score.
const ratingName = (x) => (x == null ? "" : RATINGS[Math.round(x) - 1]);

export function render() {
  renderBatchOptions();
  const models = [...new Set(state.library.map((r) => r.model))].sort();
  $("aModel").innerHTML = `<option value="">All models</option>` +
    models.map((m) => `<option value="${escapeHtml(m)}" ${m === opts.model ? "selected" : ""}>${escapeHtml(modelName(m))}</option>`).join("");

  const recs = records();
  const o = overallStats(recs);
  const cost = recs.reduce((s, r) => s + (r.cost || 0), 0);
  $("aSummary").innerHTML = [
    ["Images", recs.length],
    ["Rated", o.count],
    ["Average", o.mean == null ? "—" : `${avg(o.mean)} <small>${escapeHtml(ratingName(o.mean))}</small>`],
    [`≥ ${RATINGS[SOLID]}`, pct(o.solidShare)],
    ["Spend", fmtCost(cost)],
  ].map(([k, v]) => `<div class="tile"><span>${escapeHtml(k)}</span><b>${v}</b></div>`).join("");

  const stats = slotStats(recs, { minSamples: opts.minSamples });
  $("aSlots").innerHTML = Object.keys(stats).length
    ? Object.entries(stats).map(([slot, rows]) => `
      <div class="panel">
        <h2>{${escapeHtml(slot)}}</h2>
        <table class="stats">
          <thead><tr><th>Option</th><th class="num">n</th><th class="num">Avg (1–7)</th><th></th><th class="num">≥ Solid</th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr class="${r.lowSample ? "low" : ""}" data-slot="${escapeHtml(slot)}" data-value="${escapeHtml(r.option)}" title="Show these images in Rate">
              <td>${escapeHtml(r.option)}${r.lowSample ? ` <span class="badge dim" title="Fewer than ${opts.minSamples} rated images, so not reliable yet">few samples</span>` : ""}</td>
              <td class="num">${r.count}</td>
              <td class="num">${avg(r.mean)}</td>
              <td class="barcell"><div class="bar" style="width:${(((r.mean ?? 1) - 1) / 6) * 100}%"></div></td>
              <td class="num">${pct(r.solidShare)}</td>
            </tr>`).join("")}</tbody>
        </table>
      </div>`).join("")
    : '<p class="desc">No rated images with slot picks yet. Run a batch from the Batch tab, then rate the results in Rate.</p>';

  const ms = modelStats(recs);
  $("aModels").innerHTML = ms.length
    ? `<table class="stats">
        <thead><tr><th>Model</th><th class="num">Rated</th><th class="num">Avg</th><th class="num">≥ Solid</th><th>Most common limiting factors</th></tr></thead>
        <tbody>${ms.map((m) => `
          <tr>
            <td>${escapeHtml(modelName(m.model))}${m.count < opts.minSamples ? ' <span class="badge dim">few samples</span>' : ""}</td>
            <td class="num">${m.count}</td><td class="num">${avg(m.mean)}</td><td class="num">${pct(m.solidShare)}</td>
            <td>${m.tags.map((t) => `${escapeHtml(t.tag)} <span class="desc">${t.count} (${pct(t.share)})</span>`).join(" · ") || '<span class="desc">no tags</span>'}</td>
          </tr>`).join("")}</tbody>
      </table>`
    : '<p class="desc">No rated images yet.</p>';
}

$("aModel").onchange = () => { opts.model = $("aModel").value; store.set("analysis:opts", opts); render(); };
$("aBatch").onchange = () => { opts.batch = $("aBatch").value; store.set("analysis:opts", opts); render(); };
on("batch-started", (id) => { opts.batch = id; opts.model = ""; store.set("analysis:opts", opts); });
$("aMin").oninput = () => { opts.minSamples = Math.max(1, Number($("aMin").value) || 1); store.set("analysis:opts", opts); render(); };

// Clicking an option row opens Rate filtered to that slot value.
$("aSlots").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-slot]");
  if (tr) emit("rate-filter", { slot: tr.dataset.slot, slotValue: tr.dataset.value, model: opts.model });
});

// ---------- export ----------
// File name suffix: the selected batch's name or id, else the current time.
function stamp() {
  if (opts.batch && opts.batch !== "*") {
    const b = listBatches(state.library).find((x) => x.id === opts.batch);
    const name = b?.name?.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "");
    return `batch-${name || opts.batch.slice(0, 19)}`;
  }
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}
$("exImagesCsv").onclick = () => download(`images-${stamp()}.csv`, imagesCSV(records()), "text/csv");
$("exImagesJsonl").onclick = () => download(`images-${stamp()}.jsonl`, toJSONL(records().map(exportRecord)), "application/x-ndjson");
$("exSlotsCsv").onclick = () => download(`slot-stats-${stamp()}.csv`, slotStatsCSV(slotStats(records(), { minSamples: opts.minSamples })), "text/csv");
$("exStatsJsonl").onclick = () => {
  const recs = records();
  const rows = [
    { type: "overall", ...overallStats(recs) },
    ...Object.entries(slotStats(recs, { minSamples: opts.minSamples })).flatMap(([slot, list]) => list.map((r) => ({ type: "slot_option", slot, ...r }))),
    ...modelStats(recs).map((m) => ({ type: "model", ...m })),
  ];
  download(`analysis-${stamp()}.jsonl`, toJSONL(rows), "application/x-ndjson");
};

on("library", () => isActive() && render());
on("ratings", () => isActive() && render());
on("tab-shown", (name) => name === "analysis" && render());
