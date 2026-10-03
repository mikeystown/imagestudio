// Which prompt features predict high ratings. Records are image sidecars as returned by /api/library.
// All means and exports use the 1–7 score (see scoreOf), not the stored 0–6 value.

import { RATINGS, SOLID_SCORE, isRated, scoreOf } from "./ratings.js";

export const DEFAULT_MIN_SAMPLES = 5;

function summarize(scores) {
  const count = scores.length;
  const mean = count ? scores.reduce((s, v) => s + v, 0) / count : null;
  const solidShare = count ? scores.filter((v) => v >= SOLID_SCORE).length / count : null;
  return { count, mean, solidShare };
}

const byMeanDesc = (a, b) => (b.mean ?? -1) - (a.mean ?? -1) || b.count - a.count;

// Overall summary across rated images.
export function overallStats(records) {
  return summarize(records.filter(isRated).map(scoreOf));
}

// For each slot and option: count, mean rating, share >= Solid beautiful, and a low-sample flag.
// Only rated images that carry slot picks count.
export function slotStats(records, { minSamples = DEFAULT_MIN_SAMPLES } = {}) {
  const groups = {};
  for (const r of records) {
    if (!isRated(r) || !r.picks) continue;
    for (const [slot, option] of Object.entries(r.picks)) {
      ((groups[slot] ??= {})[option] ??= []).push(scoreOf(r));
    }
  }
  const out = {};
  for (const slot of Object.keys(groups).sort()) {
    out[slot] = Object.entries(groups[slot])
      .map(([option, scores]) => {
        const s = summarize(scores);
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
      return { model, ...summarize(recs.map(scoreOf)), tags };
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

// Flat per-image table with one column per slot. groupName maps a group id to its display name;
// bt maps a file to its Bradley-Terry { score, se, n } from all pairwise comparisons; compare maps a file to
// its place in the Compare tab's current set { rank, cluster, score, se, n } (ranked only within that set).
// starred(file) says whether an image is a starred key pick.
export function imagesCSV(records, { groupName = (id) => id, bt = new Map(), compare = new Map(), starred = () => false } = {}) {
  const slots = [...new Set(records.flatMap((r) => Object.keys(r.picks || {})))].sort();
  const header = [
    "file", "created_at", "model", "seed", "resolution", "aspect_ratio", "cost_usd",
    "rating_1_7", "rating_label", "tags", "notes", "starred", "kind", "group", "batch_id", "batch_name", "parent", "references", "template", "prompt",
    "bt_score", "bt_se", "n_comparisons",
    "compare_rank", "compare_cluster", "compare_score", "compare_se", "compare_n",
    ...slots.map((s) => `slot_${s}`),
  ];
  const rows = records.map((r) => [
    r.file, r.created_at, r.model, r.seed, r.resolution, r.aspect_ratio, r.cost,
    isRated(r) ? scoreOf(r) : "", isRated(r) ? RATINGS[r.rating.value] : "",
    (r.rating?.tags || []).join("; "), r.rating?.notes, starred(r.file), r.kind, r.group_id ? groupName(r.group_id) : "", r.batch_id, r.batch_name, r.parent, (r.references || []).join("; "), r.template, r.prompt,
    bt.get(r.file)?.score?.toFixed(4), bt.get(r.file)?.se?.toFixed(4), bt.get(r.file)?.n ?? 0,
    ...compareCells(compare.get(r.file)),
    ...slots.map((s) => r.picks?.[s]),
  ]);
  return toCSV(header, rows);
}

const compareCells = (c) => (c ? [c.rank, c.cluster, c.score?.toFixed(4), c.se?.toFixed(4), c.n] : ["", "", "", "", ""]);

// One row per pairwise pick, with both images described side by side (a_* and b_*), so head-to-heads can be
// analysed by group, rating, score or slot value. byFile maps a file to its library record.
export function comparisonsCSV(comps, { byFile, groupName = (id) => id, bt = new Map(), compare = new Map(), starred = () => false }) {
  const rows = comps.filter((c) => byFile.has(c.image_a) && byFile.has(c.image_b))
    .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
  const slots = [...new Set(rows.flatMap((c) => [c.image_a, c.image_b]).flatMap((f) => Object.keys(byFile.get(f).picks || {})))].sort();
  const sideHeader = (s) => [
    `${s}_file`, `${s}_position`, `${s}_group`, `${s}_run`, `${s}_model`, `${s}_seed`, `${s}_rating_1_7`, `${s}_rating_label`, `${s}_tags`, `${s}_starred`,
    `${s}_bt_score`, `${s}_compare_rank`, `${s}_compare_cluster`, `${s}_compare_score`, `${s}_references`, `${s}_prompt`,
    ...slots.map((x) => `${s}_slot_${x}`),
  ];
  const header = [
    "id", "created_at", "session_id", "is_repeat", "matchup", "cross_group", "result", "a_won", "winner_file", "winner_group",
    ...sideHeader("a"), ...sideHeader("b"),
  ];
  const side = (c, s) => {
    const r = byFile.get(s === "a" ? c.image_a : c.image_b);
    const cmp = compare.get(r.file);
    return [
      r.file, c.shown_left === s ? "left" : "right", groupName(r.group_id), r.batch_name || r.batch_id, r.model, r.seed,
      isRated(r) ? scoreOf(r) : "", isRated(r) ? RATINGS[r.rating.value] : "", (r.rating?.tags || []).join("; "), starred(r.file),
      bt.get(r.file)?.score?.toFixed(4), cmp?.rank, cmp?.cluster, cmp?.score?.toFixed(4), (r.references || []).join("; "), r.prompt,
      ...slots.map((x) => r.picks?.[x]),
    ];
  };
  const body = rows.map((c) => {
    const [a, b] = [byFile.get(c.image_a), byFile.get(c.image_b)];
    const winner = c.result === "a" ? a : c.result === "b" ? b : null;
    return [
      c.id, c.created_at, c.session_id, c.is_repeat,
      [groupName(a.group_id), groupName(b.group_id)].sort().join(" vs "), a.group_id !== b.group_id,
      c.result, c.result === "a" ? 1 : c.result === "b" ? 0 : 0.5, winner?.file ?? "tie", winner ? groupName(winner.group_id) : "tie",
      ...side(c, "a"), ...side(c, "b"),
    ];
  });
  return toCSV(header, body);
}
