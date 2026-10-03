// Compare tab: blind pairwise comparisons with Bradley-Terry scores, alongside (not replacing) 1-7 ratings.

import { $, store, state, api, escapeHtml, imgSrc, on, emit, toast, typingInField, modelName } from "./util.js";
import { RATINGS, isRated, scoreOf } from "../lib/ratings.js";
import { listBatches } from "../lib/analysis.js";
import { withinSet, fitBradleyTerry, choosePair, progress, selfAgreement, pairKey, countComparisons, PHASE1_TARGET, sample, crossWinRate, components, rankWithinClusters, recordOf } from "../lib/compare.js";
import { groupList, groupName, isKnownGroup, groupPicker } from "./groups.js";
import { openLightbox, updateLightbox, closeLightbox, lightboxOpen } from "./lightbox.js";
import { isStarred, toggleStar } from "./stars.js";

// minScore 0 = any image, including unrated.
// mix: blend in a fixed random sample of 7s from elsewhere. from: "" off, "*" other groups, or a group id.
// files / mainFiles hold the drawn samples so the set stays the same across reloads until Resample.
// perGroup: keep only the best N images of each group (0 = all). The chosen finalists are saved in
// `finalists` and stay fixed (final-round picks would otherwise reshuffle who qualifies) until the filters
// change or they are re-picked.
// groups: group ids to compare; empty = all groups.
let opts = { groups: [], batch: "", minScore: 6, perGroup: 0, target: 10, view: "compare", ...store.get("compare:opts", {}) };
if (typeof opts.group === "string") opts.groups = opts.group ? [opts.group] : opts.groups; // single-group setting from before
delete opts.group;
opts.finalists = { key: "", files: [], ...opts.finalists };
opts.mix = { from: "", count: 12, same: false, files: [], mainFiles: [], ...opts.mix };
const saveOpts = () => store.set("compare:opts", opts);
const sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; // one per app load

let files = []; // images in the current set (selection + mixed-in 7s)
let mainSet = new Set(); // from the selection
let anchorSet = new Set(); // mixed-in 7s
let comps = []; // comparisons within the set
let scores = new Map(); // file -> { score, se, n }
let pair = null; // { a, b, is_repeat, left: "a"|"b" }
let lastKey = null;
let busy = false;
let sessionPicks = 0;

let ready = false; // set once startup data (library, comparisons, groups) has loaded
const inGroups = (r) => !opts.groups.length || opts.groups.includes(r.group_id);
const isActive = () => ready && !$("tab-compare").classList.contains("hidden");

export function initCompare() {
  ready = true;
  $("cTarget").value = opts.target;
  $("cPerGroup").value = opts.perGroup || "";
  $("cMin").innerHTML = `<option value="0" ${opts.minScore === 0 ? "selected" : ""}>Any (incl. unrated)</option>` +
    RATINGS.map((r, i) => `<option value="${i + 1}" ${opts.minScore === i + 1 ? "selected" : ""}>${i + 1} · ${escapeHtml(r)}</option>`).join("");
  $("cMixCount").value = opts.mix.count;
  $("cMixSame").checked = opts.mix.same;
  setView(opts.view);
  rebuild();
}

// ---------- the image set ----------
function renderFilters() {
  opts.groups = picker.render();
  const runs = listBatches(state.library.filter(inGroups));
  if (opts.batch && !runs.some((b) => b.id === opts.batch)) opts.batch = "";
  $("cBatch").innerHTML = [["", "All runs"], ...runs.map((b) => [b.id, `${b.name ? b.name + " · " : ""}${b.id.slice(0, 16).replace("T", " ")} · ${b.count} images`])]
    .map(([v, l]) => `<option value="${escapeHtml(v)}" ${v === opts.batch ? "selected" : ""}>${escapeHtml(l)}</option>`).join("");
}

function renderMixOptions() {
  const m = opts.mix;
  if (m.from && m.from !== "*" && !isKnownGroup(m.from)) m.from = "";
  $("cMixFrom").innerHTML = [["", "nothing"], ["*", "7s from other groups"], ...groupList().filter((g) => !opts.groups.includes(g.id)).map((g) => [g.id, `7s from ${g.name}`])]
    .map(([v, l]) => `<option value="${escapeHtml(v)}" ${v === m.from ? "selected" : ""}>${escapeHtml(l)}</option>`).join("");
  for (const id of ["cMixCount", "cMixSame", "cResample"]) $(id).disabled = !m.from;
}

// Files matching the group / run / rating filters, before any sampling.
function selectionFiles() {
  const recs = state.library
    .filter((r) => inGroups(r) && (!opts.batch || r.batch_id === opts.batch))
    .filter((r) => opts.minScore === 0 || (isRated(r) && scoreOf(r) >= opts.minScore));
  if (!(opts.perGroup > 0)) return recs.map((r) => r.file);
  const key = JSON.stringify([opts.groups, opts.batch, opts.minScore, opts.perGroup]);
  if (opts.finalists.key !== key) {
    opts.finalists = { key, files: topPerGroup(recs, opts.perGroup) };
    saveOpts();
  }
  const exists = new Set(state.library.map((r) => r.file));
  return opts.finalists.files.filter((f) => exists.has(f));
}

// Stable pseudo-random order for ties, so the chosen set doesn't change between reloads.
const stableHash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

// Best `k` of each group: by Bradley-Terry score from comparisons within the group, then (for images not yet
// compared) by rating.
function topPerGroup(recs, k) {
  const byGroup = new Map();
  for (const r of recs) {
    if (!byGroup.has(r.group_id)) byGroup.set(r.group_id, []);
    byGroup.get(r.group_id).push(r);
  }
  const out = [];
  for (const list of byGroup.values()) {
    const files = list.map((r) => r.file);
    const bt = fitBradleyTerry(files, withinSet(state.comparisons, files));
    const key = (r) => [bt.get(r.file).score ?? -Infinity, isRated(r) ? scoreOf(r) : 0, stableHash(r.file)];
    list.sort((x, y) => {
      const [a, b] = [key(x), key(y)];
      return b[0] - a[0] || b[1] - a[1] || a[2] - b[2];
    });
    out.push(...list.slice(0, k).map((r) => r.file));
  }
  return out;
}

// Draw new samples: `count` 7s from the chosen source (never from the selection itself), and with
// "same number" the same count from the selection.
function resample() {
  const m = opts.mix;
  const selection = selectionFiles();
  const inSelection = new Set(selection);
  const pool = state.library
    .filter((r) => isRated(r) && scoreOf(r) === 7 && !inSelection.has(r.file))
    .filter((r) => (m.from === "*" ? !inGroups(r) : r.group_id === m.from))
    .map((r) => r.file);
  m.files = m.from ? sample(pool, m.count) : [];
  m.mainFiles = m.from && m.same ? sample(selection, m.count) : [];
  saveOpts();
}

function computeSet() {
  const selection = selectionFiles();
  const m = opts.mix;
  let main = selection;
  let anchors = [];
  if (m.from) {
    const inSelection = new Set(selection);
    const exists = new Set(state.library.map((r) => r.file));
    anchors = m.files.filter((f) => exists.has(f) && !inSelection.has(f));
    if (m.same) main = m.mainFiles.filter((f) => inSelection.has(f));
  }
  mainSet = new Set(main);
  anchorSet = new Set(anchors);
  files = [...main, ...anchors];
  comps = withinSet(state.comparisons, files);
  scores = fitBradleyTerry(files, comps);
}

// Recompute the set; keep the pair on screen if both images are still in it.
function rebuild() {
  renderFilters();
  renderMixOptions();
  computeSet();
  $("cSetInfo").textContent = `${files.length} image(s) in set${opts.perGroup > 0 ? ` (top ${opts.perGroup} per group, fixed)` : ""}`;
  $("cRepick").disabled = !(opts.perGroup > 0);
  $("cMixInfo").textContent = !opts.mix.from ? ""
    : anchorSet.size ? `${mainSet.size} from this selection + ${anchorSet.size} mixed-in 7s, shown blind`
    : "No 7s found outside this selection: pick a group, or another source.";
  if (!pair || !files.includes(pair.a) || !files.includes(pair.b)) nextPair();
  else renderPair();
  renderProgress();
  if (opts.view === "ranking") renderRanking();
}

// Groups dropdown: tick any number of groups; "All groups" clears the selection.
const picker = groupPicker("cGroups", {
  get: () => opts.groups,
  set: (ids) => {
    opts.groups = ids;
    opts.batch = "";
    saveOpts();
    if (opts.mix.from) resample();
    pair = null;
    rebuild();
  },
});

for (const [id, key] of [["cBatch", "batch"], ["cMin", "minScore"]]) {
  $(id).onchange = () => {
    opts[key] = key === "minScore" ? Number($(id).value) : $(id).value;
    saveOpts();
    if (opts.mix.from) resample(); // new selection, new mix
    pair = null;
    rebuild();
  };
}

// Mix-in controls: any change draws a fresh sample.
const mixChanged = () => {
  opts.mix.from = $("cMixFrom").value;
  opts.mix.count = Math.max(1, Math.min(100, Number($("cMixCount").value) || 1));
  opts.mix.same = $("cMixSame").checked;
  resample();
  pair = null;
  rebuild();
};
$("cMixFrom").onchange = mixChanged;
$("cMixCount").onchange = mixChanged;
$("cMixSame").onchange = mixChanged;
$("cResample").onclick = mixChanged;
$("cPerGroup").onchange = () => {
  opts.perGroup = Math.max(0, Math.min(500, Number($("cPerGroup").value) || 0));
  $("cPerGroup").value = opts.perGroup || "";
  saveOpts();
  if (opts.mix.from) resample();
  pair = null;
  rebuild();
};
$("cRepick").onclick = () => {
  opts.finalists.key = ""; // forces a fresh choice from current scores
  if (opts.mix.from) resample();
  pair = null;
  rebuild();
  toast("Finalists re-picked from the current scores.");
};
$("cTarget").oninput = () => {
  opts.target = Math.max(1, Math.min(200, Number($("cTarget").value) || 1));
  saveOpts();
  renderProgress();
};

// ---------- pairs ----------
function nextPair() {
  const p = choosePair(files, comps, { scores, lastKey });
  pair = p && { ...p, left: Math.random() < 0.5 ? "a" : "b" }; // random side against position bias
  renderPair();
}

function renderPair() {
  const arena = $("cArena");
  arena.querySelectorAll("figure").forEach((f) => f.classList.remove("win", "tie"));
  arena.querySelector(".empty")?.remove();
  if (!pair) {
    $("cLeft").removeAttribute("src");
    $("cRight").removeAttribute("src");
    arena.insertAdjacentHTML("beforeend", `<div class="empty">${files.length < 2
      ? `Fewer than two images match. Lower “Rated at least”, ${opts.perGroup > 0 ? "raise or clear “Finalists: top”, " : ""}or pick another group or run.`
      : "No pair available."}</div>`);
    return;
  }
  const left = pair.left === "a" ? pair.a : pair.b;
  const right = pair.left === "a" ? pair.b : pair.a;
  // Hide both until both have loaded so a stale image is never judged.
  arena.classList.add("loading");
  let pending = 2;
  const done = () => { if (--pending === 0) arena.classList.remove("loading"); };
  for (const [img, file] of [[$("cLeft"), left], [$("cRight"), right]]) {
    if (img.getAttribute("src") === imgSrc(file) && img.complete) done();
    else {
      img.onload = img.onerror = done;
      img.src = imgSrc(file);
    }
  }
}

// side: "left" | "right" | "tie"
async function pick(side) {
  if (!pair || busy || $("cArena").classList.contains("loading")) return;
  const leftIsA = pair.left === "a";
  const result = side === "tie" ? "tie" : (side === "left") === leftIsA ? "a" : "b";
  busy = true;
  const fig = side === "tie" ? $("cArena").querySelectorAll("figure") : [$("cArena").querySelector(`figure[data-side="${side}"]`)];
  fig.forEach((f) => f.classList.add(side === "tie" ? "tie" : "win"));
  try {
    const { comparison } = await api("/api/comparisons", {
      method: "POST",
      body: { image_a: pair.a, image_b: pair.b, result, shown_left: pair.left, session_id: sessionId, is_repeat: pair.is_repeat },
    });
    state.comparisons.push(comparison);
    comps.push(comparison);
    sessionPicks++;
    scores = fitBradleyTerry(files, comps);
    lastKey = pairKey(pair.a, pair.b);
    nextPair();
    renderProgress();
    if (opts.view === "ranking") renderRanking();
  } catch (e) {
    fig.forEach((f) => f.classList.remove("win", "tie"));
    toast("Could not save the pick: " + e.message, true);
  } finally {
    busy = false;
  }
}

function skip() {
  if (!pair || busy) return;
  lastKey = pairKey(pair.a, pair.b);
  nextPair();
}

// Undo the last pick of this session and show that pair again, same sides.
async function undo() {
  if (busy) return;
  busy = true;
  try {
    const { removed } = await api(`/api/comparisons/last?session=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    state.comparisons = state.comparisons.filter((c) => c.id !== removed.id);
    sessionPicks = Math.max(0, sessionPicks - 1);
    computeSet();
    pair = files.includes(removed.image_a) && files.includes(removed.image_b)
      ? { a: removed.image_a, b: removed.image_b, is_repeat: removed.is_repeat, left: removed.shown_left }
      : null;
    if (pair) renderPair();
    else nextPair();
    renderProgress();
    if (opts.view === "ranking") renderRanking();
    toast("Last pick undone.");
  } catch (e) {
    toast(e.status === 404 ? "Nothing to undo in this session." : "Undo failed: " + e.message, e.status !== 404);
  } finally {
    busy = false;
  }
}

$("cArena").addEventListener("click", (e) => {
  const fig = e.target.closest("figure");
  if (fig && opts.view === "compare") pick(fig.dataset.side);
});

document.addEventListener("keydown", (e) => {
  if (!isActive() || opts.view !== "ranking" || typingInField(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === "ArrowDown" || k === "ArrowRight" || k === "j") stepRank(1);
  else if (k === "ArrowUp" || k === "ArrowLeft" || k === "k") stepRank(-1);
  else if (k === "c") {
    if (rankSel) toggleStar(rankSel);
  } else if (k === "f" || k === " ") {
    const r = rankRow(rankSel);
    if (lightboxOpen()) closeLightbox();
    else if (r) openLightbox(r.f, rankCaption(r));
  } else return;
  e.preventDefault();
});

document.addEventListener("keydown", (e) => {
  if (!isActive() || opts.view !== "compare" || typingInField(e) || lightboxOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === "ArrowLeft") pick("left");
  else if (k === "ArrowRight") pick("right");
  else if (k === "ArrowDown" || k === " ") pick("tie");
  else if (k === "s" || k === "S") skip();
  else if (k === "u" || k === "U") undo();
  else return;
  e.preventDefault();
});

// ---------- progress & ranking ----------
function renderProgress() {
  const p = progress(files, comps, opts.target);
  const agree = selfAgreement(comps);
  const counts = [...countComparisons(files, comps).values()];
  const clusters = components(files, comps).length;
  const phase = counts.length < 2 ? ""
    : clusters > 1 ? `linking: ${clusters - 1} more pick${clusters > 2 ? "s" : ""} until every image is connected`
    : Math.min(...counts) < PHASE1_TARGET ? "phase 1: spreading matchups" : "phase 2: close scores";
  $("cBar").style.width = `${(p.fraction * 100).toFixed(1)}%`;
  $("cProgress").textContent = [
    `${p.reached}/${p.images} images at ${opts.target} comparisons`,
    `${comps.length} picks in this set (${sessionPicks} this session)`,
    agree.total ? `self-agreement ${Math.round(agree.rate * 100)}% on ${agree.total} repeat(s)` : "self-agreement: no repeats yet",
    phase,
  ].filter(Boolean).join(" · ");
}

// Selection vs mixed-in 7s: head-to-head win rate, average scores, and how many selection images reach the top.
function mixSummary(rows) {
  if (!anchorSet.size || !mainSet.size) return "";
  const h2h = crossWinRate(comps, mainSet, anchorSet);
  const mean = (set) => {
    const v = rows.filter((r) => set.has(r.f) && r.score != null).map((r) => r.score);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const fmt = (x) => (x == null ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}`);
  const ranked = rows.filter((r) => r.score != null);
  const topN = Math.min(anchorSet.size, ranked.length);
  const inTop = ranked.slice(0, topN).filter((r) => mainSet.has(r.f)).length;
  return `
    <div class="tiles" style="margin-bottom:10px">
      <div class="tile"><span>Selection vs mixed-in 7s, head-to-head</span><b>${h2h.n ? `${Math.round(h2h.rate * 100)}%` : "–"}</b>
        <small>${h2h.n ? ` won of ${h2h.n} (ties count half)` : " no matchups yet"}</small></div>
      <div class="tile"><span>Average score: selection / mixed-in 7s</span><b>${fmt(mean(mainSet))} / ${fmt(mean(anchorSet))}</b></div>
      <div class="tile"><span>Selection images in the top ${topN}</span><b>${ranked.length ? `${inTop} of ${topN}` : "–"}</b></div>
    </div>
    <p class="desc" style="margin:-4px 0 10px">50% means your selection is on par with the old 7s; above 50% it beats them. Early numbers are noisy: wait for a few comparisons per image.</p>`;
}

function renderRanking() {
  // Scores are only comparable within a cluster of images linked by comparisons; rank each cluster separately.
  const clusters = components(files, comps).filter((c) => c.length > 1);
  const ranks = rankWithinClusters(files, comps, scores);
  const split = clusters.length > 1;
  const rows = files
    .map((f) => ({ f, rec: state.library.find((r) => r.file === f), cluster: ranks.get(f)?.cluster ?? Infinity, rank: ranks.get(f)?.rank, ...scores.get(f) }))
    .sort((x, y) => x.cluster - y.cluster || (x.rank ?? Infinity) - (y.rank ?? Infinity) || y.n - x.n);
  rankRows = rows;
  if (!rows.some((r) => r.f === rankSel)) rankSel = rows[0]?.f ?? null;
  const mixing = anchorSet.size > 0;
  const groupsIn = (c) => [...new Set(c.map((f) => groupName(state.library.find((r) => r.file === f)?.group_id)))].join(", ");
  const warning = split ? `
    <div class="panel" style="border-color:var(--warn);margin-bottom:10px">
      <b class="warn">⚠ Not one ranking yet: these images form ${clusters.length} separate clusters</b>
      <p class="desc" style="margin:4px 0 0">No comparisons link them, so a score in one cluster says nothing about a score in another.
        Each cluster is ranked on its own below (${clusters.map((c, i) => `C${i + 1}: ${c.length} images, ${escapeHtml(groupsIn(c))}`).join(" · ")}).
        Keep comparing: the picker links clusters first.</p>
    </div>` : "";
  $("cRankList").innerHTML = rows.length ? `
    ${warning}
    ${mixSummary(rows)}
    <table class="stats rank">
      <thead><tr><th class="num">#</th>${split ? "<th>Cluster</th>" : ""}<th></th><th class="num">Score</th><th class="num">± SE</th><th class="num">Comparisons</th><th class="num">Rating</th>${mixing ? "<th>Source</th>" : ""}<th>Group</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr data-file="${escapeHtml(r.f)}" class="${r.f === rankSel ? "sel" : ""}">
          <td class="num">${isStarred(r.f) ? '<span title="Starred" style="color:#c98a00">★</span> ' : ""}${r.score == null ? "–" : r.rank}</td>
          ${split ? `<td class="desc">${r.cluster === Infinity ? "" : `C${r.cluster}`}</td>` : ""}
          <td class="thumb"><img loading="lazy" src="${imgSrc(r.f)}" alt=""></td>
          <td class="num">${r.score == null ? '<span class="desc">not compared</span>' : r.score.toFixed(2)}</td>
          <td class="num ci">${r.se == null ? "" : `± ${r.se.toFixed(2)}`}</td>
          <td class="num">${r.n}</td>
          <td class="num">${r.rec && isRated(r.rec) ? scoreOf(r.rec) : ""}</td>
          ${mixing ? `<td>${anchorSet.has(r.f) ? '<span class="badge dim">mixed-in 7</span>' : '<span class="badge">selection</span>'}</td>` : ""}
          <td class="desc">${escapeHtml(groupName(r.rec?.group_id))}</td>
        </tr>`).join("")}</tbody>
    </table>
    <p class="desc" style="margin-top:8px">Score is a Bradley–Terry log-strength (0 = average of this set): a 1-point lead means winning about 73% of head-to-heads. ± SE shrinks as an image gets more comparisons.</p>`
    : '<p class="desc">No images in this set.</p>';
  renderRankDetail();
}

// ---------- ranking detail: the selected image's characteristics ----------
let rankRows = []; // rows in ranking order, for cycling
let rankSel = null; // selected file

const rankRow = (file) => rankRows.find((r) => r.f === file);
// "#3", "#3 in C2" when the set is split into clusters, or "not compared".
function rankPlace(r) {
  if (r.score == null) return "not compared";
  const split = rankRows.some((x) => x.cluster === 2);
  return `#${r.rank}${split ? ` in C${r.cluster}` : ""}`;
}
function rankCaption(r) {
  const score = r.score == null ? "" : ` · ${r.score.toFixed(2)} ± ${r.se.toFixed(2)}`;
  return `${rankPlace(r)}${score} · ${groupName(r.rec?.group_id)}${r.rec && isRated(r.rec) ? ` · rated ${scoreOf(r.rec)}` : ""}`;
}

function selectRank(file, { scroll = true } = {}) {
  if (!file) return;
  rankSel = file;
  $("cRankList").querySelectorAll("tr[data-file]").forEach((tr) => tr.classList.toggle("sel", tr.dataset.file === file));
  if (scroll) $("cRankList").querySelector(`tr[data-file="${CSS.escape(file)}"]`)?.scrollIntoView({ block: "nearest" });
  renderRankDetail();
}

function stepRank(delta) {
  if (!rankRows.length) return;
  const i = rankRows.findIndex((r) => r.f === rankSel);
  selectRank(rankRows[Math.max(0, Math.min(rankRows.length - 1, (i < 0 ? 0 : i) + delta))].f);
}

function renderRankDetail() {
  const r = rankRow(rankSel);
  if (!r) return ($("cRankDetail").innerHTML = '<p class="desc">Select an image in the list.</p>');
  updateLightbox(r.f, rankCaption(r));
  const rec = r.rec || {};
  const w = recordOf(r.f, comps);
  const picks = Object.entries(rec.picks || {});
  const i = rankRows.indexOf(r);
  $("cRankDetail").innerHTML = `
    <img class="big zoomable" src="${imgSrc(r.f)}" alt="" title="Full size (f)">
    <div class="row between">
      <b>${escapeHtml(rankPlace(r))}${r.score == null ? "" : ` of ${rankRows.filter((x) => x.cluster === r.cluster).length}`}</b>
      <span class="row">
        <button type="button" data-step="-1" ${i <= 0 ? "disabled" : ""} title="Previous (↑)">‹</button>
        <span class="desc">${i + 1} / ${rankRows.length}</span>
        <button type="button" data-step="1" ${i >= rankRows.length - 1 ? "disabled" : ""} title="Next (↓)">›</button>
      </span>
    </div>
    <div class="meta" style="margin-top:0">
      <span>score: <b>${r.score == null ? "–" : `${r.score.toFixed(2)} ± ${r.se.toFixed(2)}`}</b></span>
      <span>record in this set: <b>${w.wins}–${w.losses}–${w.ties}</b> <span class="desc">(W–L–T)</span></span>
      <span>rating: <b>${isRated(rec) ? `${scoreOf(rec)} · ${escapeHtml(RATINGS[rec.rating.value])}` : "unrated"}</b></span>
      <span>group: <b>${escapeHtml(groupName(rec.group_id))}</b></span>
      ${anchorSet.size ? `<span>source: <b>${anchorSet.has(r.f) ? "mixed-in 7" : "selection"}</b></span>` : ""}
      <span>run: <b>${escapeHtml(rec.batch_name || rec.batch_id || "—")}</b></span>
      <span>model: <b>${escapeHtml(modelName(rec.model))}</b></span>
      <span>seed: <b>${rec.seed ?? "—"}</b></span>
      ${rec.rating?.tags?.length ? `<span style="flex-basis:100%">tags: <b>${escapeHtml(rec.rating.tags.join(", "))}</b></span>` : ""}
      ${rec.rating?.notes ? `<span style="flex-basis:100%">notes: <b>${escapeHtml(rec.rating.notes)}</b></span>` : ""}
    </div>
    ${picks.length ? `<table class="picks">${picks.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("")}</table>` : '<p class="desc">No slot values (not made from a template).</p>'}
    <p class="prompt">${escapeHtml(rec.prompt || "")}</p>
    <div class="row wrap">
      <button type="button" data-act="star" class="${isStarred(r.f) ? "starred" : ""}" title="Save as a key pick">${isStarred(r.f) ? "★ Starred" : "☆ Star"} <kbd>c</kbd></button>
      <button type="button" data-act="full">Full size <kbd>f</kbd></button>
      <button type="button" data-act="rate" title="Open this image in the Rate tab">Show in Rate</button>
      <button type="button" data-act="lock" ${picks.length ? "" : "disabled"} title="Lock these slot values in the Batch template">Use these slot values in Batch</button>
    </div>
    <p class="desc">↑/↓ (or ←/→, j/k) move through the ranking · c star · f or Space for full size.</p>`;
}

$("cRankList").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-file]");
  if (tr) selectRank(tr.dataset.file, { scroll: false });
});
$("cRankDetail").addEventListener("click", (e) => {
  const r = rankRow(rankSel);
  if (!r) return;
  if (e.target.matches("img.big")) return openLightbox(r.f, rankCaption(r));
  const el = e.target.closest("button");
  if (!el) return;
  if (el.dataset.step) stepRank(Number(el.dataset.step));
  else if (el.dataset.act === "full") openLightbox(r.f, rankCaption(r));
  else if (el.dataset.act === "star") toggleStar(r.f);
  else if (el.dataset.act === "rate") emit("show-image", r.f);
  else if (el.dataset.act === "lock") { emit("lock-picks", r.rec.picks); emit("tab", "batch"); }
});

function setView(view) {
  opts.view = view;
  saveOpts();
  document.querySelectorAll("#cView button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  $("cCompare").classList.toggle("hidden", view !== "compare");
  $("cRanking").classList.toggle("hidden", view !== "ranking");
  if (view === "ranking") renderRanking();
}
document.querySelectorAll("#cView button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));

// Ratings, new images or group changes can change which images are in the set.
on("ratings", () => isActive() && !busy && rebuild());
on("library", () => isActive() && !busy && rebuild());
on("groups", () => isActive() && renderFilters());
on("stars", () => isActive() && opts.view === "ranking" && renderRanking());
on("tab-shown", (name) => ready && name === "compare" && rebuild());

// The Compare set as the Ranking view shows it, for exports: Map file -> { rank, cluster, score, se, n }.
export function compareSnapshot() {
  computeSet();
  const ranks = rankWithinClusters(files, comps, scores);
  const out = new Map();
  for (const f of files) {
    const s = scores.get(f);
    out.set(f, { ...ranks.get(f), score: s?.score, se: s?.se, n: s?.n ?? 0 });
  }
  return out;
}
