// Batch tab: prompt template with random slots, slot-pools editor, multi-model batch runs.

import { $, store, state, api, getCaps, randomSeed, escapeHtml, imgSrc, fmtCost, addRecords, emit, on, toast, optionsHtml, modelName, MAX_SEED, DEFAULT_MODEL } from "./util.js";
import { findSlots, buildPrompt, normalizeOptions } from "../lib/template.js";
import { commonEnumValues, estimateImageCost } from "../lib/params.js";
import { defaultPoolSet, DEFAULT_REF_TEMPLATE, DEFAULT_REF_POOLS } from "../lib/defaults.js";
import { activeGroup, groupList, createGroup, switchGroup, renameGroup, saveGroups, versionFields, pickSettings } from "./groups.js";
import { openLightbox } from "./lightbox.js";

// The active group (groups.js) mirrors its current version: { kind: "text" | "reference", template,
// pools: {slot: [{value, weight}]}, locks: {slot: value}, settings, refs }. Edits go straight into it and are
// saved to the server. A version's type is fixed when it is created; a reference version sends its reference
// images (refs) with every image in the batch.
let set = null;

const isRef = () => set?.kind === "reference";
const tpl = () => set.template ?? "";
const setTpl = (text) => (set.template = text);
const CFG_DEFAULTS = { models: [DEFAULT_MODEL], perModel: 4, resolution: "", aspect_ratio: "3:4", seedMode: "random", seed: "", concurrency: 3 };
let cfg = { ...CFG_DEFAULTS, ...store.get("batch:cfg", {}) };
let run = null;
let selectedCaps = []; // capabilities of cfg.models, same order

// Every edit saves straight into the current version, then the group (debounced).
const saveSet = () => {
  syncVersion();
  saveGroups();
};
// Settings save into the current version (and locally, for concurrency and as a fallback).
const saveCfg = () => {
  store.set("batch:cfg", cfg);
  if (!set) return;
  set.settings = pickSettings(cfg);
  saveSet();
};

// Load the current version's run settings into the controls.
function loadVersionSettings() {
  // Defaults first, so a setting missing from this version never carries over from the previous one.
  Object.assign(cfg, pickSettings(CFG_DEFAULTS), set.settings || {});
  cfg.models = (cfg.models || []).filter((id) => state.models.some((m) => m.id === id));
  $("perModel").value = cfg.perModel;
  $("batchSeed").value = cfg.seed ?? "";
  renderModelList();
  refreshSelection();
  setSeedMode(cfg.seedMode);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function initBatch() {
  set = activeGroup();
  renderGroupBar();
  showMode();
  $("concurrency").value = cfg.concurrency;
  loadVersionSettings();
  renderVersions();
}

// ---------- groups ----------
// force: also overwrite the name box while it has focus (after switching groups).
function renderGroupBar(force = false) {
  $("groupSelect").innerHTML = groupList()
    .map((g) => `<option value="${escapeHtml(g.id)}" ${g.id === set.id ? "selected" : ""}>${escapeHtml(g.name)}</option>`).join("");
  if (force || document.activeElement !== $("groupName")) $("groupName").value = set.name;
  const imgs = state.library.filter((r) => r.group_id === set.id);
  const runs = new Set(imgs.map((r) => r.batch_id).filter(Boolean)).size;
  $("groupInfo").textContent = `${imgs.length} image(s) · ${runs} run(s)`;
}

$("groupSelect").onchange = () => switchGroup($("groupSelect").value);
$("newGroup").onclick = () => {
  const g = createGroup();
  toast(`Created “${g.name}”, starting from a copy of the previous template and pools. Rename it in the box next to the picker.`);
  $("groupName").focus();
  $("groupName").select();
};
const commitRename = () => {
  if (!$("groupName").value.trim()) $("groupName").value = set.name;
  else if (renameGroup(set.id, $("groupName").value)) toast("Group renamed.");
};
$("groupName").addEventListener("change", commitRename);
$("groupName").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });

// Switching or creating a group swaps the template and pools being edited.
on("groups", () => {
  set = activeGroup();
  showMode();
  renderGroupBar(true);
  loadVersionSettings();
  renderVersions();
});
on("library", () => set && renderGroupBar());

// ---------- template ----------
$("template").addEventListener("input", () => {
  const before = findSlots(tpl()).join();
  setTpl($("template").value);
  saveSet();
  if (findSlots(tpl()).join() !== before) renderPools();
  renderTemplateInfo();
});

// ---------- version type: text only, or with reference images ----------
// Show the template, its pools and, for reference versions, the references panel.
function showMode() {
  $("refPanel").classList.toggle("hidden", !isRef());
  $("templateKind").textContent = isRef() ? "with reference images" : "text only";
  $("templateKind").classList.toggle("on", isRef());
  $("template").value = tpl();
  renderPools();
  renderTemplateInfo();
  renderRefs();
}

// Content for a version of the given type: blank, or that type's default template and pools.
function freshContent(kind, { defaults = false } = {}) {
  if (!defaults) return { kind, template: "", pools: {}, locks: {}, refs: [] };
  return kind === "reference"
    ? { kind, template: DEFAULT_REF_TEMPLATE, pools: structuredClone(DEFAULT_REF_POOLS), locks: {}, refs: [] }
    : { kind, ...defaultPoolSet(), refs: [] };
}

// ---------- reference images ----------
function renderRefs() {
  const refs = set.refs || [];
  $("batchRefs").innerHTML = refs.length
    ? refs.map((f, i) => `<div><img src="${imgSrc(f)}" alt="" data-file="${escapeHtml(f)}" title="${escapeHtml(f)}"><button type="button" data-i="${i}" title="Remove">×</button></div>`).join("")
    : '<p class="desc">No reference images yet. Add your starred picks, upload a photo, or use “Use as batch reference” in Rate or Compare.</p>';
  $("refNote").textContent = refs.length ? `${refs.length} reference image(s), sent with every image in the batch.` : "";
}

function addRefs(files) {
  set.refs ??= [];
  const before = set.refs.length;
  for (const f of files) if (!set.refs.includes(f)) set.refs.push(f);
  saveSet();
  renderRefs();
  renderWarnings();
  return set.refs.length - before;
}

$("batchRefs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-i]");
  if (btn) {
    set.refs.splice(Number(btn.dataset.i), 1);
    saveSet();
    renderRefs();
    renderWarnings();
  } else if (e.target.dataset.file) openLightbox(e.target.dataset.file, "Batch reference");
});
$("refAddStarred").onclick = () => {
  const starred = Object.keys(state.stars).filter((f) => state.library.some((r) => r.file === f));
  if (!starred.length) return toast("No starred images yet: star key picks in Rate or Compare (c).", true);
  const added = addRefs(starred);
  toast(added ? `Added ${added} starred image(s).` : "All starred images are already references.");
};
$("refClear").onclick = () => {
  set.refs = [];
  saveSet();
  renderRefs();
  renderWarnings();
};
$("refUpload").onchange = async (e) => {
  for (const file of e.target.files) {
    try {
      const data_url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
      addRefs([(await api("/api/uploads", { method: "POST", body: { data_url } })).file]);
    } catch (err) {
      toast(`Could not upload ${file.name}: ${err.message}`, true);
    }
  }
  e.target.value = "";
};

// "Use as batch reference" from Rate or Compare: add to the current version if it takes references; otherwise
// to this group's newest reference version, or a new one started from the default reference template.
on("add-batch-ref", (file) => {
  if (!isRef()) {
    const target = [...(set.versions || [])].reverse().find((v) => v.kind === "reference");
    if (target) switchVersion(target.id);
    else addVersion("reference", { defaults: true });
  }
  const added = addRefs([file]);
  toast(added ? `Added to the references of “${set.name}” › “${currentVersion().name}”.` : "Already a reference in this version.");
});
$("rePreview").onclick = () => renderTemplateInfo();

function renderTemplateInfo() {
  const slots = findSlots(tpl());
  const { prompt, missing } = buildPrompt(tpl(), set.pools, set.locks);
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
  // This template's slots, then pools it no longer uses (offered for removal).
  const slots = findSlots(tpl());
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
// Insert {name} at the template cursor (or the end) and start its pool with one empty option.
function addSlot() {
  const name = $("newSlotName").value.trim().replace(/^\{|\}$/g, "");
  if (!/^[A-Za-z_][\w-]*$/.test(name)) return toast("Slot names use letters, digits, _ and -, starting with a letter.", true);
  if (findSlots(tpl()).includes(name)) return toast(`{${name}} is already in the template.`, true);
  const t = $("template");
  const at = t.selectionStart ?? t.value.length;
  t.value = `${t.value.slice(0, at)}{${name}}${t.value.slice(at)}`;
  setTpl(t.value);
  if (!set.pools[name]?.length) set.pools[name] = [{ value: "", weight: 1 }];
  saveSet();
  renderPools();
  renderTemplateInfo();
  $("newSlotName").value = "";
  document.querySelector(`.slot[data-slot="${CSS.escape(name)}"] [data-opt]`)?.focus();
  toast(`Added {${name}}. Check where it landed in the template and adjust the wording around it.`);
}
$("addSlot").onclick = addSlot;
$("newSlotName").addEventListener("keydown", (e) => { if (e.key === "Enter") addSlot(); });

$("unlockAll").onclick = () => {
  set.locks = {};
  saveSet();
  renderPools();
  renderTemplateInfo();
};

// ---------- versions ----------
// Each group has its own versions (template, reference template, pools, locks) and is always on one of them;
// every edit is saved into that version (see saveSet). "Add new version" starts a blank one.
const currentVersion = () => set.versions?.find((v) => v.id === set.current);

// Copy the live template/pools/locks into the current version.
function syncVersion() {
  const v = currentVersion();
  if (v) Object.assign(v, versionFields(set));
}

const versionLabel = (v) =>
  `${v.name}${v.kind === "reference" ? " · with refs" : ""} · ${new Date(v.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;

function renderVersions() {
  showRename(false);
  const list = set.versions || [];
  const i = list.findIndex((v) => v.id === set.current);
  $("verSelect").innerHTML = list.map((v) => `<option value="${escapeHtml(v.id)}" ${v.id === set.current ? "selected" : ""}>${escapeHtml(versionLabel(v))}</option>`).join("");
  $("verPrev").disabled = i <= 0;
  $("verNext").disabled = i < 0 || i >= list.length - 1;
  $("verDelete").disabled = list.length <= 1;
  $("verCount").textContent = list.length > 1 ? `${i + 1} of ${list.length}` : "";
}

function switchVersion(id) {
  const v = set.versions?.find((x) => x.id === id);
  if (!v || id === set.current) return;
  syncVersion(); // already saved on every edit; this just makes sure
  set.current = id;
  Object.assign(set, versionFields(v));
  saveGroups();
  showMode();
  loadVersionSettings();
  renderVersions();
}

// "v4", or "v4 <label>" when a name is typed.
function nextVersionName() {
  const label = $("verName").value.replace(/\s+/g, " ").trim().slice(0, 40);
  const n = Math.max(0, ...(set.versions || []).map((v) => Number(v.name.match(/^v(\d+)/)?.[1] || 0))) + 1;
  return label ? `v${n} ${label}` : `v${n}`;
}

// A new version of the given type (blank unless defaults), keeping the current run settings; switches to it.
function addVersion(kind, { defaults = false } = {}) {
  syncVersion();
  const v = {
    id: `v-${Date.now().toString(36)}`,
    name: nextVersionName(),
    created_at: new Date().toISOString(),
    ...freshContent(kind, { defaults }),
    settings: pickSettings(cfg),
  };
  set.versions.push(v);
  set.current = v.id;
  Object.assign(set, versionFields(v));
  $("verName").value = "";
  saveGroups();
  showMode();
  loadVersionSettings();
  renderVersions();
  return v;
}

$("verAdd").onclick = () => {
  const v = addVersion($("verKind").value);
  $("template").focus();
  toast(`Started “${v.name}” (${v.kind === "reference" ? "with reference images" : "text only"}, blank). “Defaults” fills in the default template.`);
};
$("verName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("verAdd").click(); });

// Rename: the dropdown becomes a text box; Enter or clicking away saves, Esc cancels.
function showRename(on) {
  $("verSelect").classList.toggle("hidden", on);
  $("verRenameInput").classList.toggle("hidden", !on);
  $("verRename").classList.toggle("hidden", on);
}
$("verRename").onclick = () => {
  const v = currentVersion();
  if (!v) return;
  $("verRenameInput").value = v.name;
  showRename(true);
  $("verRenameInput").focus();
  $("verRenameInput").select();
};
function commitVersionRename(save) {
  if ($("verRenameInput").classList.contains("hidden")) return;
  const v = currentVersion();
  const name = $("verRenameInput").value.replace(/\s+/g, " ").trim().slice(0, 60);
  showRename(false);
  if (!save || !v || !name || name === v.name) return;
  if (set.versions.some((x) => x !== v && x.name.toLowerCase() === name.toLowerCase()))
    return toast(`This group already has a version called “${name}”.`, true);
  const old = v.name;
  v.name = name;
  saveGroups();
  renderVersions();
  toast(`Renamed “${old}” to “${name}”.`);
}
$("verRenameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") commitVersionRename(true);
  else if (e.key === "Escape") commitVersionRename(false);
});
$("verRenameInput").addEventListener("blur", () => commitVersionRename(true));
$("verSelect").onchange = () => switchVersion($("verSelect").value);
$("verPrev").onclick = () => switchVersion(set.versions[set.versions.findIndex((v) => v.id === set.current) - 1]?.id);
$("verNext").onclick = () => switchVersion(set.versions[set.versions.findIndex((v) => v.id === set.current) + 1]?.id);
$("verDelete").onclick = () => {
  const list = set.versions || [];
  const v = currentVersion();
  if (!v || list.length <= 1) return;
  if ($("verDelete").dataset.confirm !== v.id) {
    $("verDelete").dataset.confirm = v.id;
    $("verDelete").textContent = `Click again to delete ${v.name}`;
    setTimeout(() => { delete $("verDelete").dataset.confirm; $("verDelete").textContent = "Delete"; }, 3000);
    return;
  }
  delete $("verDelete").dataset.confirm;
  $("verDelete").textContent = "Delete";
  const i = list.indexOf(v);
  list.splice(i, 1);
  const next = list[Math.min(i, list.length - 1)];
  set.current = next.id;
  Object.assign(set, versionFields(next));
  saveGroups();
  showMode();
  loadVersionSettings();
  renderVersions();
  toast(`Deleted “${v.name}”; now on “${next.name}”.`);
};
$("poolReset").onclick = () => {
  // This version's type's default template and pools; its reference images stay.
  const { refs, ...content } = freshContent(set.kind, { defaults: true });
  Object.assign(set, content);
  saveSet();
  showMode();
  toast(`Filled “${currentVersion()?.name}” with the default ${isRef() ? "reference-image" : "text"} template and pools.`);
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

// Reference mode: selected models that can't take this many reference images.
const refsTooMany = () =>
  isRef() ? cfg.models.filter((_, i) => (selectedCaps[i]?.supported_parameters?.input_references?.max ?? 0) < (set.refs?.length ?? 0)) : [];

function renderWarnings() {
  const warn = [];
  if (isRef()) {
    const n = set.refs?.length ?? 0;
    if (!n) warn.push("⚠ This version uses reference images: add at least one.");
    const lacking = refsTooMany();
    if (lacking.length)
      warn.push(`⚠ Can't take ${n} reference image(s), so the batch won't run: ${lacking.map((id) => {
        const i = cfg.models.indexOf(id);
        return `${escapeHtml(modelName(id))} (max ${selectedCaps[i]?.supported_parameters?.input_references?.max ?? 0})`;
      }).join(", ")}`);
  }
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
  const refCount = isRef() ? set.refs?.length ?? 0 : 0;
  cfg.models.forEach((_, i) => {
    const c = estimateImageCost(selectedCaps[i]?.pricing, cfg.resolution);
    if (c == null) unknown++;
    else est += c * cfg.perModel;
    // Reference images are billed as input images where the provider lists a price for them.
    const input = (selectedCaps[i]?.pricing || []).find((p) => p.billable === "input_image" && p.unit === "image");
    if (input && refCount) est += input.cost_usd * refCount * cfg.perModel;
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
  if (mode === "fixed" && $("batchSeed").value === "") $("batchSeed").value = cfg.seed = randomSeed();
  saveCfg();
  document.querySelectorAll("#batchSeedBox .seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("batchSeed").disabled = mode === "random";
  $("batchSeedNote").textContent = mode === "random"
    ? "Each image gets its own random seed (recorded with the image)."
    : "Every image uses this seed. Only the slot picks vary.";
}
document.querySelectorAll("#batchSeedBox .seg button").forEach((b) => (b.onclick = () => setSeedMode(b.dataset.mode)));

// ---------- run ----------
function buildJobs(batchId, batchName) {
  const fixed = Number(cfg.seed);
  const jobs = [];
  cfg.models.forEach((model, mi) => {
    const sp = selectedCaps[mi]?.supported_parameters || {};
    for (let i = 0; i < cfg.perModel; i++) {
      const { prompt, picks } = buildPrompt(tpl(), set.pools, set.locks);
      const payload = {
        model,
        prompt,
        app: { kind: "batch", template: tpl(), picks, batch_id: batchId, batch_name: batchName || undefined, group_id: set.id },
      };
      if (isRef()) {
        payload.ref_files = [...set.refs]; // the server sends these as input_references and records them
        payload.app.mode = "reference";
      }
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
  if (!tpl().trim()) problems.push("The template is empty: write one, or click “Defaults”.");
  const { missing } = buildPrompt(tpl(), set.pools, set.locks);
  if (missing.length) problems.push(`No options for ${missing.map((s) => `{${s}}`).join(", ")}.`);
  if (!cfg.models.length) problems.push("Select at least one model.");
  if (isRef() && !set.refs?.length) problems.push("This version uses reference images: add at least one.");
  if (refsTooMany().length) problems.push(`These models can't take ${set.refs.length} reference image(s): ${refsTooMany().map(modelName).join(", ")}. Remove references or untick them.`);
  if (cfg.seedMode === "fixed") {
    const s = Number(cfg.seed);
    if (!Number.isInteger(s) || s < 0 || s > MAX_SEED) problems.push(`Seed must be an integer 0–${MAX_SEED}.`);
  }
  if (selectedCaps.length !== cfg.models.length) problems.push("Model capabilities are still loading.");
  if (problems.length) return ($("batchError").textContent = problems.join("\n"));
  $("batchError").textContent = "";

  const batchId = new Date().toISOString().replace(/[:.]/g, "-");
  const queue = buildJobs(batchId, $("batchName").value.trim());
  emit("batch-started", { id: batchId, group: set.id }); // Analysis switches to this run
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
