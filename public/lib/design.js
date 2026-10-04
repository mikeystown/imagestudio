// Batch design: which slot values each image gets, planned up front instead of drawn at random.
// Per model, every combination of slot options is used in turn: as many full rounds as fit, then the first
// combinations in order for the remainder (6 combinations: 3 images -> first 3, 9 -> all 6 + first 3,
// 12 -> all 6 twice). The generation order is then shuffled by a seed, so the plan can be reproduced.
// Pure functions: used by the browser and by the Node tests.

import { findSlots, normalizeOptions, fillTemplate } from "./template.js";

// Small seeded RNG (mulberry32): same seed, same sequence.
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates on a copy.
export function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The template's slots split into locked ones (fixed) and the ones that vary, each with its usable options
// (weight 0 leaves an option out; other weights don't matter here). `missing` lists slots with neither.
export function designSlots(template, pools = {}, locks = {}) {
  const fixed = {};
  const slots = [];
  const missing = [];
  for (const name of findSlots(template)) {
    const locked = locks[name];
    if (locked != null && locked !== "") {
      fixed[name] = locked;
      continue;
    }
    const options = [...new Set(normalizeOptions(pools[name]).filter((o) => o.weight > 0).map((o) => o.value))];
    if (options.length) slots.push({ name, options });
    else missing.push(name);
  }
  return { slots, fixed, missing };
}

// Every combination of the varying slots, first slot outermost: [{slot: value}, ...]. No slots -> [{}].
export function combinations(slots) {
  let out = [{}];
  for (const { name, options } of slots) out = out.flatMap((c) => options.map((v) => ({ ...c, [name]: v })));
  return out;
}

// The plan for a batch. rows are in generation order: { index, model, cell, picks, prompt }, where cell is the
// combination's number (its place in combinations()) and picks include the locked slots.
export function planBatch({ template, pools = {}, locks = {}, models, perModel, seed }) {
  const { slots, fixed, missing } = designSlots(template, pools, locks);
  const combos = combinations(slots);
  const rows = [];
  for (const model of models) {
    for (let i = 0; i < perModel; i++) {
      const cell = i % combos.length;
      const picks = { ...fixed, ...combos[cell] };
      rows.push({ model, cell, picks, prompt: fillTemplate(template, picks) });
    }
  }
  return {
    seed,
    template,
    slots,
    fixed,
    missing,
    combinations: combos.length,
    perModel,
    models: [...models],
    rows: shuffle(rows, seededRng(seed)).map((r, index) => ({ index, ...r })),
  };
}

// Counts per option for each varying slot, and per combination: { slots: {slot: {value: n}}, cells: [n, ...] }.
export function countPlan(plan, rows = plan.rows) {
  const slots = Object.fromEntries(plan.slots.map((s) => [s.name, Object.fromEntries(s.options.map((v) => [v, 0]))]));
  const cells = Array(plan.combinations).fill(0);
  for (const r of rows) {
    cells[r.cell]++;
    for (const s of plan.slots) slots[s.name][r.picks[s.name]]++;
  }
  return { slots, cells };
}

// In words, per model: how many full rounds of the combinations fit, and what's left over.
export function describePlan({ combinations: n, perModel }) {
  const rounds = Math.floor(perModel / n);
  const rest = perModel % n;
  if (n === 1) return "No slots vary: every image uses the same prompt.";
  if (!rounds) return `${n} combinations, ${perModel} per model: only the first ${perModel} are used.`;
  const full = `${rounds === 1 ? "every combination once" : `every combination ${rounds} times`}`;
  return `${n} combinations, ${perModel} per model: ${full}${rest ? `, then the first ${rest}` : ""}.`;
}

// Runs jobs with up to `concurrency` at a time. A failed job goes to the back of the queue with the same
// assignment and is tried again, up to maxAttempts tries in all, so failures don't unbalance the batch.
// work(job, attempt) does one try; it should throw on failure. Once stopped() is true no new tries start.
// Returns one { job, status: "done" | "failed" | "skipped", attempts, error } per job, in the jobs' order.
export async function runQueue(jobs, work, { concurrency = 1, maxAttempts = 3, stopped = () => false, onTry } = {}) {
  const results = jobs.map((job) => ({ job, status: "skipped", attempts: 0, error: null }));
  const queue = [...results];
  const worker = async () => {
    // The worker that puts a failed job back stays in this loop, so the retry is never stranded.
    while (queue.length && !stopped()) {
      const item = queue.shift();
      item.attempts++;
      try {
        const value = await work(item.job, item.attempts);
        item.status = "done";
        item.error = null;
        onTry?.(item, value);
      } catch (e) {
        item.error = e;
        const retry = item.attempts < maxAttempts;
        item.status = retry ? "skipped" : "failed"; // "skipped" until it's tried again
        if (retry) queue.push(item);
        onTry?.(item, undefined, retry);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return results;
}
