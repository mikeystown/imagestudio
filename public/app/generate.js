// Generate tab: single prompt, single run (the original Image Studio screen).

import { $, store, state, api, getCaps, providerOptionsHtml, randomSeed, escapeHtml, imgSrc, addRecords, MAX_SEED, DEFAULT_MODEL } from "./util.js";
import { openLightbox } from "./lightbox.js";
import { activeGroup } from "./groups.js";
import { providerCaps } from "../lib/params.js";

let seedMode = "random";
let refs = []; // data URLs
let history = store.get("history", []);
let selected = null;
let modelCaps = null; // capabilities of the current model, all providers
let caps = {}; // supported_parameters of the current model and provider

const currentModel = () => state.models.find((m) => m.id === $("model").value);

export function initGenerate() {
  $("model").innerHTML = state.models.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  const saved = store.get("model", DEFAULT_MODEL);
  const has = (id) => state.models.some((m) => m.id === id);
  $("model").value = has(saved) ? saved : has(DEFAULT_MODEL) ? DEFAULT_MODEL : state.models[0]?.id;
  $("model").onchange = renderParams;
  $("provider").onchange = () => { store.set("provider:" + $("model").value, $("provider").value); renderParams(); };
  renderParams();
}

// Build controls from the model's advertised supported_parameters.
async function renderParams() {
  const m = currentModel();
  if (!m) return;
  store.set("model", m.id);
  $("modelDesc").textContent = m.description || "";
  try {
    modelCaps = await getCaps(m.id);
  } catch (e) {
    modelCaps = { supported_parameters: m.supported_parameters || {}, endpoints: [] };
    $("error").textContent = "Could not load capabilities: " + e.message;
  }
  if (currentModel() !== m) return; // model changed while loading
  // A provider choice only matters when several providers serve the model.
  const multi = modelCaps.endpoints?.length > 1;
  $("providerField").classList.toggle("hidden", !multi);
  $("provider").innerHTML = providerOptionsHtml(modelCaps, multi ? store.get("provider:" + m.id, "") : "");
  caps = providerCaps(modelCaps, $("provider").value).supported_parameters;
  const savedParams = store.get("params:" + m.id, {});
  const html = [];

  for (const [key, spec] of Object.entries(caps)) {
    if (key === "seed" || key === "input_references") continue;
    const label = key.replace(/_/g, " ");
    if (spec.type === "enum") {
      const opts = ['<option value="">default</option>']
        .concat(spec.values.map((v) => `<option ${savedParams[key] === v ? "selected" : ""}>${escapeHtml(v)}</option>`));
      html.push(`<label class="field">${label}<select data-param="${key}">${opts.join("")}</select></label>`);
    } else if (spec.type === "range") {
      if (spec.min === spec.max) continue; // nothing to choose (e.g. n: 1-1)
      html.push(`<label class="field">${label} (${spec.min}–${spec.max})<input type="number" data-param="${key}" data-num min="${spec.min}" max="${spec.max}" step="1" placeholder="default" value="${savedParams[key] ?? ""}"></label>`);
    } else {
      // Free-form parameter (e.g. "size"); sent as text, or as a number if it parses as one.
      html.push(`<label class="field">${label}<input type="text" data-param="${key}" placeholder="default" value="${escapeHtml(savedParams[key] ?? "")}"></label>`);
    }
  }
  $("params").innerHTML = html.join("");

  const seedOk = !!caps.seed;
  $("seedBox").style.opacity = seedOk ? 1 : 0.5;
  $("seedBox").querySelectorAll("button,input").forEach((el) => (el.disabled = !seedOk || (el.id === "seed" && seedMode === "random")));
  $("seedNote").textContent = seedOk
    ? seedMode === "random"
      ? "A new random seed is picked for each run and recorded so you can reuse it."
      : "This exact seed is sent every run. Determinism depends on the provider."
    : "⚠ This model doesn't accept a seed, so images can't be reproduced exactly.";
  $("seedNote").classList.toggle("warn", !seedOk);

  const refSpec = caps.input_references;
  $("refBox").classList.toggle("hidden", !refSpec || refSpec.max === 0);
  if (refSpec) {
    $("refLimit").textContent = `(${refSpec.min ? "required, " : ""}up to ${refSpec.max})`;
    refs = refs.slice(0, refSpec.max);
    renderRefs();
  }
}

function collectParams() {
  const out = {};
  document.querySelectorAll("#params [data-param]").forEach((el) => {
    const v = el.value.trim();
    if (v === "") return;
    out[el.dataset.param] = el.dataset.num !== undefined || /^\d+$/.test(v) ? Number(v) : v;
  });
  return out;
}

// ---------- seed ----------
function setSeedMode(mode) {
  seedMode = mode;
  document.querySelectorAll("#seedBox .seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  if (mode === "fixed" && $("seed").value === "") $("seed").value = randomSeed();
  renderParams();
}
document.querySelectorAll("#seedBox .seg button").forEach((b) => (b.onclick = () => setSeedMode(b.dataset.mode)));
$("roll").onclick = () => { $("seed").value = randomSeed(); if (seedMode === "random") setSeedMode("fixed"); };

// ---------- reference images ----------
$("refInput").onchange = async (e) => {
  const max = caps.input_references?.max ?? 0;
  for (const file of e.target.files) {
    if (refs.length >= max) break;
    refs.push(await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file); }));
  }
  e.target.value = "";
  renderRefs();
};
function renderRefs() {
  $("refs").innerHTML = refs.map((src, i) => `<div><img src="${src}"><button type="button" data-i="${i}">×</button></div>`).join("");
  $("refs").querySelectorAll("button").forEach((b) => (b.onclick = () => { refs.splice(+b.dataset.i, 1); renderRefs(); }));
}

// ---------- generate ----------
async function generate() {
  const m = currentModel();
  const prompt = $("prompt").value.trim();
  $("error").textContent = "";
  if (!m) return;
  if (!prompt) return ($("error").textContent = "Enter a prompt.");

  const params = collectParams();
  store.set("params:" + m.id, params);
  const provider = $("provider").value;
  const payload = { model: m.id, prompt, ...params, provider: provider || undefined, app: { kind: "single", group_id: activeGroup()?.id } };

  if (caps.seed) {
    if (seedMode === "fixed") {
      const s = Number($("seed").value);
      if (!Number.isInteger(s) || s < 0 || s > MAX_SEED) return ($("error").textContent = `Seed must be an integer 0–${MAX_SEED}.`);
      payload.seed = s;
    } else {
      payload.seed = randomSeed();
    }
  }
  if (refs.length) payload.input_references = refs.map((url) => ({ type: "image_url", image_url: { url } }));
  const refMin = caps.input_references?.min || 0;
  if (refs.length < refMin) return ($("error").textContent = `This model needs at least ${refMin} reference image(s).`);

  $("go").disabled = true;
  $("go").textContent = "Generating…";
  $("viewer").innerHTML = '<div class="spinner"></div>';
  $("meta").innerHTML = "";
  try {
    const body = await api("/api/images", { method: "POST", body: payload });
    if (!body.saved?.length) throw new Error("No image returned.");
    const perImage = body.usage?.cost != null ? body.usage.cost / body.saved.length : undefined;
    const entries = body.saved.map((file) => ({
      file, model: m.id, modelName: m.name, provider, prompt, params, seed: payload.seed ?? null,
      refs: refs.length, cost: perImage, ms: body.ms, at: Date.now(),
    }));
    history = entries.concat(history).slice(0, 200);
    store.set("history", history);
    addRecords(body.records || []);
    show(entries[0]);
  } catch (e) {
    $("error").textContent = (e.status ? `${e.status}: ` : "") + e.message;
    $("viewer").innerHTML = '<p class="desc">Generation failed.</p>';
  } finally {
    $("go").disabled = false;
    $("go").textContent = "Generate";
  }
}
$("go").onclick = generate;
$("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) generate(); });

// ---------- viewer & history ----------
function show(entry) {
  selected = entry;
  const src = imgSrc(entry.file);
  $("viewer").innerHTML = `<img class="zoomable" src="${src}" alt="" title="View full size">`;
  $("viewer").querySelector("img").onclick = () =>
    openLightbox(entry.file, `${entry.modelName || entry.model} · seed ${entry.seed ?? "—"}`);
  const p = Object.entries(entry.params || {}).map(([k, v]) => `<span>${k}: <b>${escapeHtml(String(v))}</b></span>`).join("");
  $("meta").innerHTML = `
    <span>model: <b>${escapeHtml(entry.modelName || entry.model)}</b></span>
    ${entry.provider ? `<span>provider: <b>${escapeHtml(entry.provider)}</b></span>` : ""}
    <span>seed: <b>${entry.seed ?? "—"}</b></span>
    ${p}
    ${entry.cost != null ? `<span>cost: <b>$${Number(entry.cost).toFixed(4)}</b></span>` : ""}
    ${entry.ms ? `<span>time: <b>${(entry.ms / 1000).toFixed(1)}s</b></span>` : ""}
    <span style="flex-basis:100%">${escapeHtml(entry.prompt)}</span>
    <span class="row" style="flex-basis:100%">
      <button type="button" id="reuseAll">Reuse settings + seed</button>
      <button type="button" id="reuseSeed" ${entry.seed == null ? "disabled" : ""}>Reuse seed only</button>
      <a href="${src}" download><button type="button">Download</button></a>
    </span>`;
  $("reuseSeed").onclick = () => { $("seed").value = entry.seed; setSeedMode("fixed"); };
  $("reuseAll").onclick = () => reuse(entry);
  renderHistory();
}

function reuse(entry) {
  if (state.models.some((m) => m.id === entry.model)) $("model").value = entry.model;
  store.set("provider:" + entry.model, entry.provider || "");
  store.set("params:" + entry.model, entry.params || {});
  $("prompt").value = entry.prompt;
  renderParams();
  if (entry.seed != null) { $("seed").value = entry.seed; setSeedMode("fixed"); }
}

function renderHistory() {
  if (!history.length) {
    $("history").innerHTML = '<p class="desc">Nothing yet. Images are saved to <code>outputs/</code>.</p>';
    return;
  }
  $("history").innerHTML = history.map((h, i) => `
    <figure data-i="${i}" class="${selected?.file === h.file ? "sel" : ""}">
      <img loading="lazy" src="${imgSrc(h.file)}" alt="">
      <figcaption>seed ${h.seed ?? "—"} · ${escapeHtml(h.prompt)}</figcaption>
    </figure>`).join("");
  $("history").querySelectorAll("figure").forEach((f) => (f.onclick = () => show(history[+f.dataset.i])));
}
$("clearHistory").onclick = () => { history = []; store.set("history", history); renderHistory(); };
renderHistory();
