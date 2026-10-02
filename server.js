// Minimal local server for the OpenRouter image UI.
// Keeps the API key server-side, proxies OpenRouter's Image API, and saves results to ./outputs.
// No dependencies: run with `node server.js`.

import http from "node:http";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const PORT = Number(process.env.PORT) || 5173;
const API = "https://openrouter.ai/api/v1";
const MAX_BODY = 60 * 1024 * 1024; // reference images arrive as base64 data URLs

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
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
};
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

let modelsCache = { at: 0, body: null };
async function getModels() {
  if (modelsCache.body && Date.now() - modelsCache.at < 10 * 60 * 1000) return modelsCache.body;
  const r = await fetch(`${API}/images/models`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  const body = await r.json();
  if (!r.ok) throw Object.assign(new Error(body?.error?.message || "Failed to load models"), { status: r.status });
  modelsCache = { at: Date.now(), body };
  return body;
}

async function generate(req, res) {
  const payload = JSON.parse(await readBody(req));
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
  if (!r.ok) return sendJson(res, r.status, body);

  // Save every returned image plus a sidecar JSON with the exact request (minus reference image bytes).
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = String(payload.model).split("/").pop();
  const saved = [];
  const meta = { ...payload, input_references: payload.input_references?.length, usage: body.usage, ms: Date.now() - started };
  for (const [i, img] of (body.data || []).entries()) {
    if (!img.b64_json) continue;
    const ext = EXT[img.media_type] || "png";
    const name = `${stamp}_${slug}_seed-${payload.seed ?? "none"}_${i}.${ext}`;
    await fs.writeFile(path.join(OUTPUT_DIR, name), Buffer.from(img.b64_json, "base64"));
    await fs.writeFile(path.join(OUTPUT_DIR, name.replace(/\.\w+$/, ".json")), JSON.stringify(meta, null, 2));
    saved.push(name);
  }
  sendJson(res, 200, { ...body, saved, ms: meta.ms });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const base = rel.startsWith("/outputs/") ? ROOT : PUBLIC_DIR;
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) return sendJson(res, 403, { error: { message: "Forbidden" } });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: { message: "Not found" } });
  }
}

http
  .createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/api/models") return sendJson(res, 200, await getModels());
      if (req.method === "POST" && req.url === "/api/images") return await generate(req, res);
      if (req.method === "GET") return await serveStatic(req, res);
      sendJson(res, 405, { error: { message: "Method not allowed" } });
    } catch (err) {
      console.error(err);
      sendJson(res, err.status || 500, { error: { code: err.status || 500, message: err.message } });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Image Studio running at http://127.0.0.1:${PORT}`));
