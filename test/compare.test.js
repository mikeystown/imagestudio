import { test } from "node:test";
import assert from "node:assert/strict";
import { fitBradleyTerry, choosePair, selfAgreement, progress, countComparisons, withinSet, pairKey, PHASE1_TARGET, sample, crossWinRate, components, rankWithinClusters, recordOf } from "../public/lib/compare.js";
import { imagesCSV, comparisonsCSV } from "../public/lib/analysis.js";

let nextId = 0;
const cmp = (a, b, result, extra = {}) => ({ id: String(nextId++), image_a: a, image_b: b, result, shown_left: "a", session_id: "s", created_at: new Date(1e12 + nextId * 1000).toISOString(), is_repeat: false, ...extra });
const times = (k, f) => Array.from({ length: k }, f);
// Seeded RNG so pairing tests are repeatable.
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ---------- Bradley-Terry ----------
test("BT orders a chain of wins and centres scores on zero", () => {
  const comps = [...times(3, () => cmp("A", "B", "a")), ...times(3, () => cmp("B", "C", "a"))];
  const s = fitBradleyTerry(["A", "B", "C"], comps);
  assert.ok(s.get("A").score > s.get("B").score && s.get("B").score > s.get("C").score);
  const sum = ["A", "B", "C"].reduce((t, f) => t + s.get(f).score, 0);
  assert.ok(Math.abs(sum) < 1e-9);
  assert.equal(s.get("B").n, 6);
});

test("BT keeps an undefeated image finite", () => {
  const s = fitBradleyTerry(["A", "B"], times(20, () => cmp("A", "B", "a")));
  assert.ok(Number.isFinite(s.get("A").score) && s.get("A").score > 1);
  assert.ok(Number.isFinite(s.get("A").se));
});

test("BT counts a tie as half a win to each image", () => {
  const s = fitBradleyTerry(["A", "B"], times(4, () => cmp("A", "B", "tie")));
  assert.ok(Math.abs(s.get("A").score - s.get("B").score) < 1e-9);
  // One win each plus two ties equals four ties.
  const mixed = fitBradleyTerry(["A", "B"], [cmp("A", "B", "a"), cmp("A", "B", "b"), cmp("A", "B", "tie"), cmp("A", "B", "tie")]);
  assert.ok(Math.abs(mixed.get("A").score - s.get("A").score) < 1e-9);
});

test("BT result does not depend on which image is image_a", () => {
  const s1 = fitBradleyTerry(["A", "B"], [cmp("A", "B", "a"), cmp("A", "B", "a"), cmp("A", "B", "b")]);
  const s2 = fitBradleyTerry(["A", "B"], [cmp("B", "A", "b"), cmp("B", "A", "b"), cmp("B", "A", "a")]);
  assert.ok(Math.abs(s1.get("A").score - s2.get("A").score) < 1e-9);
});

test("BT standard errors shrink with more comparisons", () => {
  const few = fitBradleyTerry(["A", "B"], [...times(3, () => cmp("A", "B", "a")), cmp("A", "B", "b")]);
  const many = fitBradleyTerry(["A", "B"], [...times(30, () => cmp("A", "B", "a")), ...times(10, () => cmp("A", "B", "b"))]);
  assert.ok(many.get("A").se < few.get("A").se / 2);
});

test("BT leaves uncompared images unscored and ignores comparisons outside the set", () => {
  const s = fitBradleyTerry(["A", "B", "C"], [cmp("A", "B", "a"), cmp("A", "Z", "a")]);
  assert.deepEqual(s.get("C"), { score: null, se: null, n: 0 });
  assert.equal(s.get("A").n, 1);
});

// ---------- pairing ----------
test("a new set spreads matchups evenly (linking, then phase 1) without repeating pairs", () => {
  const files = times(10, (_, i) => `f${i}`);
  const rng = seeded(7);
  const comps = [];
  let picks = 0;
  while (Math.min(...countComparisons(files, comps).values()) < PHASE1_TARGET) {
    const p = choosePair(files, comps, { rng, repeatRate: 0 });
    assert.ok(p.phase <= 1);
    assert.equal(p.is_repeat, false);
    assert.notEqual(p.a, p.b);
    comps.push(cmp(p.a, p.b, "a"));
    picks++;
  }
  const keys = comps.map((c) => pairKey(c.image_a, c.image_b));
  assert.equal(new Set(keys).size, keys.length, "no pair shown twice");
  assert.ok(picks <= 17, `phase 1 took ${picks} picks for 10 images`); // ideal is 15
  assert.ok(Math.max(...countComparisons(files, comps).values()) <= PHASE1_TARGET + 1);
});

test("phase 2 pairs an image with one of its three closest-scored unmet opponents", () => {
  const files = times(12, (_, i) => `f${i}`);
  // Ring: everyone has met ±1 and ±2 neighbours (4 comparisons each), so phase 2.
  const comps = [];
  for (let i = 0; i < 12; i++) for (const d of [1, 2]) comps.push(cmp(files[i], files[(i + d) % 12], "a"));
  const scores = new Map(files.map((f, i) => [f, { score: i * i * 0.1 }]));
  const rng = seeded(3);
  for (let t = 0; t < 200; t++) {
    const p = choosePair(files, comps, { scores, rng, repeatRate: 0 });
    assert.equal(p.phase, 2);
    const met = new Set(comps.filter((c) => c.image_a === p.a || c.image_b === p.a).flatMap((c) => [c.image_a, c.image_b]));
    assert.ok(!met.has(p.b), "opponent not met before");
    const unmet = files.filter((f) => f !== p.a && !met.has(f));
    const dist = (f) => Math.abs(scores.get(f).score - scores.get(p.a).score);
    const closest3 = [...unmet].sort((x, y) => dist(x) - dist(y)).slice(0, 3);
    assert.ok(closest3.includes(p.b));
  }
});

test("about 5% of picks re-show an already judged pair", () => {
  const files = times(30, (_, i) => `f${i}`);
  // A connected chain, so no linking phase.
  const comps = times(29, (_, i) => cmp(files[i], files[i + 1], "a"));
  const judged = new Set(comps.map((c) => pairKey(c.image_a, c.image_b)));
  const rng = seeded(11);
  let repeats = 0;
  for (let t = 0; t < 4000; t++) {
    const p = choosePair(files, comps, { rng });
    if (p.is_repeat) {
      repeats++;
      assert.ok(judged.has(pairKey(p.a, p.b)));
    }
  }
  assert.ok(repeats > 140 && repeats < 270, `${repeats} repeats in 4000`);
});

test("choosePair never offers the pair just shown, and handles tiny sets", () => {
  assert.equal(choosePair(["only"], []), null);
  const files = ["a", "b", "c"];
  const rng = seeded(5);
  for (let t = 0; t < 50; t++) assert.notEqual(pairKey(...Object.values(choosePair(files, [], { rng, lastKey: "a|b", repeatRate: 0 })).slice(0, 2)), "a|b");
  // Every pair judged: falls back to a marked repeat rather than failing.
  const all = [cmp("a", "b", "a"), cmp("a", "c", "a"), cmp("b", "c", "a")];
  const p = choosePair(files, all, { rng, repeatRate: 0 });
  assert.equal(p.is_repeat, true);
});

// ---------- consistency, progress, export ----------
test("selfAgreement compares each repeat with the first judgment of that pair", () => {
  const comps = [
    cmp("A", "B", "a"),
    cmp("C", "D", "tie"),
    cmp("E", "F", "b"),
    cmp("B", "A", "b", { is_repeat: true }), // A wins again (sides swapped): agree
    cmp("C", "D", "tie", { is_repeat: true }), // tie again: agree
    cmp("E", "F", "a", { is_repeat: true }), // flipped: disagree
  ];
  assert.deepEqual(selfAgreement(comps), { total: 3, agree: 2, rate: 2 / 3 });
  assert.deepEqual(selfAgreement([]), { total: 0, agree: 0, rate: null });
});

test("progress counts images at the target", () => {
  const comps = [...times(4, () => cmp("A", "B", "a"))];
  assert.deepEqual(progress(["A", "B", "C"], comps, 4), { images: 3, reached: 2, fraction: 8 / 12 });
  assert.equal(withinSet([cmp("A", "Z", "a"), cmp("A", "B", "a")], ["A", "B"]).length, 1);
});

test("imagesCSV carries bt_score, bt_se and n_comparisons next to the slot columns", () => {
  const bt = new Map([["x.jpg", { score: 0.5, se: 0.25, n: 7 }]]);
  const csv = imagesCSV([{ file: "x.jpg", picks: { eyes: "blue" } }, { file: "y.jpg", picks: { eyes: "green" } }], { bt });
  const [header, x, y] = csv.trim().split("\r\n").map((l) => l.split(","));
  const col = (row, name) => row[header.indexOf(name)];
  assert.ok(header.join().endsWith("bt_score,bt_se,n_comparisons,compare_rank,compare_cluster,compare_score,compare_se,compare_n,slot_eyes"));
  assert.deepEqual([col(x, "bt_score"), col(x, "bt_se"), col(x, "n_comparisons")], ["0.5000", "0.2500", "7"]);
  assert.deepEqual([col(y, "bt_score"), col(y, "n_comparisons")], ["", "0"]);
});

test("sample draws k distinct items, or all when there are fewer", () => {
  const items = times(20, (_, i) => `f${i}`);
  const s = sample(items, 12, seeded(9));
  assert.equal(s.length, 12);
  assert.equal(new Set(s).size, 12);
  assert.ok(s.every((x) => items.includes(x)));
  assert.equal(sample(["a", "b"], 5).length, 2);
  assert.deepEqual(items.slice(0, 3), ["f0", "f1", "f2"], "input not modified");
});

test("crossWinRate counts only A-vs-B matchups, either way round, ties half", () => {
  const A = new Set(["n1", "n2"]);
  const B = new Set(["o1", "o2"]);
  const comps = [
    cmp("n1", "o1", "a"), // A wins
    cmp("o2", "n2", "a"), // B wins (A is image_b)
    cmp("o1", "n2", "b"), // A wins
    cmp("n1", "o2", "tie"), // half
    cmp("n1", "n2", "a"), // A vs A: ignored
    cmp("o1", "o2", "b"), // B vs B: ignored
  ];
  assert.deepEqual(crossWinRate(comps, A, B), { n: 4, winsA: 2.5, rate: 2.5 / 4 });
  assert.deepEqual(crossWinRate([], A, B), { n: 0, winsA: 0, rate: null });
});

test("components finds clusters linked by comparisons", () => {
  const cs = components(["a", "b", "c", "d", "e"], [cmp("a", "b", "a"), cmp("b", "c", "tie"), cmp("d", "x", "a")]);
  assert.deepEqual(cs.map((c) => c.sort()), [["a", "b", "c"], ["d"], ["e"]]);
});

test("separate clusters (e.g. groups never compared) are linked before anything else", () => {
  // Two groups compared only internally, plus two never-compared images.
  const g3 = ["g3a", "g3b", "g3c"];
  const g4 = ["g4a", "g4b", "g4c"];
  const comps = [cmp("g3a", "g3b", "a"), cmp("g3b", "g3c", "a"), cmp("g4a", "g4b", "a"), cmp("g4b", "g4c", "b")];
  const files = [...g3, ...g4, "g1a", "g2a"];
  const rng = seeded(4);
  let picks = 0;
  while (components(files, comps).length > 1) {
    const p = choosePair(files, comps, { rng, repeatRate: 1 }); // repeats must not interrupt linking
    assert.equal(p.phase, 0);
    assert.equal(p.is_repeat, false);
    const before = components(files, comps).length;
    comps.push(cmp(p.a, p.b, "a"));
    assert.equal(components(files, comps).length, before - 1, "each linking pick joins two clusters");
    picks++;
  }
  assert.equal(picks, 3); // 4 clusters -> 3 links
  assert.notEqual(choosePair(files, comps, { rng, repeatRate: 0 }).phase, 0);
});

test("rankWithinClusters ranks each linked cluster separately and skips uncompared images", () => {
  const files = ["a", "b", "c", "x", "y", "lonely"];
  const comps = [cmp("a", "b", "a"), cmp("b", "c", "a"), cmp("x", "y", "b")];
  const ranks = rankWithinClusters(files, comps, fitBradleyTerry(files, comps));
  assert.deepEqual(ranks.get("a"), { rank: 1, cluster: 1, clusters: 2 });
  assert.deepEqual(ranks.get("c"), { rank: 3, cluster: 1, clusters: 2 });
  assert.deepEqual(ranks.get("y"), { rank: 1, cluster: 2, clusters: 2 });
  assert.equal(ranks.has("lonely"), false);
});

test("imagesCSV carries the Compare-set rank next to the global scores", () => {
  const compare = new Map([["x.jpg", { rank: 2, cluster: 1, score: 0.3, se: 0.4, n: 5 }]]);
  const [header, x, y] = imagesCSV([{ file: "x.jpg" }, { file: "y.jpg" }], { compare }).trim().split("\r\n").map((l) => l.split(","));
  const col = (row, name) => row[header.indexOf(name)];
  assert.deepEqual(["compare_rank", "compare_cluster", "compare_score", "compare_se", "compare_n"].map((h) => col(x, h)), ["2", "1", "0.3000", "0.4000", "5"]);
  assert.equal(col(y, "compare_rank"), "");
});

test("comparisonsCSV writes one row per pick with both images side by side", () => {
  const byFile = new Map([
    ["g3.jpg", { file: "g3.jpg", group_id: "g3", batch_name: "run A", model: "m", seed: 1, prompt: "p, one", rating: { value: 6, tags: ["Eyes"] }, picks: { eyes: "blue" } }],
    ["g4.jpg", { file: "g4.jpg", group_id: "g4", batch_id: "b2", model: "m", seed: 2, prompt: "p2", rating: { value: 5, tags: [] }, picks: { eyes: "green", hair: "dark" } }],
    ["g4b.jpg", { file: "g4b.jpg", group_id: "g4", model: "m", picks: {} }],
  ]);
  const comps = [
    cmp("g4.jpg", "g3.jpg", "b", { shown_left: "b", created_at: "2026-10-04T10:00:00Z", id: "c1" }), // g3 (right side b... shown left) wins
    cmp("g4.jpg", "g4b.jpg", "tie", { created_at: "2026-10-04T09:00:00Z", id: "c0" }),
    cmp("g3.jpg", "gone.jpg", "a", { id: "c2" }), // unknown image: skipped
  ];
  const names = { g3: "Group 3", g4: "Group 4" };
  const csv = comparisonsCSV(comps, { byFile, groupName: (id) => names[id], compare: new Map([["g3.jpg", { rank: 1, cluster: 1, score: 0.5 }]]) });
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 3, "header + 2 picks, oldest first");
  const parse = (l) => { const out = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
  const header = parse(lines[0]);
  const row = (i) => Object.fromEntries(parse(lines[i]).map((v, j) => [header[j], v]));
  const tie = row(1), cross = row(2);
  assert.equal(tie.id, "c0");
  assert.equal(tie.matchup, "Group 4 vs Group 4");
  assert.equal(tie.cross_group, "false");
  assert.equal(tie.a_won, "0.5");
  assert.equal(tie.winner_group, "tie");
  assert.equal(cross.matchup, "Group 3 vs Group 4");
  assert.equal(cross.cross_group, "true");
  assert.equal(cross.result, "b");
  assert.equal(cross.a_won, "0");
  assert.equal(cross.winner_file, "g3.jpg");
  assert.equal(cross.winner_group, "Group 3");
  assert.equal(cross.a_position, "right");
  assert.equal(cross.b_position, "left");
  assert.equal(cross.b_rating_1_7, "7");
  assert.equal(cross.b_rating_label, "Stunning");
  assert.equal(cross.b_run, "run A");
  assert.equal(cross.a_run, "b2");
  assert.equal(cross.b_compare_rank, "1");
  assert.equal(cross.b_prompt, "p, one");
  assert.equal(cross.a_slot_eyes, "green");
  assert.equal(cross.b_slot_eyes, "blue");
  assert.equal(cross.b_slot_hair, "");
});

test("recordOf counts an image's wins, losses and ties from either side", () => {
  const comps = [cmp("A", "B", "a"), cmp("C", "A", "a"), cmp("A", "D", "tie"), cmp("B", "A", "a"), cmp("B", "C", "a")];
  assert.deepEqual(recordOf("A", comps), { wins: 1, losses: 2, ties: 1 });
  assert.deepEqual(recordOf("Z", comps), { wins: 0, losses: 0, ties: 0 });
});

test("exports mark starred images", () => {
  const starred = (f) => f === "x.jpg";
  const [h, x, y] = imagesCSV([{ file: "x.jpg" }, { file: "y.jpg" }], { starred }).trim().split("\r\n").map((l) => l.split(","));
  assert.equal(x[h.indexOf("starred")], "true");
  assert.equal(y[h.indexOf("starred")], "false");
  const byFile = new Map([["x.jpg", { file: "x.jpg", group_id: "g" }], ["y.jpg", { file: "y.jpg", group_id: "g" }]]);
  const [ch, row] = comparisonsCSV([cmp("y.jpg", "x.jpg", "a")], { byFile, starred }).trim().split("\r\n").map((l) => l.split(","));
  assert.equal(row[ch.indexOf("a_starred")], "false");
  assert.equal(row[ch.indexOf("b_starred")], "true");
});

test("exports list the reference images each image was made from", () => {
  const recs = [{ file: "x.jpg", references: ["ref1.jpg", "upload-2.png"] }, { file: "y.jpg" }];
  const [h, x, y] = imagesCSV(recs).trim().split("\r\n").map((l) => l.split(","));
  assert.equal(x[h.indexOf("references")], "ref1.jpg; upload-2.png");
  assert.equal(y[h.indexOf("references")], "");
  const byFile = new Map(recs.map((r) => [r.file, { ...r, group_id: "g" }]));
  const [ch, row] = comparisonsCSV([cmp("x.jpg", "y.jpg", "a")], { byFile }).trim().split("\r\n").map((l) => l.split(","));
  assert.equal(row[ch.indexOf("a_references")], "ref1.jpg; upload-2.png");
});
