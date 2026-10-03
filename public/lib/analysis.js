// Which prompt features predict high ratings. Records are image sidecars as returned by /api/library.

import { RATINGS, SOLID, isRated } from "./ratings.js";

export const DEFAULT_MIN_SAMPLES = 5;

function summarize(values) {
  const count = values.length;
  const mean = count ? values.reduce((s, v) => s + v, 0) / count : null;
  const solidShare = count ? values.filter((v) => v >= SOLID).length / count : null;
  return { count, mean, solidShare };
}

const byMeanDesc = (a, b) => (b.mean ?? -1) - (a.mean ?? -1) || b.count - a.count;

// Overall summary across rated images.
export function overallStats(records) {
  return summarize(records.filter(isRated).map((r) => r.rating.value));
}

// For each slot and option: count, mean rating, share >= Solid beautiful, and a low-sample flag.
// Only rated images that carry slot picks count.
export function slotStats(records, { minSamples = DEFAULT_MIN_SAMPLES } = {}) {
  const groups = {};
  for (const r of records) {
    if (!isRated(r) || !r.picks) continue;
    for (const [slot, option] of Object.entries(r.picks)) {
      ((groups[slot] ??= {})[option] ??= []).push(r.rating.value);
    }
  }
  const out = {};
  for (const slot of Object.keys(groups).sort()) {
    out[slot] = Object.entries(groups[slot])
      .map(([option, values]) => {
        const s = summarize(values);
        return { option, ...s, lowSample: s.count < minSamples };
      })
      .sort(byMeanDesc);
  }
  return out;
}

// Per model: rating summary and the most common limiting-factor tags among its rated images.
export function modelStats(records, { topTags = 5 } = {}) {
  const groups = {};
  for (const r of records) if (isRated(r)) (groups[r.model] ??= []).push(r);
  return Object.entries(groups)
    .map(([model, recs]) => {
      const tagCounts = {};
      for (const r of recs) for (const t of r.rating.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
      const tags = Object.entries(tagCounts)
        .map(([tag, count]) => ({ tag, count, share: count / recs.length }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        .slice(0, topTags);
      return { model, ...summarize(recs.map((r) => r.rating.value)), tags };
    })
    .sort(byMeanDesc);
}

// One entry per batch run, newest first: id, optional name, image/rated counts and models used.
export function listBatches(records) {
  const groups = {};
  for (const r of records) if (r.batch_id) (groups[r.batch_id] ??= []).push(r);
  return Object.entries(groups)
    .map(([id, recs]) => ({
      id,
      name: recs.find((r) => r.batch_name)?.batch_name || null,
      count: recs.length,
      rated: recs.filter(isRated).length,
      models: [...new Set(recs.map((r) => r.model))].sort(),
    }))
    .sort((a, b) => b.id.localeCompare(a.id)); // ids are ISO timestamps
}

// ---------- export ----------

export function csvCell(v) {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(header, rows) {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// Flat per-image table with one column per slot.
export function imagesCSV(records) {
  const slots = [...new Set(records.flatMap((r) => Object.keys(r.picks || {})))].sort();
  const header = [
    "file", "created_at", "model", "seed", "resolution", "aspect_ratio", "cost_usd",
    "rating", "rating_label", "tags", "notes", "kind", "batch_id", "batch_name", "parent", "template", "prompt",
    ...slots.map((s) => `slot_${s}`),
  ];
  const rows = records.map((r) => [
    r.file, r.created_at, r.model, r.seed, r.resolution, r.aspect_ratio, r.cost,
    isRated(r) ? r.rating.value : "", isRated(r) ? RATINGS[r.rating.value] : "",
    (r.rating?.tags || []).join("; "), r.rating?.notes, r.kind, r.batch_id, r.batch_name, r.parent, r.template, r.prompt,
    ...slots.map((s) => r.picks?.[s]),
  ]);
  return toCSV(header, rows);
}

export function slotStatsCSV(stats) {
  const rows = Object.entries(stats).flatMap(([slot, opts]) =>
    opts.map((o) => [slot, o.option, o.count, o.mean?.toFixed(3), o.solidShare?.toFixed(3), o.lowSample]),
  );
  return toCSV(["slot", "option", "count", "mean_rating", "share_solid_or_above", "low_sample"], rows);
}

export function toJSONL(items) {
  return items.map((x) => JSON.stringify(x)).join("\n") + (items.length ? "\n" : "");
}
