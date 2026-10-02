// Batch tab: prompt template with random slots, slot-pools editor, multi-model batch runs.

import { $, store, state, api, getCaps, randomSeed, escapeHtml, imgSrc, fmtCost, addRecords, emit, on, toast, optionsHtml, modelName, MAX_SEED, DEFAULT_MODEL } from "./util.js";
import { findSlots, buildPrompt, normalizeOptions } from "../lib/template.js";
import { commonEnumValues, estimateImageCost } from "../lib/params.js";
import { defaultPoolSet } from "../lib/defaults.js";

let set = store.get("batch:set", null) || defaultPoolSet(); // { template, pools: {slot: [{value, weight}]}, locks: {slot: value} }
let cfg = {
  models: [DEFAULT_MODEL], perModel: 4, resolution: "", aspect_ratio: "3:4", seedMode: "random", seed: "", concurrency: 3,
  ...store.get("batch:cfg", {}),
};
let run = null;
let selectedCaps = []; // capabilities of cfg.models, same order

const saveSet = () => store.set("batch:set", set);
const saveCfg = () => store.set("batch:cfg", cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function initBatch() {
  cfg.models = cfg.models.filter((id) => state.models.some((m) => m.id === id));
  $("template").value = set.template;
  $("perModel").value = cfg.perModel;
  $("concurrency").value = cfg.concurrency;
  $("batchSeed").value = cfg.seed;
  renderPools();
  renderTemplateInfo();
  renderModelList();
  refreshSelection();
  refreshPoolSetList();
  setSeedMode(cfg.seedMode);
}

// ---------- template ----------
$("template").addEventListener("input", () => {
  const before = findSlots(set.template).join();
  set.template = $("template").value;
  saveSet();
  if (findSlots(set.template).join() !== before) renderPools();
  renderTemplateInfo();
});
$("rePreview").onclick = () => renderTemplateInfo();

function renderTemplateInfo() {
  const slots = findSlots(set.template);
  const { prompt, missing } = buildPrompt(set.template, set.pools, set.locks);
  const unused = Object.keys(set.pools).filter((s) => !slots.includes(s));
  const notes = [];
  if (missing.length) notes.push(`<span class="warn">No options for: ${missing.map((s) => `{${escapeHtml(s)}}`).join(", ")}</span>`);
  if (unused.length) notes.push(`Pools not used by the template: ${unused.map(escapeHtml).join(", ")}`);
  notes.push(`${slots.length} slot(s): ${slots.map((s) => `{${escapeHtml(s)}}`).join(" ") || "none"}`);
  $("templateNote").innerHTML = notes.join("<br>");
  $("preview").textContent = prompt;
}

// ---------- slot pools ----------
function renderPools() {
  const slots = findSlots(set.template);
  const all = [...slots, ...Object.keys(set.pools).filter((s) => !slots.includes(s))];
  for (const s of slots) set.pools[s] ??= [];
  $("pools").innerHTML = all.map((slot) => {
    // Keep blank rows (a just-added option) in the editor; normalizeOptions drops them for picking.
    set.pools[slot] = (set.pools[slot] || []).map((o) => (typeof o === "string" ? { value: o, weight: 1 } : o));
    const opts = normalizeOptions(set.pools[slot]);
    const lock = set.locks[slot];
    const lockValues = [...new Set([...opts.map((o) => o.value), ...(lock ? [lock] : [])])];
    const used = slots.includes(slot);
    return `
      <div class="slot ${lock ? "locked" : ""} ${used ? "" : "unused"}" data-slot="${escapeHtml(slot)}">
        <div class="row between">
          <b>{${escapeHtml(slot)}}</b>
          <span class="row">
            <label class="lock" title="Lock this slot to one value">🔒
              <select data-lock>${optionsHtml(lockValues, lock ?? "", { blank: "random" })}</select>
            </label>
            ${used ? "" : '<button type="button" data-remove-slot title="Not in the template">Remove</button>'}
          </span>
        </div>
        <div class="opts">
          ${(set.pools[slot] || []).map((o, i) => `
            <div class="opt">
              <input type="text" data-opt="${i}" value="${escapeHtml(o.value)}" placeholder="option text">
              <input type="number" data-weight="${i}" value="${o.weight ?? 1}" min="0" step="0.5" title="Weight (0 = never pick)">
              <button type="button" data-del="${i}" title="Remove option">×</button>
            </div>`).join("")}
        </div>
        <button type="button" data-add>+ option</button>
      </div>`;
  }).join("") || '<p class="desc">Add {slot} placeholders to the template to create pools.</p>';
}

const slotOf = (el) => el.closest(".slot")?.dataset.slot;

$("pools").addEventListener("input", (e) => {
  const slot = slotOf(e.target);
  if (!slot) return;
  const pool = set.pools[slot];
  if (e.target.dataset.opt !== undefined) pool[+e.target.dataset.opt].value = e.target.value;
  else if (e.target.dataset.weight !== undefined) pool[+e.target.dataset.weight].weight = e.target.value === "" ? 1 : Number(e.target.value);
  else return;
  saveSet();
  renderTemplateInfo();
});

$("pools").addEventListener("change", (e) => {
  const slot = slotOf(e.target);
  if (!slot) return;
  if (e.target.dataset.lock !== undefined) {
    if (e.target.value) set.locks[slot] = e.target.value;
    else delete set.locks[slot];
    saveSet();
    renderPools();
    renderTemplateInfo();
  } else if (e.target.dataset.opt !== undefined) {
    renderPools(); // refresh lock dropdowns with the edited text
  }
});

$("pools").addEventListener("click", (e) => {
  const slot = slotOf(e.target);
  if (!slot) return;
  const pool = set.pools[slot];
  if (e.target.dataset.add !== undefined) {
    pool.push({ value: "", weight: 1 });
    renderPools();
    const inputs = document.querySelectorAll(`.slot[data-slot="${CSS.escape(slot)}"] [data-opt]`);
    inputs[inputs.length - 1]?.focus();
  } else if (e.target.dataset.del !== undefined) {
    pool.splice(+e.target.dataset.del, 1);
    renderPools();
  } else if (e.target.dataset.removeSlot !== undefined) {
    delete set.pools[slot];
    delete set.locks[slot];
    renderPools();
  } else return;
  saveSet();
  renderTemplateInfo();
});

// "Lock picks" from the Rate tab: lock every slot to that image's picks.
on("lock-picks", (picks) => {
  set.locks = { ...picks };
  saveSet();
  renderPools();
  renderTemplateInfo();
  toast(`Locked ${Object.keys(picks).length} slot(s). Unlock any you want to keep varying.`);
});
$("unlockAll").onclick = () => {
  set.locks = {};
  saveSet();
  renderPools();
  renderTemplateInfo();
};

// ---------- pool sets (saved on the server in data/pool-sets) ----------
async function refreshPoolSetList(select) {
  try {
    const { names } = await api("/api/pool-sets");
    $("poolSetSelect").innerHTML = optionsHtml(names, select ?? $("poolSetSelect").value, { blank: names.length ? "— saved sets —" : "no saved sets" });
  } catch (e) {
    toast("Could not list pool sets: " + e.message, true);
  }
}
$("poolLoad").onclick = async () => {
  const name = $("poolSetSelect").value;
  if (!name) return;
  try {
    const s = await api(`/api/pool-sets/${encodeURIComponent(name)}`);
    set = { template: s.template, pools: s.pools, locks: s.locks || {} };
    saveSet();
    $("template").value = set.template;
    $("poolSetName").value = name;
    renderPools();
    renderTemplateInfo();
    toast(`Loaded “${name}”.`);
  } catch (e) {
    toast(e.message, true);
  }
};
$("poolSave").onclick = async () => {
  const name = $("poolSetName").value.trim() || $("poolSetSelect").value;
  if (!name) return toast("Type a name for the set first.", true);
  try {
    const pools = Object.fromEntries(Object.entries(set.pools).map(([k, v]) => [k, normalizeOptions(v)]));
    await api(`/api/pool-sets/${encodeURIComponent(name)}`, { method: "PUT", body: { ...set, pools } });
    await refreshPoolSetList(name);
    toast(`Saved “${name}”.`);
  } catch (e) {
    toast(e.message, true);
  }
};
$("poolDelete").onclick = async () => {
  const name = $("poolSetSelect").value;
  if (!name) return;
  if ($("poolDelete").dataset.confirm !== name) {
    $("poolDelete").dataset.confirm = name;
    $("poolDelete").textContent = "Click again to delete";
    setTimeout(() => { delete $("poolDelete").dataset.confirm; $("poolDelete").textContent = "Delete"; }, 3000);
    return;
  }
  await api(`/api/pool-sets/${encodeURIComponent(name)}`, { method: "DELETE" }).catch((e) => toast(e.message, true));
  delete $("poolDelete").dataset.confirm;
  $("poolDelete").textContent = "Delete";
  refreshPoolSetList("");
};
$("poolReset").onclick = () => {
  set = defaultPoolSet();
  saveSet();
  $("template").value = set.template;
  renderPools();
  renderTemplateInfo();
  toast("Restored the default template and pools (saved sets are unchanged).");
};

// ---------- models & run settings ----------
function renderModelList() {
  const q = $("modelFilter").value.trim().toLowerCase();
  $("batchModels").innerHTML = state.models
    .filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.includes(q) || cfg.models.includes(m.id))
    .map((m) => `
      <label class="check">
        <input type="checkbox" value="${m.id}" ${cfg.models.includes(m.id) ? "checked" : ""}>
        <span>${escapeHtml(m.name)}</span>
        ${m.supported_parameters?.seed ? '<span class="badge">seed</span>' : '<span class="badge dim" title="No seed support">no seed</span>'}
      </label>`).join("");
}
$("modelFilter").addEventListener("input", renderModelList);
$("batchModels").addEventListener("change", (e) => {
  const id = e.target.value;
  cfg.models = e.target.checked ? [...new Set([...cfg.models, id])] : cfg.models.filter((m) => m !== id);
  saveCfg();
  refreshSelection();
});

async function refreshSelection() {
  const models = [...cfg.models];
  $("selectedCount").textContent = models.length ? `${models.length} selected` : "none selected";
  try {
    const caps = await Promise.all(models.map(getCaps));
    if (models.join() !== cfg.models.join()) return; // selection changed meanwhile
    selectedCaps = caps;
  } catch (e) {
    $("modelWarnings").innerHTML = `<span class="warn">Could not load capabilities: ${escapeHtml(e.message)}</span>`;
    return;
  }
  const sps = selectedCaps.map((c) => c.supported_parameters || {});
  const res = commonEnumValues(sps, "resolution");
  const ars = commonEnumValues(sps, "aspect_ratio");
  if (cfg.resolution && !res.includes(cfg.resolution)) cfg.resolution = "";
  if (cfg.aspect_ratio && !ars.includes(cfg.aspect_ratio)) cfg.aspect_ratio = "";
  $("batchRes").innerHTML = optionsHtml(res, cfg.resolution, { blank: "model default" });
  $("batchAR").innerHTML = optionsHtml(ars, cfg.aspect_ratio, { blank: "model default" });
  renderWarnings();
}

function renderWarnings() {
  const warn = [];
  const noSeed = cfg.models.filter((_, i) => !selectedCaps[i]?.supported_parameters?.seed);
  if (noSeed.length) warn.push(`⚠ No seed support (results can't be reproduced exactly): ${noSeed.map(modelName).map(escapeHtml).join(", ")}`);
  for (const key of ["resolution", "aspect_ratio"]) {
    if (!cfg[key]) continue;
    const lacking = cfg.models.filter((_, i) => !selectedCaps[i]?.supported_parameters?.[key]);
    if (lacking.length) warn.push(`${key.replace("_", " ")} isn't supported by ${lacking.map(modelName).map(escapeHtml).join(", ")}, so those use their default.`);
  }
  $("modelWarnings").innerHTML = warn.map((w) => `<div class="${w.startsWith("⚠") ? "warn" : ""}">${w}</div>`).join("");

  let est = 0;
  let unknown = 0;
  cfg.models.forEach((_, i) => {
    const c = estimateImageCost(selectedCaps[i]?.pricing, cfg.resolution);
    if (c == null) unknown++;
    else est += c * cfg.perModel;
  });
  const total = cfg.models.length * cfg.perModel;
  $("estimate").textContent = total
    ? `${total} image(s) · est. ≈${fmtCost(est)}${unknown ? ` + ${unknown} model(s) without pricing info` : ""}`
    : "";
}

$("batchRes").onchange = () => { cfg.resolution = $("batchRes").value; saveCfg(); renderWarnings(); };
$("batchAR").onchange = () => { cfg.aspect_ratio = $("batchAR").value; saveCfg(); renderWarnings(); };
$("perModel").oninput = () => { cfg.perModel = Math.max(1, Math.min(200, Number($("perModel").value) || 1)); saveCfg(); renderWarnings(); };
$("concurrency").oninput = () => { cfg.concurrency = Math.max(1, Math.min(8, Number($("concurrency").value) || 1)); saveCfg(); };
$("batchSeed").oninput = () => { cfg.seed = $("batchSeed").value; saveCfg(); };

function setSeedMode(mode) {
  cfg.seedMode = mode;
  saveCfg();
  document.querySelectorAll("#batchSeedBox .seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("batchSeed").disabled = mode === "random";
  if (mode === "fixed" && $("batchSeed").value === "") $("batchSeed").value = cfg.seed = randomSeed();
  $("batchSeedNote").textContent = mode === "random"
    ? "Each image gets its own random seed (recorded with the image)."
    : "Every image uses this seed. Only the slot picks vary.";
}
document.querySelectorAll("#batchSeedBox .seg button").forEach((b) => (b.onclick = () => setSeedMode(b.dataset.mode)));

// ---------- run ----------
function buildJobs(batchId) {
  const fixed = Number(cfg.seed);
  const jobs = [];
  cfg.models.forEach((model, mi) => {
    const sp = selectedCaps[mi]?.supported_parameters || {};
    for (let i = 0; i < cfg.perModel; i++) {
      const { prompt, picks } = buildPrompt(set.template, set.pools, set.locks);
      const payload = {
        model,
        prompt,
        app: { kind: "batch", template: set.template, picks, batch_id: batchId },
      };
      if (sp.resolution && cfg.resolution) payload.resolution = cfg.resolution;
      if (sp.aspect_ratio && cfg.aspect_ratio) payload.aspect_ratio = cfg.aspect_ratio;
      if (sp.seed) payload.seed = cfg.seedMode === "fixed" ? fixed : randomSeed();
      jobs.push(payload);
    }
  });
  return jobs;
}

// One retry for network errors, rate limits and server errors; other 4xx fail straight away.
export async function postImage(payload) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api("/api/images", { method: "POST", body: payload });
    } catch (e) {
      const retryable = !e.status || e.status === 429 || e.status >= 500;
      if (attempt >= 1 || !retryable) throw e;
      await sleep(e.status === 429 ? 5000 : 1500);
    }
  }
}

async function runBatch() {
  const problems = [];
  const { missing } = buildPrompt(set.template, set.pools, set.locks);
  if (missing.length) problems.push(`No options for ${missing.map((s) => `{${s}}`).join(", ")}.`);
  if (!cfg.models.length) problems.push("Select at least one model.");
  if (cfg.seedMode === "fixed") {
    const s = Number(cfg.seed);
    if (!Number.isInteger(s) || s < 0 || s > MAX_SEED) problems.push(`Seed must be an integer 0–${MAX_SEED}.`);
  }
  if (selectedCaps.length !== cfg.models.length) problems.push("Model capabilities are still loading.");
  if (problems.length) return ($("batchError").textContent = problems.join("\n"));
  $("batchError").textContent = "";

  const batchId = new Date().toISOString().replace(/[:.]/g, "-");
  const queue = buildJobs(batchId);
  run = { stopped: false, total: queue.length, done: 0, failed: 0, cost: 0, started: Date.now() };
  $("runBatch").disabled = true;
  $("stopBatch").disabled = false;
  $("batchErrors").innerHTML = "";
  $("batchResults").innerHTML = "";
  renderProgress();

  const worker = async () => {
    while (queue.length && !run.stopped) {
      const job = queue.shift();
      try {
        const body = await postImage(job);
        run.cost += body.usage?.cost || 0;
        addRecords(body.records || []);
        for (const r of body.records || []) {
          $("batchResults").insertAdjacentHTML("beforeend",
            `<figure data-file="${escapeHtml(r.file)}" title="${escapeHtml(r.prompt)}"><img src="${imgSrc(r.file)}" alt=""><figcaption>${escapeHtml(modelName(r.model))}</figcaption></figure>`);
        }
        for (const d of body.dropped || []) console.info(`[batch] ${job.model}: dropped ${d.key} (${d.reason})`);
      } catch (e) {
        run.failed++;
        $("batchErrors").insertAdjacentHTML("beforeend",
          `<div>${escapeHtml(modelName(job.model))}: ${escapeHtml((e.status ? e.status + " " : "") + e.message)}</div>`);
      }
      run.done++;
      renderProgress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, queue.length) }, worker));
  const skipped = run.total - run.done;
  toast(`Batch finished: ${run.done - run.failed} ok, ${run.failed} failed${skipped ? `, ${skipped} skipped` : ""}, ${fmtCost(run.cost)}.`, run.failed > 0);
  $("runBatch").disabled = false;
  $("stopBatch").disabled = true;
  renderProgress(true);
}

function renderProgress(finished = false) {
  if (!run) return;
  const secs = Math.round((Date.now() - run.started) / 1000);
  $("progressBar").style.width = `${(run.done / run.total) * 100}%`;
  $("progressText").textContent =
    `${run.done}/${run.total} done · ${run.failed} failed · ${fmtCost(run.cost)} · ${secs}s` +
    (run.stopped && !finished ? " · stopping after current requests…" : "") +
    (finished && run.stopped ? " · stopped" : "");
}

$("runBatch").onclick = runBatch;
$("stopBatch").onclick = () => { if (run) { run.stopped = true; renderProgress(); } };
$("batchResults").addEventListener("click", (e) => {
  const fig = e.target.closest("figure");
  if (fig) emit("show-image", fig.dataset.file);
});
