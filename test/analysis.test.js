import { test } from "node:test";
import assert from "node:assert/strict";
import { slotStats, modelStats, overallStats, imagesCSV, slotStatsCSV, csvCell, toJSONL } from "../public/lib/analysis.js";

const rec = (model, value, picks, tags = []) => ({ file: `${model}-${value}.png`, model, picks, rating: value == null ? undefined : { value, tags } });

const records = [
  rec("m1", 6, { eyes: "blue", hair: "brown" }, ["Hair"]),
  rec("m1", 4, { eyes: "blue", hair: "blonde" }, ["Hair", "Eyes"]),
  rec("m1", 1, { eyes: "green", hair: "brown" }, ["Too plain", "Hair"]),
  rec("m2", 2, { eyes: "green", hair: "brown" }, ["Too plastic"]),
  rec("m2", null, { eyes: "green", hair: "brown" }), // unrated: ignored
  rec("m2", 5, null, ["Too plastic"]), // rated but no picks: counted per model, not per slot
];

test("slotStats computes count, mean and share >= Solid beautiful per option", () => {
  const s = slotStats(records, { minSamples: 3 });
  assert.deepEqual(Object.keys(s), ["eyes", "hair"]);
  const blue = s.eyes.find((o) => o.option === "blue");
  assert.deepEqual(blue, { option: "blue", count: 2, mean: 5, solidShare: 1, lowSample: true });
  const brown = s.hair.find((o) => o.option === "brown");
  assert.equal(brown.count, 3);
  assert.equal(brown.mean, 3);
  assert.equal(brown.solidShare, 1 / 3);
  assert.equal(brown.lowSample, false);
});

test("slotStats sorts options by mean rating, best first", () => {
  assert.deepEqual(slotStats(records).eyes.map((o) => o.option), ["blue", "green"]);
});

test("slotStats flags options below the default sample threshold", () => {
  assert.ok(Object.values(slotStats(records)).flat().every((o) => o.lowSample));
});

test("slotStats treats rating 0 as rated and ignores out-of-range values", () => {
  const s = slotStats([rec("m", 0, { a: "x" }), rec("m", 7, { a: "x" }), rec("m", -1, { a: "x" })]);
  assert.deepEqual(s.a, [{ option: "x", count: 1, mean: 0, solidShare: 0, lowSample: true }]);
});

test("modelStats summarises ratings and ranks limiting-factor tags", () => {
  const [m1, m2] = modelStats(records);
  assert.equal(m1.model, "m1");
  assert.equal(m1.count, 3);
  assert.equal(m1.mean, 11 / 3);
  assert.deepEqual(m1.tags[0], { tag: "Hair", count: 3, share: 1 });
  assert.deepEqual(m1.tags.map((t) => t.tag), ["Hair", "Eyes", "Too plain"]);
  assert.equal(m2.count, 2);
  assert.deepEqual(m2.tags, [{ tag: "Too plastic", count: 2, share: 1 }]);
});

test("overallStats covers rated images only", () => {
  assert.deepEqual(overallStats(records), { count: 5, mean: 18 / 5, solidShare: 3 / 5 });
  assert.deepEqual(overallStats([]), { count: 0, mean: null, solidShare: null });
});

test("csvCell quotes commas, quotes and newlines", () => {
  assert.equal(csvCell('a, "b"\nc'), '"a, ""b""\nc"');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(3), "3");
});

test("imagesCSV has one column per slot and a row per image", () => {
  const lines = imagesCSV(records).trim().split("\r\n");
  assert.equal(lines.length, records.length + 1);
  assert.ok(lines[0].endsWith("slot_eyes,slot_hair"));
  assert.ok(lines[1].includes(",6,Stunning,Hair,"));
});

test("slotStatsCSV and JSONL export", () => {
  const csv = slotStatsCSV(slotStats(records));
  assert.ok(csv.startsWith("slot,option,count,mean_rating,share_solid_or_above,low_sample\r\n"));
  assert.ok(csv.includes("eyes,blue,2,5.000,1.000,true"));
  const jsonl = toJSONL(records);
  assert.equal(jsonl.trim().split("\n").length, records.length);
  assert.deepEqual(JSON.parse(jsonl.split("\n")[0]), records[0]);
  assert.equal(toJSONL([]), "");
});
