// Rate tab: keyboard-driven grid for rating images, plus actions (reproduce, reference, blend, lock picks).

import { $, store, state, api, getCaps, escapeHtml, imgSrc, fmtCost, addRecords, emit, on, toast, optionsHtml, modelName, typingInField, randomSeed, loadLibrary, MAX_SEED } from "./util.js";
import { RATINGS, SOLID, TAGS, TAG_KEYS, isRated } from "../lib/ratings.js";
import { postImage } from "./batch.js";
import { openLightbox, updateLightbox, closeLightbox, lightboxOpen } from "./lightbox.js";

const KINDS = ["batch", "single", "reproduce", "reference", "blend"];
let filters = { rating: "all", model: "", tag: "", slot: "", slotValue: "", kind: "", sort: "newest", ...store.get("rate:filters", {}) };
let autoAdvance = store.get("rate:autoAdvance", true);
let list = []; // filtered + sorted snapshot; ratings change in place without re-filtering
let current = null; // file name
const blendSel = new Set();

const byFile = (file) => state.library.find((r) => r.file === file);
const isActive = () => !$("tab-rate").classList.contains("hidden");

export function initRate() {
  $("rateKeys").innerHTML =
    `<b>←/→</b> or <b>h/l</b> move · <b>↑/↓</b> or <b>k/j</b> row · <b>1–7</b> rate · <b>0</b> clear · ` +
    TAGS.map((t, i) => `<b>${TAG_KEYS[i]}</b> ${escapeHtml(t)}`).join(" · ") +
    ` · <b>n</b> notes · <b>x</b> select for blend · <b>f</b>/<b>Space</b> full size (click to zoom to 100%) · <b>Esc</b> close / leave notes`;
  $("autoAdvance").checked = autoAdvance;
  renderFilterOptions();
  refilter();
}

// ---------- filtering ----------
function renderFilterOptions() {
  const lib = state.library;
  const models = [...new Set(lib.map((r) => r.model))].sort();
  const slots = [...new Set(lib.flatMap((r) => Object.keys(r.picks || {})))].sort();
  const slotValues = filters.slot ? [...new Set(lib.map((r) => r.picks?.[filters.slot]).filter(Boolean))].sort() : [];
  $("fRating").innerHTML =
    [["all", "All ratings"], ["unrated", "Unrated"], ["rated", "Rated"], ["solid", `≥ ${RATINGS[SOLID]}`]]
      .concat(RATINGS.map((r, i) => [String(i), `${i + 1} · ${r}`]))
      .map(([v, l]) => `<option value="${v}" ${filters.rating === v ? "selected" : ""}>${escapeHtml(l)}</option>`).join("");
  $("fModel").innerHTML = `<option value="">All models</option>` +
    models.map((m) => `<option value="${escapeHtml(m)}" ${filters.model === m ? "selected" : ""}>${escapeHtml(modelName(m))}</option>`).join("");
  $("fTag").innerHTML = optionsHtml(TAGS, filters.tag, { blank: "Any tag" });
  $("fSlot").innerHTML = optionsHtml(slots, filters.slot, { blank: "Any slot" });
  $("fSlotValue").innerHTML = optionsHtml(slotValues, filters.slotValue, { blank: filters.slot ? "any value" : "—" });
  $("fSlotValue").disabled = !filters.slot;
  $("fKind").innerHTML = optionsHtml(KINDS, filters.kind, { blank: "All kinds" });
  $("fSort").value = filters.sort;
}

function matches(r) {
  const f = filters;
  const v = r.rating?.value;
  if (f.rating === "unrated" && isRated(r)) return false;
  if (f.rating === "rated" && !isRated(r)) return false;
  if (f.rating === "solid" && !(isRated(r) && v >= SOLID)) return false;
  if (/^\d$/.test(f.rating) && v !== Number(f.rating)) return false;
  if (f.model && r.model !== f.model) return false;
  if (f.tag && !(r.rating?.tags || []).includes(f.tag)) return false;
  if (f.slot && !(r.picks && f.slot in r.picks)) return false;
  if (f.slotValue && r.picks?.[f.slot] !== f.slotValue) return false;
  if (f.kind && (r.kind || "single") !== f.kind) return false;
  return true;
}

const SORTS = {
  newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
  oldest: (a, b) => String(a.created_at).localeCompare(String(b.created_at)),
  ratingDesc: (a, b) => (b.rating?.value ?? -1) - (a.rating?.value ?? -1) || SORTS.newest(a, b),
  ratingAsc: (a, b) => (a.rating?.value ?? 99) - (b.rating?.value ?? 99) || SORTS.newest(a, b),
  model: (a, b) => String(a.model).localeCompare(String(b.model)) || SORTS.newest(a, b),
};

function refilter() {
  store.set("rate:filters", filters);
  list = state.library.filter(matches).sort(SORTS[filters.sort] || SORTS.newest);
  if (!list.some((r) => r.file === current)) current = list[0]?.file ?? null;
  renderGrid();
  renderDetail();
}

for (const [id, key] of [["fRating", "rating"], ["fModel", "model"], ["fTag", "tag"], ["fSlot", "slot"], ["fSlotValue", "slotValue"], ["fKind", "kind"], ["fSort", "sort"]]) {
  $(id).onchange = () => {
    filters[key] = $(id).value;
    if (key === "slot") filters.slotValue = "";
    renderFilterOptions();
    refilter();
  };
}
$("autoAdvance").onchange = () => store.set("rate:autoAdvance", (autoAdvance = $("autoAdvance").checked));
$("reloadLib").onclick = () => loadLibrary().catch((e) => toast(e.message, true));

on("library", () => {
  renderFilterOptions();
  // Keep the current snapshot order but add new matching images and drop deleted ones.
  const known = new Set(list.map((r) => r.file));
  const fresh = state.library.filter((r) => !known.has(r.file) && matches(r));
  list = [...fresh, ...list.map((r) => byFile(r.file)).filter(Boolean)];
  if (!current && list.length) current = list[0].file;
  renderGrid();
  renderDetail();
});

// From the Analysis tab: show images with a given slot value.
on("rate-filter", (f) => {
  filters = { ...filters, rating: "all", tag: "", kind: "", ...f };
  renderFilterOptions();
  refilter();
  emit("tab", "rate");
});

on("show-image", (file) => {
  emit("tab", "rate");
  if (!list.some((r) => r.file === file)) {
    filters = { ...filters, rating: "all", model: "", tag: "", slot: "", slotValue: "", kind: "" };
    renderFilterOptions();
    refilter();
  }
  select(file);
});

// ---------- grid ----------
function figureHtml(r) {
  const rated = isRated(r);
  return `
    <figure data-file="${escapeHtml(r.file)}" class="${r.file === current ? "sel" : ""} ${blendSel.has(r.file) ? "blend" : ""}">
      <img loading="lazy" src="${imgSrc(r.file)}" alt="">
      <span class="rbadge ${rated ? `r${r.rating.value}` : "none"}">${rated ? r.rating.value + 1 : "–"}</span>
      ${blendSel.has(r.file) ? `<span class="bbadge">${[...blendSel].indexOf(r.file) + 1}</span>` : ""}
    </figure>`;
}

const renderCount = () => ($("rateCount").textContent = `${list.length} image(s) · ${list.filter(isRated).length} rated`);

function renderGrid() {
  renderCount();
  $("rateGrid").innerHTML = list.length ? list.map(figureHtml).join("") : '<p class="desc">No images match these filters.</p>';
  renderBlendBar();
}

function updateFigure(file) {
  const fig = $("rateGrid").querySelector(`figure[data-file="${CSS.escape(file)}"]`);
  const r = byFile(file);
  if (fig && r) fig.outerHTML = figureHtml(r);
  renderCount();
}

$("rateGrid").addEventListener("click", (e) => {
  const fig = e.target.closest("figure");
  if (!fig) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey) toggleBlend(fig.dataset.file);
  else select(fig.dataset.file);
});
$("rateGrid").addEventListener("dblclick", (e) => {
  const fig = e.target.closest("figure");
  if (fig && !(e.ctrlKey || e.metaKey || e.shiftKey)) openFull();
});

// Caption for the full-size viewer: who made it, and how it's rated so far.
function fullCaption(r) {
  const rating = isRated(r) ? `${r.rating.value + 1} · ${RATINGS[r.rating.value]}` : "unrated";
  const tags = r.rating?.tags?.length ? ` · ${r.rating.tags.join(", ")}` : "";
  const pos = list.findIndex((x) => x.file === r.file) + 1;
  return `${pos}/${list.length} · ${modelName(r.model)} · seed ${r.seed ?? "—"} · ${rating}${tags}`;
}
function openFull() {
  const r = byFile(current);
  if (r) openLightbox(r.file, fullCaption(r));
}

function select(file) {
  const prev = current;
  current = file;
  if (prev) updateFigure(prev);
  updateFigure(file);
  $("rateGrid").querySelector(`figure[data-file="${CSS.escape(file)}"]`)?.scrollIntoView({ block: "nearest" });
  renderDetail();
}

function move(delta) {
  if (!list.length) return;
  const i = list.findIndex((r) => r.file === current);
  const next = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + delta));
  select(list[next].file);
}

const gridColumns = () => getComputedStyle($("rateGrid")).gridTemplateColumns.split(" ").length || 1;

// ---------- blend selection ----------
function toggleBlend(file) {
  if (blendSel.has(file)) blendSel.delete(file);
  else if (blendSel.size >= 4) return toast("Blend uses at most 4 images.", true);
  else blendSel.add(file);
  for (const f of list.map((r) => r.file).filter((f) => blendSel.has(f) || f === file)) updateFigure(f);
  renderBlendBar();
}
function renderBlendBar() {
  $("blendBar").classList.toggle("hidden", !blendSel.size);
  $("blendInfo").textContent = `${blendSel.size} selected for blend${blendSel.size < 2 ? " (pick 2–4)" : ""}`;
  $("blendGo").disabled = blendSel.size < 2;
}
$("blendClear").onclick = () => {
  const files = [...blendSel];
  blendSel.clear();
  files.forEach(updateFigure);
  renderBlendBar();
};
$("blendGo").onclick = () => openAction("blend", [...blendSel].map(byFile).filter(Boolean));

// ---------- detail & rating ----------
function renderDetail() {
  const r = byFile(current);
  if (!r) {
    closeLightbox();
    return ($("rateDetail").innerHTML = '<p class="desc">Select an image.</p>');
  }
  updateLightbox(r.file, fullCaption(r));
  const v = r.rating?.value;
  const tags = r.rating?.tags || [];
  const picks = Object.entries(r.picks || {});
  $("rateDetail").innerHTML = `
    <img class="big zoomable" src="${imgSrc(r.file)}" alt="" title="View full size (f)">
    <div class="ratings">
      ${RATINGS.map((label, i) => `<button type="button" data-rate="${i}" class="${v === i ? "on" : ""}"><kbd>${i + 1}</kbd> ${escapeHtml(label)}</button>`).join("")}
    </div>
    <div class="tags">
      ${TAGS.map((t, i) => `<button type="button" data-tag="${escapeHtml(t)}" class="${tags.includes(t) ? "on" : ""}"><kbd>${TAG_KEYS[i]}</kbd> ${escapeHtml(t)}</button>`).join("")}
    </div>
    <textarea id="rateNotes" placeholder="Notes (n)…" rows="2">${escapeHtml(r.rating?.notes || "")}</textarea>
    <div class="row wrap">
      <button type="button" data-act="reproduce" title="Same model, prompt and seed at a chosen resolution">Reproduce</button>
      <button type="button" data-act="reference" title="Send this image as a reference with an edit prompt">Use as reference</button>
      <button type="button" data-act="blend-toggle">${blendSel.has(r.file) ? "Unselect for blend" : "Select for blend"} <kbd>x</kbd></button>
      <button type="button" data-act="lock" ${picks.length ? "" : "disabled"} title="Copy this image's slot picks into the Batch template as locked values">Lock picks</button>
      <a href="${imgSrc(r.file)}" download><button type="button">Download</button></a>
    </div>
    <div class="meta">
      <span>model: <b>${escapeHtml(modelName(r.model))}</b></span>
      <span>seed: <b>${r.seed ?? "—"}</b></span>
      ${r.resolution ? `<span>resolution: <b>${escapeHtml(r.resolution)}</b></span>` : ""}
      ${r.aspect_ratio ? `<span>aspect: <b>${escapeHtml(r.aspect_ratio)}</b></span>` : ""}
      <span>cost: <b>${fmtCost(r.cost)}</b></span>
      <span>kind: <b>${escapeHtml(r.kind || "single")}</b></span>
      <span>${escapeHtml(new Date(r.created_at).toLocaleString())}</span>
      ${r.parent ? `<span style="flex-basis:100%">from: ${[].concat(r.parent).map((p) => `<a href="#" data-goto="${escapeHtml(p)}">${escapeHtml(p)}</a>`).join(", ")}</span>` : ""}
    </div>
    ${picks.length ? `<table class="picks">${picks.map(([k, val]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(val)}</td></tr>`).join("")}</table>` : ""}
    <details><summary>Prompt</summary><p class="desc">${escapeHtml(r.prompt)}</p></details>`;
  $("rateNotes").addEventListener("change", () => saveRating(r, { notes: $("rateNotes").value }));
  $("rateNotes").addEventListener("keydown", (e) => { if (e.key === "Escape") e.target.blur(); });
}

$("rateDetail").addEventListener("click", (e) => {
  const r = byFile(current);
  if (r && e.target.matches("img.big")) return openFull();
  const el = e.target.closest("button, a[data-goto]");
  if (!r || !el) return;
  if (el.dataset.rate) return setRating(r, Number(el.dataset.rate));
  if (el.dataset.tag) return toggleTag(r, el.dataset.tag);
  if (el.dataset.goto) { e.preventDefault(); return emit("show-image", el.dataset.goto); }
  const act = el.dataset.act;
  if (act === "reproduce") openAction("reproduce", [r]);
  if (act === "reference") openAction("reference", [r]);
  if (act === "blend-toggle") { toggleBlend(r.file); renderDetail(); }
  if (act === "lock") { emit("lock-picks", r.picks); emit("tab", "batch"); }
});

async function saveRating(r, patch) {
  const prev = r.rating;
  const next = { value: prev?.value ?? null, tags: prev?.tags || [], notes: prev?.notes || "", ...patch };
  r.rating = next; // optimistic
  // Fast key presses send overlapping saves; only the newest response may update local state.
  const seq = (r._saveSeq = (r._saveSeq || 0) + 1);
  updateFigure(r.file);
  try {
    const saved = (await api(`/api/rating/${encodeURIComponent(r.file)}`, { method: "POST", body: next })).rating;
    if (seq === r._saveSeq) r.rating = saved;
    emit("ratings");
  } catch (e) {
    if (seq !== r._saveSeq) return toast("Could not save rating: " + e.message, true);
    r.rating = prev;
    updateFigure(r.file);
    if (r.file === current) renderDetail();
    toast("Could not save rating: " + e.message, true);
  }
}

function setRating(r, value) {
  saveRating(r, { value });
  if (autoAdvance && value != null) move(1);
  else renderDetail();
}

function toggleTag(r, tag) {
  const tags = r.rating?.tags || [];
  saveRating(r, { tags: tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag] });
  renderDetail();
}

document.addEventListener("keydown", (e) => {
  if (!isActive() || typingInField(e) || $("actionDialog").open || e.ctrlKey || e.metaKey || e.altKey) return;
  const r = byFile(current);
  const k = e.key;
  if (k === "ArrowRight" || k === "l") move(1);
  else if (k === "ArrowLeft" || k === "h") move(-1);
  else if (k === "ArrowDown" || k === "j") move(gridColumns());
  else if (k === "ArrowUp" || k === "k") move(-gridColumns());
  else if (!r) return;
  else if (/^[1-7]$/.test(k)) setRating(r, Number(k) - 1);
  else if (k === "0") { saveRating(r, { value: null }); renderDetail(); }
  else if (TAG_KEYS.includes(k)) toggleTag(r, TAGS[TAG_KEYS.indexOf(k)]);
  else if (k === "f" || k === " ") lightboxOpen() ? closeLightbox() : openFull();
  else if (k === "n") { closeLightbox(); $("rateNotes")?.focus(); }
  else if (k === "x") { toggleBlend(r.file); renderDetail(); }
  else return;
  e.preventDefault();
});

// ---------- actions: reproduce / reference / blend ----------
let action = null; // { kind, recs }

const BLEND_FEATURES = ["the face shape and bone structure", "the eyes", "the lips and nose", "the hair and brows"];
function defaultPrompt(kind, recs) {
  if (kind === "reproduce") return recs[0].prompt;
  if (kind === "reference")
    return "Keep the exact face, facial structure and identity of the adult woman in her mid-twenties in the reference image. " +
      "Candid phone photo of her, natural lighting, everyday snapshot. Change: ";
  const parts = recs.map((_, i) => `${BLEND_FEATURES[i]} of image ${i + 1}`);
  return `Create a new photo of a different adult woman in her mid-twenties combining ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}. ` +
    "Candid phone photo, natural skin texture, no makeup, ordinary natural lighting, everyday snapshot.";
}

function openAction(kind, recs) {
  if (!recs.length) return;
  action = { kind, recs };
  const titles = { reproduce: "Reproduce", reference: "Use as reference", blend: `Blend ${recs.length} images` };
  $("dlgTitle").textContent = titles[kind];
  $("dlgRefs").innerHTML = recs.map((r, i) => `<div><img src="${imgSrc(r.file)}" alt=""><span>${kind === "blend" ? i + 1 : ""}</span></div>`).join("");
  const needRefs = kind === "reproduce" ? 0 : recs.length;
  const eligible = state.models.filter((m) => !needRefs || (m.supported_parameters?.input_references?.max ?? 0) >= needRefs);
  const preferred = eligible.some((m) => m.id === recs[0].model) ? recs[0].model : eligible[0]?.id;
  $("dlgModel").innerHTML = eligible.map((m) => `<option value="${m.id}" ${m.id === preferred ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("");
  $("dlgModel").disabled = kind === "reproduce";
  $("dlgPrompt").value = defaultPrompt(kind, recs);
  $("dlgPrompt").readOnly = kind === "reproduce";
  $("dlgSeed").value = kind === "reproduce" ? recs[0].seed ?? "" : "";
  $("dlgSeed").readOnly = kind === "reproduce";
  $("dlgError").textContent = eligible.length ? "" : `No model accepts ${needRefs} reference image(s).`;
  $("dlgGo").disabled = !eligible.length;
  $("actionDialog").showModal();
  refreshDialogModel();
}

async function refreshDialogModel() {
  const model = $("dlgModel").value;
  if (!model || !action) return;
  const r = action.recs[0];
  let sp = {};
  try {
    sp = (await getCaps(model)).supported_parameters || {};
  } catch (e) {
    $("dlgError").textContent = e.message;
  }
  const res = sp.resolution?.values || [];
  const ars = sp.aspect_ratio?.values || [];
  const wantRes = action.kind === "reproduce" ? (res.includes("2K") ? "2K" : r.resolution) : r.resolution;
  $("dlgRes").innerHTML = optionsHtml(res, wantRes, { blank: "model default" });
  $("dlgAR").innerHTML = optionsHtml(ars, r.aspect_ratio, { blank: "model default" });
  $("dlgRes").disabled = !res.length;
  $("dlgAR").disabled = !ars.length;
  const notes = [];
  if (!sp.seed) notes.push(action.kind === "reproduce"
    ? "⚠ This model doesn't support seeds, so the result will differ from the original."
    : "⚠ This model doesn't support seeds.");
  else if (action.kind === "reproduce" && r.seed == null) notes.push("⚠ The original has no recorded seed, so the result will differ.");
  $("dlgModelNote").textContent = notes.join(" ");
  $("dlgSeed").disabled = !sp.seed;
}
$("dlgModel").onchange = refreshDialogModel;

$("dlgGo").onclick = async () => {
  const { kind, recs } = action;
  const model = $("dlgModel").value;
  const prompt = $("dlgPrompt").value.trim();
  if (!prompt) return ($("dlgError").textContent = "Enter a prompt.");
  const sp = (await getCaps(model).catch(() => ({}))).supported_parameters || {};
  const payload = { model, prompt, app: { kind, parent: kind === "blend" ? recs.map((r) => r.file) : recs[0].file } };
  if (kind !== "reproduce") payload.ref_files = recs.map((r) => r.file);
  if ($("dlgRes").value) payload.resolution = $("dlgRes").value;
  if ($("dlgAR").value) payload.aspect_ratio = $("dlgAR").value;
  if (sp.seed) {
    const raw = $("dlgSeed").value.trim();
    const s = raw === "" ? randomSeed() : Number(raw);
    if (!Number.isInteger(s) || s < 0 || s > MAX_SEED) return ($("dlgError").textContent = `Seed must be an integer 0–${MAX_SEED}.`);
    payload.seed = s;
  }
  $("dlgGo").disabled = true;
  $("dlgGo").textContent = "Generating…";
  $("dlgError").textContent = "";
  try {
    const body = await postImage(payload);
    addRecords(body.records || []);
    $("actionDialog").close();
    toast(`Done · ${fmtCost(body.usage?.cost)}`);
    if (body.records?.[0]) emit("show-image", body.records[0].file);
  } catch (e) {
    $("dlgError").textContent = (e.status ? `${e.status}: ` : "") + e.message;
  } finally {
    $("dlgGo").disabled = false;
    $("dlgGo").textContent = "Generate";
  }
};
