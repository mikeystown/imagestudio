// Entry point: tabs, model list, library, then each tab's setup.

import { $, store, state, api, on, emit, loadLibrary, toast } from "./util.js";
import { initGenerate } from "./generate.js";
import { initBatch } from "./batch.js";
import { initRate } from "./rate.js";
import { initAnalysis } from "./analysis-view.js";
import { loadGroups } from "./groups.js";
import { defaultPoolSet } from "../lib/defaults.js";

const TABS = ["generate", "batch", "rate", "analysis"];

function showTab(name) {
  if (!TABS.includes(name)) name = "generate";
  for (const t of TABS) $(`tab-${t}`).classList.toggle("hidden", t !== name);
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  store.set("tab", name);
  emit("tab-shown", name);
}
document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
on("tab", showTab);

async function start() {
  showTab(store.get("tab", "generate"));
  try {
    const body = await api("/api/models");
    state.models = (body.data || []).filter((m) => m.architecture?.output_modalities?.includes("image"));
    state.models.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    $("model").innerHTML = "<option>Failed to load</option>";
    $("error").textContent = "Could not load models: " + e.message;
  }
  await loadLibrary().catch((e) => toast("Could not load the image library: " + e.message, true));
  await loadGroups().catch((e) => {
    // Keep the app usable with an unsaved in-memory group.
    state.groups = { active: "default", groups: [{ id: "default", name: "Group 1", ...(store.get("batch:set", null) || defaultPoolSet()) }] };
    toast("Could not load groups (changes won't be saved): " + e.message, true);
  });
  initGenerate();
  initBatch();
  initRate();
  initAnalysis();
}
start();
