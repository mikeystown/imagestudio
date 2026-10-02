import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCapabilities, filterParams, commonEnumValues, estimateImageCost } from "../public/lib/params.js";

const seedream = {
  resolution: { type: "enum", values: ["1K", "2K"] },
  aspect_ratio: { type: "enum", values: ["1:1", "3:4", "4:5", "9:16"] },
  n: { type: "range", min: 1, max: 1 },
  input_references: { type: "range", min: 0, max: 14 },
  seed: { type: "boolean" },
};

test("filterParams keeps supported params and always keeps model/prompt", () => {
  const { payload, dropped } = filterParams(
    { model: "m", prompt: "p", resolution: "2K", aspect_ratio: "3:4", seed: 42, n: 1 }, seedream);
  assert.deepEqual(payload, { model: "m", prompt: "p", resolution: "2K", aspect_ratio: "3:4", seed: 42, n: 1 });
  assert.deepEqual(dropped, []);
});

test("filterParams drops parameters absent from supported_parameters", () => {
  const caps = { aspect_ratio: seedream.aspect_ratio };
  const { payload, dropped } = filterParams({ model: "m", prompt: "p", seed: 7, resolution: "1K", aspect_ratio: "1:1" }, caps);
  assert.deepEqual(payload, { model: "m", prompt: "p", aspect_ratio: "1:1" });
  assert.deepEqual(dropped.map((d) => d.key).sort(), ["resolution", "seed"]);
});

test("filterParams drops enum values and ranges the model does not accept", () => {
  const { payload, dropped } = filterParams({ model: "m", prompt: "p", resolution: "4K", n: 3 }, seedream);
  assert.deepEqual(payload, { model: "m", prompt: "p" });
  assert.match(dropped.find((d) => d.key === "resolution").reason, /4K/);
  assert.match(dropped.find((d) => d.key === "n").reason, /outside 1–1/);
});

test("filterParams checks array length for input_references", () => {
  const ref = { type: "image_url", image_url: { url: "data:image/png;base64,AA" } };
  assert.equal(filterParams({ input_references: [ref, ref] }, seedream).dropped.length, 0);
  const tight = { input_references: { type: "range", min: 0, max: 1 } };
  assert.equal(filterParams({ input_references: [ref, ref] }, tight).dropped[0].key, "input_references");
});

test("filterParams rejects non-integer seeds and skips empty values", () => {
  const { payload, dropped } = filterParams({ seed: 1.5, resolution: "", aspect_ratio: null }, seedream);
  assert.deepEqual(payload, {});
  assert.deepEqual(dropped.map((d) => d.key), ["seed"]);
});

test("filterParams with no capabilities sends only model and prompt", () => {
  assert.deepEqual(filterParams({ model: "m", prompt: "p", seed: 1, n: 1 }, {}).payload, { model: "m", prompt: "p" });
  assert.deepEqual(filterParams({ model: "m", prompt: "p", seed: 1 }, undefined).payload, { model: "m", prompt: "p" });
});

test("mergeCapabilities with one endpoint returns its parameters", () => {
  assert.deepEqual(mergeCapabilities([{ supported_parameters: seedream }]), seedream);
  assert.deepEqual(mergeCapabilities([]), {});
});

test("mergeCapabilities intersects keys, enum values and ranges across providers", () => {
  const a = { seed: { type: "boolean" }, resolution: { type: "enum", values: ["1K", "2K", "4K"] }, n: { type: "range", min: 1, max: 4 }, quality: { type: "enum", values: ["low"] } };
  const b = { resolution: { type: "enum", values: ["2K", "4K", "8K"] }, n: { type: "range", min: 2, max: 10 }, quality: { type: "enum", values: ["high"] } };
  assert.deepEqual(mergeCapabilities([{ supported_parameters: a }, { supported_parameters: b }]), {
    resolution: { type: "enum", values: ["2K", "4K"] },
    n: { type: "range", min: 2, max: 4 },
  });
});

test("commonEnumValues finds values every selected model accepts", () => {
  const flux = { resolution: { type: "enum", values: ["768", "1K", "2K", "4K"] } };
  assert.deepEqual(commonEnumValues([seedream, flux], "resolution"), ["1K", "2K"]);
  assert.deepEqual(commonEnumValues([seedream, {}], "resolution"), ["1K", "2K"]);
  assert.deepEqual(commonEnumValues([{}], "resolution"), []);
});

test("estimateImageCost matches resolution variants, else the base price", () => {
  const flux = [
    { billable: "output_image", unit: "image", cost_usd: 0.048, variant: "1k" },
    { billable: "output_image", unit: "image", cost_usd: 0.1, variant: "2k" },
  ];
  assert.equal(estimateImageCost(flux, "2K"), 0.1);
  assert.equal(estimateImageCost(flux, "3K"), 0.048); // cheapest when nothing matches
  const sd = [
    { billable: "output_image", unit: "image", cost_usd: 0.045 },
    { billable: "output_image", unit: "image", cost_usd: 0.09, variant: "high_resolution" },
    { billable: "input_image", unit: "image", cost_usd: 0.003 },
  ];
  assert.equal(estimateImageCost(sd, "1K"), 0.045);
  assert.equal(estimateImageCost([], "1K"), null);
});
