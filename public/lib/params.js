// Model capability handling for the OpenRouter Image API.
// A parameter absent from supported_parameters is unsupported and must not be sent.

// Fields that are part of every request rather than model parameters.
const ALWAYS_SENT = new Set(["model", "prompt"]);

// What a request with automatic provider routing can use: the union of every provider's parameters.
// OpenRouter routes each request to a provider that supports the values sent (e.g. 4K goes to a provider
// that offers 4K), so an option offered by any provider is usable.
export function unionCapabilities(endpoints) {
  const out = {};
  for (const sp of (endpoints || []).map((e) => e?.supported_parameters || {})) {
    for (const [key, spec] of Object.entries(sp)) {
      const cur = out[key];
      if (!cur) out[key] = structuredClone(spec);
      else if (cur.type !== spec.type) continue;
      else if (spec.type === "enum") cur.values = [...new Set([...cur.values, ...spec.values])];
      else if (spec.type === "range") Object.assign(cur, { min: Math.min(cur.min, spec.min), max: Math.max(cur.max, spec.max) });
    }
  }
  return out;
}

// Parameters and pricing for one provider (by slug), or for automatic routing when slug is empty or unknown.
export function providerCaps(caps, slug) {
  const e = slug && caps?.endpoints?.find((x) => x.slug === slug);
  return e ? { supported_parameters: e.supported_parameters, pricing: e.pricing } : { supported_parameters: caps?.supported_parameters || {}, pricing: caps?.pricing || [] };
}

// Check one value against its capability spec. Returns a reason string if invalid.
function invalidReason(key, value, spec) {
  if (!spec) return "unsupported by this model";
  if (spec.type === "enum" && !spec.values.includes(value)) return `"${value}" not in ${spec.values.join(", ")}`;
  if (spec.type === "range") {
    const n = Array.isArray(value) ? value.length : Number(value);
    const what = Array.isArray(value) ? `${n} item(s)` : String(value);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) return `${what} outside ${spec.min}–${spec.max}`;
  }
  if (key === "seed" && !Number.isInteger(value)) return "seed must be an integer";
  return null;
}

// Keep only parameters the model supports with valid values.
// Returns the filtered payload plus {key, reason} for each dropped parameter.
export function filterParams(payload, caps) {
  const kept = {};
  const dropped = [];
  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (ALWAYS_SENT.has(key)) {
      kept[key] = value;
      continue;
    }
    const reason = invalidReason(key, value, caps?.[key]);
    if (reason) dropped.push({ key, reason });
    else kept[key] = value;
  }
  return { payload: kept, dropped };
}

// Values a set of models all accept for an enum parameter (e.g. resolution for a multi-model batch).
export function commonEnumValues(capsList, key) {
  const lists = capsList.map((c) => (c?.[key]?.type === "enum" ? c[key].values : null)).filter(Boolean);
  if (!lists.length) return [];
  return lists[0].filter((v) => lists.every((l) => l.includes(v)));
}

// Rough per-image USD estimate from an endpoint's pricing list.
// Matches a resolution variant (e.g. "2k") when priced per resolution, else the base output price.
export function estimateImageCost(pricing, resolution) {
  const out = (pricing || []).filter((p) => p.billable === "output_image" && p.unit === "image");
  if (!out.length) return null;
  const want = String(resolution || "").toLowerCase();
  const exact = want && out.find((p) => String(p.variant || "").toLowerCase() === want);
  const base = out.find((p) => !p.variant);
  return (exact || base || out.reduce((a, b) => (a.cost_usd <= b.cost_usd ? a : b))).cost_usd;
}
