// Groups: a template + pools + locks, plus every image generated while the group was active.
// Stored on the server in data/groups.json; images carry the group id in their sidecar.
// Each group keeps its own versions and is always on one (current); the group's top-level fields are the live
// copy of that version. A version is either text only or with reference images (kind, fixed at creation) and
// has its own template, pools, locks, run settings and, for reference versions, reference images.

import { $, store, state, api, emit, toast, escapeHtml } from "./util.js";
import { defaultPoolSet } from "../lib/defaults.js";
import { findSlots } from "../lib/template.js";

export const groupList = () => state.groups?.groups || [];
// Until groups load, a saved group filter can't be checked, so it must not be discarded.
export const isKnownGroup = (id) => !state.groups || groupList().some((g) => g.id === id);
export const activeGroup = () => groupList().find((g) => g.id === state.groups.active) || groupList()[0];
export const groupName = (id) => groupList().find((g) => g.id === id)?.name || id;

// Run settings saved with each version (concurrency stays a global preference).
export const SETTING_KEYS = ["models", "perModel", "resolution", "aspect_ratio", "seedMode", "seed"];
export const pickSettings = (cfg) => structuredClone(Object.fromEntries(SETTING_KEYS.filter((k) => k in cfg).map((k) => [k, cfg[k]])));

// The part of a group that a version holds.
export const versionFields = (x) =>
  structuredClone({
    kind: x.kind === "reference" ? "reference" : "text",
    template: x.template ?? "", pools: x.pools || {}, locks: x.locks || {}, settings: x.settings ?? null, refs: x.refs || [],
  });

// Versions from before version types held a text template plus an optional reference template, with reference
// mode and images on the group. Split each into a text version and, if it had a reference template, a
// separate reference version carrying the group's references.
function splitOldVersions(g) {
  const out = [];
  let current = g.current;
  for (const v of g.versions) {
    if (v.kind) {
      out.push(v);
      continue;
    }
    const { refTemplate, ...rest } = v;
    // Each half keeps the pools its own template uses (the text half also keeps any extra pools).
    const refSlots = new Set(findSlots(refTemplate ?? ""));
    const textSlots = new Set(findSlots(rest.template ?? ""));
    const poolsFor = (keep) => Object.fromEntries(Object.entries(rest.pools || {}).filter(([slot]) => keep(slot)));
    out.push({ ...rest, kind: "text", refs: [], pools: poolsFor((slot) => textSlots.has(slot) || !refSlots.has(slot)) });
    if (refTemplate != null) {
      const ref = {
        ...structuredClone(rest), id: `${v.id}-refs`, name: `${v.name} (with refs)`, kind: "reference",
        template: refTemplate, pools: structuredClone(poolsFor((slot) => refSlots.has(slot))), refs: [...(g.refs || [])],
      };
      out.push(ref);
      if (v.id === g.current && g.refMode) current = ref.id;
    }
  }
  g.versions = out;
  g.current = out.some((v) => v.id === current) ? current : out[0].id;
  delete g.refMode;
  delete g.refTemplate;
}

// Sets saved before versions existed (data/pool-sets), as version contents.
async function savedSets() {
  const out = [];
  for (const v of (await api("/api/pool-sets")).versions || []) {
    try {
      out.push({ name: v.name, created_at: v.created_at, ...versionFields(await api(`/api/pool-sets/${encodeURIComponent(v.name)}`)) });
    } catch (e) {
      console.warn(`Skipping saved set ${v.name}: ${e.message}`);
    }
  }
  return out;
}

export async function loadGroups() {
  state.groups = await api("/api/groups");
  let changed = false;
  let sets = null;
  for (const g of state.groups.groups) {
    // First run with groups: the existing group takes over the template/pools the Batch tab was using.
    if (g.template == null) {
      Object.assign(g, store.get("batch:set", null) || defaultPoolSet());
      changed = true;
    }
    // First run with versions: the group's current state becomes v1; earlier saved sets become versions too.
    if (!g.versions?.length) {
      sets ??= await savedSets().catch(() => []);
      g.versions = [
        { id: "v1", name: "v1", created_at: g.created_at || new Date().toISOString(), ...structuredClone({ template: g.template, refTemplate: g.refTemplate ?? null, pools: g.pools, locks: g.locks || {} }) },
        ...sets.map((x, i) => ({ id: `set-${i + 1}`, ...structuredClone(x), kind: "text" })),
      ];
      g.current = "v1";
      changed = true;
    }
  }
  // First run with per-version settings: every version starts with the settings the Batch tab was using.
  const legacy = pickSettings(store.get("batch:cfg", {}));
  for (const g of state.groups.groups) {
    for (const v of g.versions) {
      if (v.settings == null) {
        v.settings = structuredClone(legacy);
        changed = true;
      }
    }
    if (g.versions.some((v) => !v.kind)) {
      splitOldVersions(g);
      changed = true;
    }
    if (!g.versions.some((v) => v.id === g.current)) {
      g.current = g.versions[0].id;
      changed = true;
    }
    // The group's live fields are its current version.
    Object.assign(g, versionFields(g.versions.find((v) => v.id === g.current)));
  }
  if (changed) await saveGroupsNow();
}

let saveTimer;
// Debounced save, for edits made while typing.
export function saveGroups() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveGroupsNow, 400);
}

export async function saveGroupsNow() {
  clearTimeout(saveTimer);
  try {
    await api("/api/groups", { method: "PUT", body: state.groups });
  } catch (e) {
    toast("Could not save groups: " + e.message, true);
  }
}

// New group starting from a copy of the active group's template, pools and locks.
export function createGroup() {
  const from = activeGroup();
  const used = new Set(groupList().map((g) => g.name));
  let n = groupList().length + 1;
  while (used.has(`Group ${n}`)) n++;
  const g = {
    id: `g-${Date.now().toString(36)}`,
    name: `Group ${n}`,
    created_at: new Date().toISOString(),
    ...versionFields(from),
  };
  // The new group starts with one version: a copy of what the previous group was on.
  g.versions = [{ id: "v1", name: "v1", created_at: g.created_at, ...versionFields(from) }];
  g.current = "v1";
  state.groups.groups.push(g);
  state.groups.active = g.id;
  saveGroupsNow();
  emit("groups");
  return g;
}

export function switchGroup(id) {
  if (!groupList().some((g) => g.id === id)) return;
  state.groups.active = id;
  saveGroupsNow();
  emit("groups");
}

export function renameGroup(id, name) {
  const g = groupList().find((x) => x.id === id);
  name = name.trim().slice(0, 80);
  if (!g || !name || g.name === name) return false;
  g.name = name;
  saveGroupsNow();
  emit("groups");
  return true;
}

// Dropdown of group checkboxes; none ticked means all groups. Markup: <details id> with <summary id="…Label">
// and <div id="…Menu">. get() returns the ticked ids; set(ids) is called with the new list after each change.
export function groupPicker(id, { get, set }) {
  const root = $(id);
  const menu = $(`${id}Menu`);
  menu.addEventListener("change", (e) => {
    const box = e.target;
    let ids = [];
    if (box.dataset.all === undefined) {
      const chosen = new Set(get());
      if (box.checked) chosen.add(box.value);
      else chosen.delete(box.value);
      ids = groupList().map((g) => g.id).filter((g) => chosen.has(g)); // keep group order
    }
    set(ids);
  });
  document.addEventListener("click", (e) => {
    if (root.open && !root.contains(e.target)) root.open = false;
  });
  return {
    // Drop ids of deleted groups (only once groups have loaded) and redraw. Returns the cleaned list.
    render() {
      const ids = get().filter((g) => isKnownGroup(g));
      menu.innerHTML =
        `<label class="check"><input type="checkbox" data-all ${ids.length ? "" : "checked"}> All groups</label>` +
        groupList().map((g) => `<label class="check"><input type="checkbox" value="${escapeHtml(g.id)}" ${ids.includes(g.id) ? "checked" : ""}> ${escapeHtml(g.name)}</label>`).join("");
      $(`${id}Label`).textContent = ids.length ? ids.map(groupName).join(" + ") : "All groups";
      return ids;
    },
  };
}
