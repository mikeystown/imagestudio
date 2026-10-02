// Prompt templates with {slot} placeholders, filled from weighted option pools.
// Pure functions: used by the browser and by the Node tests.

const SLOT_RE = /\{([A-Za-z_][\w-]*)\}/g;

// Unique slot names in order of first appearance.
export function findSlots(template) {
  return [...new Set([...String(template).matchAll(SLOT_RE)].map((m) => m[1]))];
}

// Pools may hold plain strings or {value, weight}; normalise to the object form.
export function normalizeOptions(options) {
  return (options || [])
    .map((o) => (typeof o === "string" ? { value: o, weight: 1 } : { value: String(o?.value ?? ""), weight: o?.weight ?? 1 }))
    .map((o) => ({ value: o.value.trim(), weight: Number.isFinite(Number(o.weight)) ? Number(o.weight) : 1 }))
    .filter((o) => o.value !== "");
}

// Weighted random choice. Options with weight <= 0 are never picked. Returns null if nothing is pickable.
export function pickOption(options, rng = Math.random) {
  const usable = normalizeOptions(options).filter((o) => o.weight > 0);
  const total = usable.reduce((s, o) => s + o.weight, 0);
  if (!total) return null;
  let r = rng() * total;
  for (const o of usable) {
    if ((r -= o.weight) < 0) return o.value;
  }
  return usable[usable.length - 1].value; // guards against floating-point leftovers
}

// Replace each {slot} with picks[slot]; slots without a pick are left as-is.
export function fillTemplate(template, picks) {
  return String(template).replace(SLOT_RE, (whole, name) => (picks[name] != null ? picks[name] : whole));
}

// One pick per slot: a locked value wins, otherwise a weighted random option from the pool.
// `missing` lists slots that have neither a lock nor a pickable option.
export function buildPrompt(template, pools = {}, locks = {}, rng = Math.random) {
  const picks = {};
  const missing = [];
  for (const slot of findSlots(template)) {
    const locked = locks[slot];
    const value = locked != null && locked !== "" ? locked : pickOption(pools[slot], rng);
    if (value == null) missing.push(slot);
    else picks[slot] = value;
  }
  return { prompt: fillTemplate(template, picks), picks, missing };
}
