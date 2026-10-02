// Minimal local server for the OpenRouter image UI.
// Keeps the API key server-side, proxies OpenRouter's Image API, and saves results to ./outputs.
// No dependencies: run with `node server.js`.

import http from "node:http";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeCapabilities, filterParams } from "./public/lib/params.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const POOL_DIR = path.join(ROOT, "data", "pool-sets");
const PORT = Number(process.env.PORT) || 5173;
const API = "https://openrouter.ai/api/v1";
const MAX_BODY = 60 * 1024 * 1024; // reference images arrive as base64 data URLs
const CAPS_TTL = 60 * 60 * 1000;

// Load .env (KEY=value lines) without overriding real environment variables.
const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("OPENROUTER_API_KEY is not set. Put it in .env or export it, then restart.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
};
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const httpError = (status, message) => Object.assign(new Error(message), { status });

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, "Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch (e) {
    throw e.status ? e : httpError(400, "Invalid JSON body");
  }
}

// Write via a temp file so a crash never leaves a half-written JSON file.
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

async function openrouterGet(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw httpError(r.status, body?.error?.message || `OpenRouter returned ${r.status}`);
  return body;
}

let modelsCache = { at: 0, body: null };
async function getModels() {
  if (modelsCache.body && Date.now() - modelsCache.at < 10 * 60 * 1000) return modelsCache.body;
  const body = await openrouterGet(`${API}/images/models`);
  modelsCache = { at: Date.now(), body };
  return body;
}

// Per-model capabilities from the endpoints listing, merged across providers.
// Falls back to the model list's supported_parameters if the endpoints call fails.
const capsCache = new Map();
async function getCapabilities(model) {
  if (!/^[\w.:-]+\/[\w.:-]+$/.test(model)) throw httpError(400, "Invalid model id");
  const hit = capsCache.get(model);
  if (hit && Date.now() - hit.at < CAPS_TTL) return hit.body;
  let body;
  try {
    const r = await openrouterGet(`${API}/images/models/${model}/endpoints`);
    const endpoints = r.endpoints || [];
    if (!endpoints.length) throw new Error("no endpoints");
    body = {
      model,
      supported_parameters: mergeCapabilities(endpoints),
      providers: endpoints.map((e) => e.provider_name),
      pricing: endpoints[0].pricing || [],
      source: "endpoints",
    };
  } catch (err) {
    const m = (await getModels()).data?.find((x) => x.id === model);
    if (!m) throw httpError(err.status || 502, `Could not load capabilities for ${model}: ${err.message}`);
    body = { model, supported_parameters: m.supported_parameters || {}, providers: [], pricing: [], source: "models" };
  }
  capsCache.set(model, { at: Date.now(), body });
  return body;
}

// Resolve a client-supplied output file name to a path inside OUTPUT_DIR, or null.
function outputPath(name) {
  if (typeof name !== "string" || name !== path.basename(name) || name.startsWith(".")) return null;
  return path.join(OUTPUT_DIR, name);
}

async function fileAsDataUrl(name) {
  const file = outputPath(name);
  const ext = file && path.extname(file).toLowerCase();
  if (!file || !IMAGE_EXT.has(ext)) throw httpError(400, `Not an output image: ${name}`);
  const data = await fs.readFile(file).catch(() => {
    throw httpError(404, `Reference image not found: ${name}`);
  });
  return `data:${MIME[ext]};base64,${data.toString("base64")}`;
}

// Turn a sidecar into a library record (flat fields the UI and analysis use).
function toRecord(file, meta, mtime) {
  return {
    file,
    model: meta.model,
    prompt: meta.prompt,
    seed: meta.seed ?? null,
    resolution: meta.resolution ?? null,
    aspect_ratio: meta.aspect_ratio ?? null,
    cost: meta.usage?.cost ?? null,
    ms: meta.ms ?? null,
    created_at: meta.created_at || mtime?.toISOString() || null,
    template: meta.app?.template ?? null,
    picks: meta.app?.picks ?? null,
    kind: meta.app?.kind ?? null,
    batch_id: meta.app?.batch_id ?? null,
    parent: meta.app?.parent ?? null,
    references: meta.app?.ref_files ?? null,
    rating: meta.rating ?? null,
  };
}

async function generate(req, res) {
  const { app = {}, ref_files = [], ...request } = await readJson(req);
  if (!request.model || !request.prompt) throw httpError(400, "model and prompt are required");

  if (ref_files.length) {
    const urls = await Promise.all(ref_files.map(fileAsDataUrl));
    request.input_references = [
      ...(request.input_references || []),
      ...urls.map((url) => ({ type: "image_url", image_url: { url } })),
    ];
  }

  // Only send what the model supports; references are never silently dropped.
  const caps = await getCapabilities(request.model);
  const { payload, dropped } = filterParams(request, caps.supported_parameters);
  const refProblem = dropped.find((d) => d.key === "input_references");
  if (refProblem) throw httpError(400, `Reference images: ${refProblem.reason}`);

  const started = Date.now();
  const r = await fetch(`${API}/images`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Local Image Studio",
    },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({ error: { code: r.status, message: r.statusText } }));
  if (!r.ok) return sendJson(res, r.status, { ...body, dropped });

  // Save every returned image plus a sidecar JSON with the exact request (minus reference image bytes).
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const createdAt = new Date();
  const stamp = createdAt.toISOString().replace(/[:.]/g, "-");
  const slug = String(payload.model).split("/").pop();
  const meta = {
    ...payload,
    input_references: payload.input_references?.length,
    usage: body.usage,
    ms: Date.now() - started,
    created_at: createdAt.toISOString(),
    dropped_params: dropped.length ? dropped : undefined,
    app: { ...app, ref_files: ref_files.length ? ref_files : undefined },
  };
  const images = (body.data || []).filter((img) => img.b64_json);
  if (images.length > 1 && meta.usage?.cost != null) meta.usage = { ...meta.usage, cost: meta.usage.cost / images.length };
  const saved = [];
  const records = [];
  for (const [i, img] of images.entries()) {
    const ext = EXT[img.media_type] || "png";
    const name = `${stamp}_${slug}_seed-${payload.seed ?? "none"}_${i}.${ext}`;
    await fs.writeFile(path.join(OUTPUT_DIR, name), Buffer.from(img.b64_json, "base64"));
    await writeJsonAtomic(path.join(OUTPUT_DIR, name.replace(/\.\w+$/, ".json")), meta);
    saved.push(name);
    records.push(toRecord(name, meta));
  }
  // Images are on disk now; don't send the base64 back to the browser.
  sendJson(res, 200, { usage: body.usage, saved, records, dropped, ms: meta.ms });
}

// Every image in outputs/ with its sidecar, newest first.
async function library(res) {
  const names = await fs.readdir(OUTPUT_DIR).catch(() => []);
  const sidecars = new Set(names.filter((n) => n.endsWith(".json")));
  const records = [];
  for (const name of names) {
    if (!IMAGE_EXT.has(path.extname(name).toLowerCase())) continue;
    const side = name.replace(/\.\w+$/, ".json");
    if (!sidecars.has(side)) continue;
    try {
      const [text, stat] = await Promise.all([fs.readFile(path.join(OUTPUT_DIR, side), "utf8"), fs.stat(path.join(OUTPUT_DIR, name))]);
      records.push(toRecord(name, JSON.parse(text), stat.mtime));
    } catch (err) {
      console.error(`Skipping ${side}: ${err.message}`);
    }
  }
  records.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  sendJson(res, 200, { records });
}

// Serialise sidecar updates per file so fast rating keystrokes can't clobber each other.
const sidecarLocks = new Map();
function withSidecarLock(file, fn) {
  const next = (sidecarLocks.get(file) || Promise.resolve()).then(fn, fn);
  sidecarLocks.set(file, next.catch(() => {}));
  return next;
}

async function rate(req, res, name) {
  const file = outputPath(name);
  if (!file || !IMAGE_EXT.has(path.extname(file).toLowerCase())) throw httpError(400, "Invalid image name");
  const { value = null, tags = [], notes = "" } = await readJson(req);
  if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= 6)) throw httpError(400, "Rating must be 0–6 or null");
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) throw httpError(400, "tags must be strings");
  const side = file.replace(/\.\w+$/, ".json");
  const rating = await withSidecarLock(side, async () => {
    const meta = JSON.parse(await fs.readFile(side, "utf8").catch(() => {
      throw httpError(404, "Image metadata not found");
    }));
    meta.rating = value === null && !tags.length && !notes ? undefined : { value, tags, notes: String(notes), rated_at: new Date().toISOString() };
    await writeJsonAtomic(side, meta);
    return meta.rating ?? null;
  });
  sendJson(res, 200, { rating });
}

// ---------- pool sets: data/pool-sets/<name>.json ----------
function poolSetPath(name) {
  if (!/^[\w\- ]{1,60}$/.test(name)) throw httpError(400, "Pool set names may use letters, digits, spaces, - and _ (max 60)");
  return path.join(POOL_DIR, `${name}.json`);
}

async function poolSets(req, res, name) {
  if (!name) {
    const names = (await fs.readdir(POOL_DIR).catch(() => [])).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
    return sendJson(res, 200, { names: names.sort() });
  }
  const file = poolSetPath(name);
  if (req.method === "GET") {
    const text = await fs.readFile(file, "utf8").catch(() => {
      throw httpError(404, "Pool set not found");
    });
    return sendJson(res, 200, JSON.parse(text));
  }
  if (req.method === "PUT") {
    const { template, pools, locks } = await readJson(req);
    if (typeof template !== "string" || typeof pools !== "object" || !pools) throw httpError(400, "template and pools are required");
    await fs.mkdir(POOL_DIR, { recursive: true });
    await writeJsonAtomic(file, { template, pools, locks: locks || {}, saved_at: new Date().toISOString() });
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "DELETE") {
    await fs.rm(file, { force: true });
    return sendJson(res, 200, { ok: true });
  }
  throw httpError(405, "Method not allowed");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: { message: "Bad path" } });
  }
  if (rel === "/") rel = "/index.html";
  // outputs/ is served from OUTPUT_DIR; everything else from public/. Nothing outside those two.
  const [base, sub] = rel.startsWith("/outputs/") ? [OUTPUT_DIR, rel.slice("/outputs/".length)] : [PUBLIC_DIR, rel];
  const file = path.join(base, sub);
  if (!file.startsWith(base + path.sep)) return sendJson(res, 403, { error: { message: "Forbidden" } });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: { message: "Not found" } });
  }
}

http
  .createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      const tail = (prefix) => decodeURIComponent(pathname.slice(prefix.length));
      if (req.method === "GET" && pathname === "/api/models") return sendJson(res, 200, await getModels());
      if (req.method === "GET" && pathname.startsWith("/api/capabilities/")) return sendJson(res, 200, await getCapabilities(tail("/api/capabilities/")));
      if (req.method === "POST" && pathname === "/api/images") return await generate(req, res);
      if (req.method === "GET" && pathname === "/api/library") return await library(res);
      if (req.method === "POST" && pathname.startsWith("/api/rating/")) return await rate(req, res, tail("/api/rating/"));
      if (pathname === "/api/pool-sets" || pathname.startsWith("/api/pool-sets/")) return await poolSets(req, res, tail("/api/pool-sets/") || "");
      if (req.method === "GET") return await serveStatic(req, res);
      sendJson(res, 405, { error: { message: "Method not allowed" } });
    } catch (err) {
      if (!err.status) console.error(err);
      sendJson(res, err.status || 500, { error: { code: err.status || 500, message: err.message } });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Image Studio running at http://127.0.0.1:${PORT}`));
