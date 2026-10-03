import { test } from "node:test";
import assert from "node:assert/strict";
import { fitBradleyTerry, choosePair, selfAgreement, progress, countComparisons, withinSet, pairKey, comparisonsCSV, PHASE1_TARGET } from "../public/lib/compare.js";
import { imagesCSV } from "../public/lib/analysis.js";

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
test("phase 1 spreads matchups evenly without repeating pairs", () => {
  const files = times(10, (_, i) => `f${i}`);
  const rng = seeded(7);
  const comps = [];
  let picks = 0;
  while (Math.min(...countComparisons(files, comps).values()) < PHASE1_TARGET) {
    const p = choosePair(files, comps, { rng, repeatRate: 0 });
    assert.equal(p.phase, 1);
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
  const comps = [cmp("f0", "f1", "a"), cmp("f2", "f3", "b")];
  const rng = seeded(11);
  let repeats = 0;
  for (let t = 0; t < 4000; t++) {
    const p = choosePair(files, comps, { rng });
    if (p.is_repeat) {
      repeats++;
      assert.ok(["f0|f1", "f2|f3"].includes(pairKey(p.a, p.b)));
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

test("comparisonsCSV writes winner and left/right images", () => {
  const csv = comparisonsCSV([cmp("A", "B", "b", { shown_left: "b", id: "x1", created_at: "t" })]);
  const [header, row] = csv.trim().split("\r\n");
  assert.equal(header, "id,created_at,session_id,image_a,image_b,result,winner,shown_left,left_image,right_image,is_repeat");
  assert.equal(row, "x1,t,s,A,B,b,B,b,B,A,false");
});

test("imagesCSV carries bt_score, bt_se and n_comparisons next to the slot columns", () => {
  const bt = new Map([["x.jpg", { score: 0.5, se: 0.25, n: 7 }]]);
  const csv = imagesCSV([{ file: "x.jpg", picks: { eyes: "blue" } }, { file: "y.jpg", picks: { eyes: "green" } }], { bt });
  const [header, x, y] = csv.trim().split("\r\n").map((l) => l.split(","));
  const col = (row, name) => row[header.indexOf(name)];
  assert.ok(header.join().endsWith("bt_score,bt_se,n_comparisons,slot_eyes"));
  assert.deepEqual([col(x, "bt_score"), col(x, "bt_se"), col(x, "n_comparisons")], ["0.5000", "0.2500", "7"]);
  assert.deepEqual([col(y, "bt_score"), col(y, "n_comparisons")], ["", "0"]);
});
