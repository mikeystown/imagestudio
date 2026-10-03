// Analysis tab: which slot options predict high ratings, limiting factors per model, CSV/JSONL export.

import { $, store, state, escapeHtml, fmtCost, on, emit, optionsHtml, modelName, download } from "./util.js";
import { RATINGS, SOLID, isRated } from "../lib/ratings.js";
import { groupName, groupPicker } from "./groups.js";
import { compareSnapshot } from "./compare-view.js";
import { isStarred } from "./stars.js";
import { fitBradleyTerry } from "../lib/compare.js";
import { slotStats, modelStats, overallStats, imagesCSV, comparisonsCSV, listBatches, DEFAULT_MIN_SAMPLES } from "../lib/analysis.js";

// groups: group ids (empty = all). batch: "" = all runs (in those groups), else one run's batch id.
// exportKind: "images" (one row per image) or "comparisons" (one row per pairwise pick).
let opts = { groups: [], model: "", batch: "", minSamples: DEFAULT_MIN_SAMPLES, exportKind: "images", ...store.get("analysis:opts", {}) };
if (typeof opts.group === "string") opts.groups = opts.group ? [opts.group] : opts.groups; // single-group setting from before
delete opts.group;
if (opts.batch === "*") opts.batch = ""; // "All batches" option from before groups existed
delete opts.batchOnly;
const saveOpts = () => store.set("analysis:opts", opts);
const isActive = () => !$("tab-analysis").classList.contains("hidden");

export function initAnalysis() {
  $("aMin").value = opts.minSamples;
  $("exportKind").value = opts.exportKind;
  render();
}

const inGroup = (r) => !opts.groups.length || opts.groups.includes(r.group_id);
const records = () =>
  state.library.filter((r) => inGroup(r) && (!opts.batch || r.batch_id === opts.batch) && (!opts.model || r.model === opts.model));

// Batch ids are ISO timestamps with ":" and "." replaced by "-".
const batchDate = (id) => new Date(id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, "T$1:$2:$3.$4Z"));
function batchLabel(b) {
  const when = batchDate(b.id).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const models = b.models.length > 1 ? `${b.models.length} models` : modelName(b.models[0]);
  return `${b.name ? `${b.name} · ` : ""}${when} · ${b.count} images, ${b.rated} rated · ${models}`;
}

const picker = groupPicker("aGroups", {
  get: () => opts.groups,
  set: (ids) => {
    opts.groups = ids;
    opts.batch = "";
    saveOpts();
    render();
  },
});
function renderGroupOptions() {
  opts.groups = picker.render();
}

// Runs within the selected group.
function renderBatchOptions() {
  const batches = listBatches(state.library.filter(inGroup));
  const entries = batches.map((b) => [b.id, batchLabel(b)]);
  // A run that was just started has no images yet; keep it selectable.
  if (opts.batch && !batches.some((b) => b.id === opts.batch)) entries.unshift([opts.batch, "Selected run (no images yet)"]);
  $("aBatch").innerHTML = [["", opts.groups.length ? "All runs in these groups" : "All runs"], ...entries]
    .map(([v, l]) => `<option value="${escapeHtml(v)}" ${v === opts.batch ? "selected" : ""}>${escapeHtml(l)}</option>`).join("");
}

const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const avg = (x) => (x == null ? "—" : x.toFixed(2));
// x is a 1–7 score.
const ratingName = (x) => (x == null ? "" : RATINGS[Math.round(x) - 1]);

export function render() {
  renderGroupOptions();
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

$("aModel").onchange = () => { opts.model = $("aModel").value; saveOpts(); render(); };
$("aBatch").onchange = () => { opts.batch = $("aBatch").value; saveOpts(); render(); };
// A new run selects its group and itself.
on("batch-started", ({ id, group }) => { Object.assign(opts, { groups: [group], batch: id, model: "" }); saveOpts(); });
on("groups", () => isActive() && render());
$("aMin").oninput = () => { opts.minSamples = Math.max(1, Number($("aMin").value) || 1); saveOpts(); render(); };

// Clicking an option row opens Rate filtered to that slot value.
$("aSlots").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-slot]");
  if (tr) emit("rate-filter", { group: opts.groups.length === 1 ? opts.groups[0] : "", slot: tr.dataset.slot, slotValue: tr.dataset.value, model: opts.model });
});

// ---------- export ----------
// File name suffix: the selected run, else the selected group, else the current time.
const slug = (s) => String(s || "").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "");
function stamp() {
  if (opts.batch) {
    const b = listBatches(state.library).find((x) => x.id === opts.batch);
    return `run-${slug(b?.name) || opts.batch.slice(0, 19)}`;
  }
  if (opts.groups.length) return opts.groups.map((g) => slug(groupName(g)) || g).join("+");
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}
// One export button; the CSV is either one row per image or one row per pairwise pick.
// Both carry global Bradley-Terry scores (all picks) and the Compare tab's current ranking (compare_*).
$("exportKind").onchange = () => { opts.exportKind = $("exportKind").value; saveOpts(); };
$("exportCsv").onclick = () => {
  const bt = fitBradleyTerry(state.library.map((r) => r.file), state.comparisons);
  const compare = compareSnapshot();
  const recs = records();
  if (opts.exportKind === "comparisons") {
    // Picks involving at least one image in the selection; the other image is described even if outside it.
    const inSelection = new Set(recs.map((r) => r.file));
    const picks = state.comparisons.filter((c) => inSelection.has(c.image_a) || inSelection.has(c.image_b));
    const byFile = new Map(state.library.map((r) => [r.file, r]));
    download(`comparisons-${stamp()}.csv`, comparisonsCSV(picks, { byFile, groupName, bt, compare, starred: isStarred }), "text/csv");
  } else {
    download(`images-${stamp()}.csv`, imagesCSV(recs, { groupName, bt, compare, starred: isStarred }), "text/csv");
  }
};

on("library", () => isActive() && render());
on("ratings", () => isActive() && render());
on("tab-shown", (name) => name === "analysis" && render());
