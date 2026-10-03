import { test } from "node:test";
import assert from "node:assert/strict";
import { findSlots, pickOption, fillTemplate, buildPrompt, normalizeOptions } from "../public/lib/template.js";
import { DEFAULT_TEMPLATE, DEFAULT_POOLS } from "../public/lib/defaults.js";

// Deterministic RNG returning the given values in turn.
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test("findSlots returns unique names in order", () => {
  assert.deepEqual(findSlots("{a} and {b}, again {a}; not { c } or {1x}"), ["a", "b"]);
  assert.deepEqual(findSlots("no slots"), []);
});

test("fillTemplate replaces every occurrence and leaves unknown slots", () => {
  assert.equal(fillTemplate("{a}-{b}-{a}", { a: "X" }), "X-{b}-X");
  assert.equal(fillTemplate("{a}", { a: "" }), "");
});

test("normalizeOptions accepts strings and objects, drops blanks", () => {
  assert.deepEqual(normalizeOptions(["x", { value: " y ", weight: 2 }, "", { value: "z", weight: "bad" }]), [
    { value: "x", weight: 1 }, { value: "y", weight: 2 }, { value: "z", weight: 1 },
  ]);
});

test("pickOption honours weights", () => {
  const opts = [{ value: "a", weight: 1 }, { value: "b", weight: 3 }];
  assert.equal(pickOption(opts, () => 0), "a");
  assert.equal(pickOption(opts, () => 0.24), "a"); // 0.96 < 1
  assert.equal(pickOption(opts, () => 0.25), "b"); // 1.0 -> b
  assert.equal(pickOption(opts, () => 0.9999), "b");
});

test("pickOption skips zero weights and returns null when nothing is pickable", () => {
  assert.equal(pickOption([{ value: "a", weight: 0 }, { value: "b", weight: 1 }], () => 0), "b");
  assert.equal(pickOption([{ value: "a", weight: 0 }], () => 0), null);
  assert.equal(pickOption([], () => 0), null);
  assert.equal(pickOption(undefined, () => 0), null);
});

test("weighted picks follow their weights over many draws", () => {
  let s = 1; const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 20000; i++) counts[pickOption([{ value: "a", weight: 1 }, { value: "b", weight: 3 }], rng)]++;
  const share = counts.b / 20000;
  assert.ok(share > 0.72 && share < 0.78, `share of b was ${share}`);
});

test("buildPrompt picks one option per slot and reuses it for repeated slots", () => {
  const { prompt, picks, missing } = buildPrompt("{n} likes {c}. {n}!", { n: ["Ann", "Bo"], c: ["red", "blue"] }, {}, seq(0.6, 0.1));
  assert.deepEqual(picks, { n: "Bo", c: "red" });
  assert.equal(prompt, "Bo likes red. Bo!");
  assert.deepEqual(missing, []);
});

test("buildPrompt: locked values win, even when not in the pool", () => {
  const r = buildPrompt("{n} {c}", { n: ["Ann"], c: ["red"] }, { c: "green" }, () => 0);
  assert.deepEqual(r.picks, { n: "Ann", c: "green" });
  assert.equal(r.prompt, "Ann green");
});

test("buildPrompt: empty lock falls back to the pool", () => {
  assert.equal(buildPrompt("{c}", { c: ["red"] }, { c: "" }, () => 0).prompt, "red");
});

test("buildPrompt reports slots with no pool and leaves them unfilled", () => {
  const r = buildPrompt("{a} {b}", { a: ["x"], b: [] }, {}, () => 0);
  assert.deepEqual(r.missing, ["b"]);
  assert.equal(r.prompt, "x {b}");
});

test("default template is fully covered by default pools and keeps the adult wording", () => {
  assert.deepEqual(findSlots(DEFAULT_TEMPLATE).sort(), Object.keys(DEFAULT_POOLS).sort());
  assert.ok(DEFAULT_TEMPLATE.includes("adult woman in her mid-twenties"));
  const r = buildPrompt(DEFAULT_TEMPLATE, DEFAULT_POOLS, {}, () => 0);
  assert.deepEqual(r.missing, []);
  assert.ok(!/\{\w+\}/.test(r.prompt));
  assert.ok(r.prompt.startsWith("Candid phone photo of Freya, a naturally pretty adult woman"));
});

test("reference template slots are all covered by the reference pools", async () => {
  const { DEFAULT_REF_TEMPLATE, DEFAULT_REF_POOLS } = await import("../public/lib/defaults.js");
  assert.deepEqual(findSlots(DEFAULT_REF_TEMPLATE).sort(), Object.keys(DEFAULT_REF_POOLS).sort());
  const r = buildPrompt(DEFAULT_REF_TEMPLATE, DEFAULT_REF_POOLS, {}, () => 0);
  assert.deepEqual(r.missing, []);
  assert.ok(r.prompt.startsWith("Use the reference image for identity only."));
  assert.ok(r.prompt.includes("- Lighting: soft overcast daylight"));
});
