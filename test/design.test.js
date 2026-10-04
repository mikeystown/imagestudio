import { test } from "node:test";
import assert from "node:assert/strict";
import { seededRng, designSlots, combinations, planBatch, countPlan, describePlan, runQueue } from "../public/lib/design.js";

const pool = (...values) => values.map((value) => ({ value, weight: 1 }));
const T32 = "{a} {b}";
const P32 = { a: pool("a1", "a2", "a3"), b: pool("b1", "b2") };
const plan32 = (perModel, seed = 1) => planBatch({ template: T32, pools: P32, models: ["m"], perModel, seed });
const sortedCells = (plan) => [...plan.rows].sort((x, y) => x.index - y.index).map((r) => r.cell);

test("combinations lists every combination, first slot outermost", () => {
  const { slots } = designSlots(T32, P32);
  assert.deepEqual(combinations(slots), [
    { a: "a1", b: "b1" }, { a: "a1", b: "b2" }, { a: "a2", b: "b1" }, { a: "a2", b: "b2" }, { a: "a3", b: "b1" }, { a: "a3", b: "b2" },
  ]);
  assert.deepEqual(combinations([]), [{}]);
});

test("designSlots leaves out locked slots and weight-0 options, and reports empty pools", () => {
  const pools = { a: [{ value: "x", weight: 0 }, { value: "y", weight: 3 }, "z"], b: pool("b1"), c: [] };
  const d = designSlots("{a} {b} {c}", pools, { b: "locked" });
  assert.deepEqual(d.slots, [{ name: "a", options: ["y", "z"] }]);
  assert.deepEqual(d.fixed, { b: "locked" });
  assert.deepEqual(d.missing, ["c"]);
});

test("60 images, 3x2 slots: every combination exactly 10 times", () => {
  const p = plan32(60);
  const { slots, cells } = countPlan(p);
  assert.deepEqual(cells, [10, 10, 10, 10, 10, 10]);
  assert.deepEqual(slots, { a: { a1: 20, a2: 20, a3: 20 }, b: { b1: 30, b2: 30 } });
  for (const r of p.rows) assert.equal(r.prompt, `${r.picks.a} ${r.picks.b}`);
});

test("64 images, 3x2 slots: 10 full rounds, then the first 4 combinations", () => {
  const p = plan32(64);
  const { slots, cells } = countPlan(p);
  assert.deepEqual(cells, [11, 11, 11, 11, 10, 10]);
  assert.deepEqual(slots, { a: { a1: 22, a2: 22, a3: 20 }, b: { b1: 32, b2: 32 } });
  assert.equal(describePlan(p), "6 combinations, 64 per model: every combination 10 times, then the first 4.");
});

test("9 images of 6 combinations: all 6, then the first 3; 12: all 6 twice", () => {
  assert.deepEqual(countPlan(plan32(9)).cells, [2, 2, 2, 1, 1, 1]);
  assert.deepEqual(countPlan(plan32(12)).cells, [2, 2, 2, 2, 2, 2]);
});

test("fewer images than combinations: only the first ones are used", () => {
  const p = plan32(3);
  assert.deepEqual(countPlan(p).cells, [1, 1, 1, 0, 0, 0]);
  assert.equal(describePlan(p), "6 combinations, 3 per model: only the first 3 are used.");
});

test("108 images, 3x3x3x3 slots: all 81 combinations once, then the first 27 again", () => {
  const opts = (s) => pool(`${s}1`, `${s}2`, `${s}3`);
  const p = planBatch({ template: "{a}{b}{c}{d}", pools: { a: opts("a"), b: opts("b"), c: opts("c"), d: opts("d") }, models: ["m"], perModel: 108, seed: 7 });
  assert.equal(p.combinations, 81);
  const { cells, slots } = countPlan(p);
  assert.deepEqual(cells, [...Array(27).fill(2), ...Array(54).fill(1)]);
  // The first 27 combinations all have a = a1; the other slots stay balanced.
  assert.deepEqual(slots.a, { a1: 54, a2: 27, a3: 27 });
  for (const s of ["b", "c", "d"]) assert.deepEqual(Object.values(slots[s]), [36, 36, 36]);
});

test("a single slot cycles through its options", () => {
  const p = planBatch({ template: "a {x}", pools: { x: pool("p", "q", "r") }, models: ["m"], perModel: 7, seed: 3 });
  assert.deepEqual(countPlan(p).slots, { x: { p: 3, q: 2, r: 2 } });
});

test("no varying slots: every image gets the same prompt", () => {
  const p = planBatch({ template: "{a}", pools: P32, locks: { a: "fixed" }, models: ["m"], perModel: 4, seed: 1 });
  assert.equal(p.combinations, 1);
  assert.ok(p.rows.every((r) => r.prompt === "fixed" && r.cell === 0));
  assert.equal(describePlan(p), "No slots vary: every image uses the same prompt.");
});

test("each model gets the whole design", () => {
  const p = planBatch({ template: T32, pools: P32, models: ["m1", "m2"], perModel: 8, seed: 5 });
  assert.equal(p.rows.length, 16);
  for (const m of ["m1", "m2"]) assert.deepEqual(countPlan(p, p.rows.filter((r) => r.model === m)).cells, [2, 2, 1, 1, 1, 1]);
});

test("the same seed gives the same plan; the order is shuffled, not in blocks", () => {
  assert.deepEqual(plan32(64, 42), plan32(64, 42));
  assert.notDeepEqual(sortedCells(plan32(64, 42)), sortedCells(plan32(64, 43)));
  const cells = sortedCells(plan32(60, 42));
  assert.notDeepEqual(cells, [...cells].sort((x, y) => x - y));
  assert.deepEqual(plan32(60, 42).rows.map((r) => r.index), [...Array(60).keys()]);
});

test("seededRng is deterministic and in [0, 1)", () => {
  const a = seededRng(9), b = seededRng(9);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test("runQueue retries failed jobs with the same assignment until the batch is complete", async () => {
  const p = plan32(60, 11);
  const failsLeft = new Map(p.rows.filter((r) => r.index % 4 === 0).map((r) => [r.index, r.index % 8 === 0 ? 2 : 1]));
  const generated = [];
  const tries = [];
  const results = await runQueue(p.rows, async (row, attempt) => {
    tries.push({ index: row.index, attempt });
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    if (failsLeft.get(row.index) > 0) {
      failsLeft.set(row.index, failsLeft.get(row.index) - 1);
      throw new Error("boom");
    }
    generated.push(row);
  }, { concurrency: 4, maxAttempts: 3 });

  assert.ok(results.every((r) => r.status === "done"));
  assert.equal(generated.length, 60);
  assert.deepEqual(countPlan(p, generated), countPlan(p)); // still exactly 10 of each combination
  assert.equal(results.find((r) => r.job.index === 0).attempts, 3);
  assert.equal(results.find((r) => r.job.index === 4).attempts, 2);
  assert.equal(results.find((r) => r.job.index === 1).attempts, 1);
  // Retries come after the first pass, not straight away.
  assert.ok(tries.findIndex((t) => t.attempt === 2) >= 4);
});

test("runQueue gives up after maxAttempts and skips jobs once stopped", async () => {
  const jobs = [1, 2, 3, 4];
  const always = await runQueue(jobs, async (j) => { if (j === 2) throw new Error("nope"); }, { maxAttempts: 2 });
  assert.deepEqual(always.map((r) => [r.status, r.attempts]), [["done", 1], ["failed", 2], ["done", 1], ["done", 1]]);
  assert.equal(always[1].error.message, "nope");

  let stop = false;
  const stopped = await runQueue(jobs, async (j) => { if (j === 2) stop = true; }, { stopped: () => stop });
  assert.deepEqual(stopped.map((r) => r.status), ["done", "done", "skipped", "skipped"]);
});
