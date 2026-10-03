// Compare tab: blind pairwise comparisons with Bradley-Terry scores, alongside (not replacing) 1-7 ratings.

import { $, store, state, api, escapeHtml, imgSrc, on, toast, typingInField } from "./util.js";
import { RATINGS, isRated, scoreOf } from "../lib/ratings.js";
import { listBatches } from "../lib/analysis.js";
import { withinSet, fitBradleyTerry, choosePair, progress, selfAgreement, pairKey, countComparisons, PHASE1_TARGET, sample, crossWinRate } from "../lib/compare.js";
import { groupList, groupName, isKnownGroup } from "./groups.js";
import { openLightbox, lightboxOpen } from "./lightbox.js";

// minScore 0 = any image, including unrated.
// mix: blend in a fixed random sample of 7s from elsewhere. from: "" off, "*" other groups, or a group id.
// files / mainFiles hold the drawn samples so the set stays the same across reloads until Resample.
let opts = { group: "", batch: "", minScore: 6, target: 10, view: "compare", ...store.get("compare:opts", {}) };
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

const isActive = () => !$("tab-compare").classList.contains("hidden");

export function initCompare() {
  $("cTarget").value = opts.target;
  $("cMin").innerHTML = `<option value="0" ${opts.minScore === 0 ? "selected" : ""}>Any (incl. unrated)</option>` +
    RATINGS.map((r, i) => `<option value="${i + 1}" ${opts.minScore === i + 1 ? "selected" : ""}>${i + 1} · ${escapeHtml(r)}</option>`).join("");
  $("cMixCount").value = opts.mix.count;
  $("cMixSame").checked = opts.mix.same;
  setView(opts.view);
  rebuild();
}

// ---------- the image set ----------
function renderFilters() {
  if (opts.group && !isKnownGroup(opts.group)) opts.group = "";
  $("cGroup").innerHTML = [["", "All groups"], ...groupList().map((g) => [g.id, g.name])]
    .map(([v, l]) => `<option value="${escapeHtml(v)}" ${v === opts.group ? "selected" : ""}>${escapeHtml(l)}</option>`).join("");
  const runs = listBatches(state.library.filter((r) => !opts.group || r.group_id === opts.group));
  if (opts.batch && !runs.some((b) => b.id === opts.batch)) opts.batch = "";
  $("cBatch").innerHTML = [["", "All runs"], ...runs.map((b) => [b.id, `${b.name ? b.name + " · " : ""}${b.id.slice(0, 16).replace("T", " ")} · ${b.count} images`])]
    .map(([v, l]) => `<option value="${escapeHtml(v)}" ${v === opts.batch ? "selected" : ""}>${escapeHtml(l)}</option>`).join("");
}

function renderMixOptions() {
  const m = opts.mix;
  if (m.from && m.from !== "*" && !isKnownGroup(m.from)) m.from = "";
  $("cMixFrom").innerHTML = [["", "nothing"], ["*", "7s from other groups"], ...groupList().filter((g) => g.id !== opts.group).map((g) => [g.id, `7s from ${g.name}`])]
    .map(([v, l]) => `<option value="${escapeHtml(v)}" ${v === m.from ? "selected" : ""}>${escapeHtml(l)}</option>`).join("");
  for (const id of ["cMixCount", "cMixSame", "cResample"]) $(id).disabled = !m.from;
}

// Files matching the group / run / rating filters, before any sampling.
const selectionFiles = () =>
  state.library
    .filter((r) => (!opts.group || r.group_id === opts.group) && (!opts.batch || r.batch_id === opts.batch))
    .filter((r) => opts.minScore === 0 || (isRated(r) && scoreOf(r) >= opts.minScore))
    .map((r) => r.file);

// Draw new samples: `count` 7s from the chosen source (never from the selection itself), and with
// "same number" the same count from the selection.
function resample() {
  const m = opts.mix;
  const selection = selectionFiles();
  const inSelection = new Set(selection);
  const pool = state.library
    .filter((r) => isRated(r) && scoreOf(r) === 7 && !inSelection.has(r.file))
    .filter((r) => (m.from === "*" ? r.group_id !== opts.group : r.group_id === m.from))
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
  $("cSetInfo").textContent = `${files.length} image(s) in set`;
  $("cMixInfo").textContent = !opts.mix.from ? ""
    : anchorSet.size ? `${mainSet.size} from this selection + ${anchorSet.size} mixed-in 7s, shown blind`
    : "No 7s found outside this selection: pick a group, or another source.";
  if (!pair || !files.includes(pair.a) || !files.includes(pair.b)) nextPair();
  else renderPair();
  renderProgress();
  if (opts.view === "ranking") renderRanking();
}

for (const [id, key] of [["cGroup", "group"], ["cBatch", "batch"], ["cMin", "minScore"]]) {
  $(id).onchange = () => {
    opts[key] = key === "minScore" ? Number($(id).value) : $(id).value;
    if (key === "group") opts.batch = "";
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
      ? "Fewer than two images match. Lower “Rated at least” or pick another group or run."
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
  const phase = counts.length < 2 ? "" : Math.min(...counts) < PHASE1_TARGET ? "phase 1: spreading matchups" : "phase 2: close scores";
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
  const rows = files
    .map((f) => ({ f, rec: state.library.find((r) => r.file === f), ...scores.get(f) }))
    .sort((x, y) => (y.score ?? -Infinity) - (x.score ?? -Infinity) || y.n - x.n);
  const mixing = anchorSet.size > 0;
  $("cRanking").innerHTML = rows.length ? `
    ${mixSummary(rows)}
    <table class="stats rank">
      <thead><tr><th class="num">#</th><th></th><th class="num">Score</th><th class="num">± SE</th><th class="num">Comparisons</th><th class="num">Rating</th>${mixing ? "<th>Source</th>" : ""}<th>Group</th></tr></thead>
      <tbody>${rows.map((r, i) => `
        <tr>
          <td class="num">${r.score == null ? "–" : i + 1}</td>
          <td class="thumb"><img loading="lazy" src="${imgSrc(r.f)}" data-file="${escapeHtml(r.f)}" alt=""></td>
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
}
$("cRanking").addEventListener("click", (e) => {
  const img = e.target.closest("img[data-file]");
  if (img) openLightbox(img.dataset.file, `${scores.get(img.dataset.file)?.score?.toFixed(2) ?? "–"} ± ${scores.get(img.dataset.file)?.se?.toFixed(2) ?? "–"}`);
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
on("tab-shown", (name) => name === "compare" && rebuild());
