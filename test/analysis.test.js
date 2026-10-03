import { test } from "node:test";
import assert from "node:assert/strict";
import { slotStats, modelStats, overallStats, imagesCSV, csvCell, listBatches } from "../public/lib/analysis.js";

const rec = (model, value, picks, tags = []) => ({ file: `${model}-${value}.png`, model, picks, rating: value == null ? undefined : { value, tags } });

const records = [
  rec("m1", 6, { eyes: "blue", hair: "brown" }, ["Hair"]),
  rec("m1", 4, { eyes: "blue", hair: "blonde" }, ["Hair", "Eyes"]),
  rec("m1", 1, { eyes: "green", hair: "brown" }, ["Too plain", "Hair"]),
  rec("m2", 2, { eyes: "green", hair: "brown" }, ["Too plastic"]),
  rec("m2", null, { eyes: "green", hair: "brown" }), // unrated: ignored
  rec("m2", 5, null, ["Too plastic"]), // rated but no picks: counted per model, not per slot
];

test("slotStats computes count, mean 1–7 score and share >= Solid beautiful per option", () => {
  const s = slotStats(records, { minSamples: 3 });
  assert.deepEqual(Object.keys(s), ["eyes", "hair"]);
  const blue = s.eyes.find((o) => o.option === "blue");
  assert.deepEqual(blue, { option: "blue", count: 2, mean: 6, solidShare: 1, lowSample: true }); // stored 6 and 4 -> scores 7 and 5
  const brown = s.hair.find((o) => o.option === "brown");
  assert.equal(brown.count, 3);
  assert.equal(brown.mean, 4); // scores 7, 2, 3
  assert.equal(brown.solidShare, 1 / 3);
  assert.equal(brown.lowSample, false);
});

test("slotStats sorts options by mean rating, best first", () => {
  assert.deepEqual(slotStats(records).eyes.map((o) => o.option), ["blue", "green"]);
});

test("slotStats flags options below the default sample threshold", () => {
  assert.ok(Object.values(slotStats(records)).flat().every((o) => o.lowSample));
});

test("slotStats treats stored 0 as score 1 and ignores out-of-range values", () => {
  const s = slotStats([rec("m", 0, { a: "x" }), rec("m", 7, { a: "x" }), rec("m", -1, { a: "x" })]);
  assert.deepEqual(s.a, [{ option: "x", count: 1, mean: 1, solidShare: 0, lowSample: true }]);
});

test("modelStats summarises ratings and ranks limiting-factor tags", () => {
  const [m1, m2] = modelStats(records);
  assert.equal(m1.model, "m1");
  assert.equal(m1.count, 3);
  assert.equal(m1.mean, 14 / 3);
  assert.deepEqual(m1.tags[0], { tag: "Hair", count: 3, share: 1 });
  assert.deepEqual(m1.tags.map((t) => t.tag), ["Hair", "Eyes", "Too plain"]);
  assert.equal(m2.count, 2);
  assert.deepEqual(m2.tags, [{ tag: "Too plastic", count: 2, share: 1 }]);
});

test("overallStats covers rated images only", () => {
  assert.deepEqual(overallStats(records), { count: 5, mean: 23 / 5, solidShare: 3 / 5 });
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
  assert.ok(lines[0].includes(",rating_1_7,rating_label,"));
  assert.ok(lines[1].includes(",7,Stunning,Hair,"));
});

test("listBatches groups by batch id, newest first, with names and counts", () => {
  const recs = [
    { file: "a", model: "m1", batch_id: "2026-10-01T10-00-00-000Z", rating: { value: 3 } },
    { file: "b", model: "m2", batch_id: "2026-10-01T10-00-00-000Z" },
    { file: "c", model: "m1", batch_id: "2026-10-03T09-00-00-000Z", batch_name: "face test", rating: { value: 5 } },
    { file: "d", model: "m1", batch_id: null }, // not from a batch
  ];
  assert.deepEqual(listBatches(recs), [
    { id: "2026-10-03T09-00-00-000Z", name: "face test", count: 1, rated: 1, models: ["m1"] },
    { id: "2026-10-01T10-00-00-000Z", name: null, count: 2, rated: 1, models: ["m1", "m2"] },
  ]);
});

test("imagesCSV only has slot columns used by the exported rows", () => {
  const header = imagesCSV([{ file: "x", picks: { face: "oval" } }]).split("\r\n")[0];
  assert.ok(header.endsWith("group,batch_id,batch_name,parent,template,prompt,bt_score,bt_se,n_comparisons,slot_face"));
});

test("imagesCSV writes the group name via the supplied lookup", () => {
  const csv = imagesCSV([{ file: "x", group_id: "g1" }], { groupName: (id) => (id === "g1" ? "Face shapes" : id) });
  const [header, row] = csv.trim().split("\r\n").map((l) => l.split(","));
  assert.equal(row[header.indexOf("group")], "Face shapes");
});
