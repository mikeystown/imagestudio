// Shared browser helpers and app state.

export const MAX_SEED = 2147483647;
export const DEFAULT_MODEL = "bytedance-seed/seedream-5-0-pro";

export const $ = (id) => document.getElementById(id);

export const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] % (MAX_SEED + 1);

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const fmtCost = (c) => (c == null ? "—" : `$${Number(c).toFixed(c < 1 ? 4 : 2)}`);
export const imgSrc = (file) => "/outputs/" + encodeURIComponent(file);

export async function api(url, { method = "GET", body } = {}) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || r.statusText), { status: r.status, data });
  return data;
}

// Tiny event bus between tabs.
const listeners = {};
export const on = (ev, fn) => (listeners[ev] ??= []).push(fn);
export const emit = (ev, data) => (listeners[ev] || []).forEach((fn) => fn(data));

// Shared state: model list and the image library (all sidecars in outputs/).
export const state = { models: [], library: [] };

export const modelName = (id) => state.models.find((m) => m.id === id)?.name || id;

const capsCache = new Map();
export function getCaps(model) {
  if (!capsCache.has(model)) {
    const p = api(`/api/capabilities/${model}`).catch((e) => {
      capsCache.delete(model);
      throw e;
    });
    capsCache.set(model, p);
  }
  return capsCache.get(model);
}

export async function loadLibrary() {
  state.library = (await api("/api/library")).records;
  emit("library");
}

export function addRecords(records) {
  state.library = [...records, ...state.library];
  emit("library");
}

export function download(name, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let toastTimer;
export function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("err", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 2500);
}

export const typingInField = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

// <option> list helper: values -> HTML, with one selected.
export const optionsHtml = (values, selected, { blank } = {}) =>
  (blank != null ? `<option value="">${escapeHtml(blank)}</option>` : "") +
  values.map((v) => `<option value="${escapeHtml(v)}" ${String(v) === String(selected) ? "selected" : ""}>${escapeHtml(v)}</option>`).join("");
