// Entry point: tabs, model list, library, then each tab's setup.

import { $, store, state, api, on, emit, loadLibrary, toast } from "./util.js";
import { initGenerate } from "./generate.js";
import { initBatch } from "./batch.js";
import { initRate } from "./rate.js";
import { initAnalysis } from "./analysis-view.js";
import { initCompare } from "./compare-view.js";
import { loadGroups } from "./groups.js";
import { defaultPoolSet } from "../lib/defaults.js";

const TABS = ["generate", "batch", "rate", "compare", "analysis"];

// silent: switch the visible tab without notifying tabs (used before startup data has loaded).
function showTab(name, { silent = false } = {}) {
  if (!TABS.includes(name)) name = "generate";
  for (const t of TABS) $(`tab-${t}`).classList.toggle("hidden", t !== name);
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  store.set("tab", name);
  if (!silent) emit("tab-shown", name);
}
document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
on("tab", showTab);

async function start() {
  showTab(store.get("tab", "generate"), { silent: true });
  try {
    const body = await api("/api/models");
    state.models = (body.data || []).filter((m) => m.architecture?.output_modalities?.includes("image"));
    state.models.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    $("model").innerHTML = "<option>Failed to load</option>";
    $("error").textContent = "Could not load models: " + e.message;
  }
  await loadLibrary().catch((e) => toast("Could not load the image library: " + e.message, true));
  state.comparisons = await api("/api/comparisons").then((b) => b.comparisons).catch((e) => {
    toast("Could not load comparisons: " + e.message, true);
    return [];
  });
  await loadGroups().catch((e) => {
    // Keep the app usable with an unsaved in-memory group.
    state.groups = { active: "default", groups: [{ id: "default", name: "Group 1", ...(store.get("batch:set", null) || defaultPoolSet()) }] };
    toast("Could not load groups (changes won't be saved): " + e.message, true);
  });
  initGenerate();
  initBatch();
  initRate();
  initAnalysis();
  initCompare();
  emit("tab-shown", store.get("tab", "generate"));
}
start();
