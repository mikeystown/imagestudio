// Groups: a template + pools + locks, plus every image generated while the group was active.
// Stored on the server in data/groups.json; images carry the group id in their sidecar.

import { $, store, state, api, emit, toast, escapeHtml } from "./util.js";
import { defaultPoolSet } from "../lib/defaults.js";

export const groupList = () => state.groups?.groups || [];
// Until groups load, a saved group filter can't be checked, so it must not be discarded.
export const isKnownGroup = (id) => !state.groups || groupList().some((g) => g.id === id);
export const activeGroup = () => groupList().find((g) => g.id === state.groups.active) || groupList()[0];
export const groupName = (id) => groupList().find((g) => g.id === id)?.name || id;

export async function loadGroups() {
  state.groups = await api("/api/groups");
  // First run with groups: the existing group takes over the template/pools the Batch tab was using.
  let changed = false;
  for (const g of state.groups.groups) {
    if (g.template == null) {
      Object.assign(g, store.get("batch:set", null) || defaultPoolSet());
      changed = true;
    }
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
    template: from.template,
    pools: structuredClone(from.pools),
    locks: structuredClone(from.locks || {}),
    refMode: !!from.refMode,
    refTemplate: from.refTemplate,
    refs: [...(from.refs || [])],
  };
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
