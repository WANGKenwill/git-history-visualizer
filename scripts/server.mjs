import { AppError, t, normalizeLocale } from '../src/i18n.js';
import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryInfo, requireFullHistory } from "./repository.mjs";
import { analyzeHistory } from "./analyze-history.mjs";
import { exportVideo } from "./export-video.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cacheDir = join(root, ".cache", "repositories");
const exportDir = join(root, "exports");
const manifestCacheDir = join(root, ".cache", "manifests");
const dataDir = join(root, ".cache", "current");
const browserAssets = new Set([
  "/studio.html", "/index.html", "/data/manifest.js",
  "/src/i18n.js", "/src/studio.js", "/src/visualizer.js", "/src/motion.js", "/src/accounts.js", "/src/timeline.js",
]);
mkdirSync(cacheDir, { recursive: true });
mkdirSync(exportDir, { recursive: true });
mkdirSync(manifestCacheDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
const audioDir = mkdtempSync(join(tmpdir(), 'git-history-audio-'));
const audioFiles = new Map();
process.once('exit', () => rmSync(audioDir, { recursive: true, force: true }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));

async function uploadAudio(request) {
  const id = randomUUID(), path = join(audioDir, id);
  let bytes = 0;
  try {
    await pipeline(request, new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.length;
      done(bytes > 100 * 1024 * 1024 ? new AppError('error.audioTooLarge') : null, chunk);
    } }), createWriteStream(path));
    const probe = await new Promise((done, reject) => {
      execFile('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type,duration:format=duration', '-of', 'json', path], { encoding: 'utf8', timeout: 15_000 }, (error, stdout) => {
        if (error) return reject(new AppError(error.code === 'ENOENT' ? 'error.ffprobeMissing' : 'error.invalidAudio'));
        try { done(JSON.parse(stdout)); } catch { reject(new AppError('error.invalidAudio')); }
      });
    });
    const duration = Number(probe.streams?.[0]?.duration || probe.format?.duration);
    if (probe.streams?.[0]?.codec_type !== 'audio' || !Number.isFinite(duration) || duration <= 0) throw new AppError('error.invalidAudio');
    audioFiles.set(id, { path, duration, type: /^audio\/[\w.+-]+$/.test(request.headers['content-type'] || '') ? request.headers['content-type'] : 'application/octet-stream' });
    return { id, duration };
  } catch (error) { rmSync(path, { force: true }); throw error; }
}

function errorPayload(error, context) {
  if (context) console.warn(`[http] ${context.method} ${context.path} ${context.status} ${error.code}`);
  else console.error(error);
  const known = error instanceof AppError || error.code?.startsWith?.('error.') ? error : error.cause instanceof AppError ? error.cause : null;
  return { error: error instanceof Error ? error.message : String(error), errorCode: known?.code || 'error.unknown', errorParams: known?.params || {} };
}

function json(response, status, body) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function readBody(request, maxBytes = 50_000) {
  return new Promise((resolveBody, reject) => {
    request.setEncoding("utf8");
    let body = "", bytes = 0;
    request.on("data", (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > maxBytes) { reject(new AppError('error.requestTooLarge')); return; } body += chunk; });
    request.on("end", () => { try { resolveBody(JSON.parse(body || "{}")); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

function pickLocalDirectory(locale) {
  if (process.platform !== "darwin") throw new AppError('error.folderUnsupported');
  return new Promise((resolvePath, rejectPath) => {
    execFile("osascript", ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(t(locale, 'localRepository'))})`], { encoding: "utf8" }, (error, stdout) => {
      if (error) return resolvePath(null);
      resolvePath(stdout.trim());
    });
  });
}

function localRepository(source) {
  return repositoryInfo(resolve(source)).path;
}

function resolveBranch(repo, requested) {
  for (const candidate of [requested, `origin/${requested}`]) {
    try { execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${candidate}^{commit}`], { stdio: "ignore" }); return candidate; } catch {}
  }
  return requested;
}

function gitAuthentication(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const authArgs = token ? ["-c", "credential.helper="] : [];
  if (token) {
    env.GIT_ASKPASS = join(root, "scripts", "git-askpass.sh");
    env.GIT_HISTORY_TOKEN = token;
  }
  return { env, authArgs };
}

async function readBranches(body) {
  const source = String(body.source || "").trim();
  if (!source) throw new AppError('error.sourceRequired');
  let branches, defaultBranch, shallow;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const { env, authArgs } = gitAuthentication(body.token);
    const output = await new Promise((done, reject) => {
      execFile("git", [...authArgs, "ls-remote", "--symref", source, "HEAD", "refs/heads/*"],
        { env, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
          if (error) return reject(new AppError(error.killed ? 'error.branchTimeout' : 'error.branchRemote'));
          done(stdout);
        });
    });
    branches = [...new Set([...output.matchAll(/^[0-9a-f]+\trefs\/heads\/(.+)$/gm)].map(match => match[1]))].sort();
    defaultBranch = output.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
  } else {
    const repo = localRepository(source);
    shallow = repositoryInfo(repo).shallow;
    branches = execFileSync("git", ["-C", repo, "for-each-ref", "--sort=refname", "--format=%(refname:strip=2)", "refs/heads/"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    try { defaultBranch = execFileSync("git", ["-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  }
  if (!branches.length) throw new AppError('error.emptyRepository');
  return { branches, defaultBranch: branches.includes(defaultBranch) ? defaultBranch : branches[0], ...(shallow === undefined ? {} : { shallow }) };
}

function download(args, env) {
  return new Promise((done, reject) => {
    execFile("git", args, { env, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, error => {
      if (error) return reject(new AppError(error.killed ? 'error.downloadTimeout' : 'error.downloadFailed'));
      done();
    });
  });
}

async function cloneRepository(source, token, branch) {
  const key = createHash("sha256").update(`${source}\0${token ? "token" : "public"}`).digest("hex").slice(0, 16);
  const target = join(cacheDir, key);
  const { env, authArgs } = gitAuthentication(token);
  let info;
  try { info = repositoryInfo(target); if (info.path !== resolve(target)) info = undefined; } catch {}
  if (info) {
    requireFullHistory(target);
    const ref = info.bare ? `refs/heads/${branch}` : `refs/remotes/origin/${branch}`;
    await download([ ...authArgs, "-C", target, "fetch", "--no-tags", "origin", `+refs/heads/${branch}:${ref}` ], env);
    return target;
  }
  try { rmSync(target, { recursive: true, force: true }); } catch {}
  try {
    await download([...authArgs, "clone", "--bare", "--no-tags", "--single-branch", "--branch", branch, source, target], env);
  } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
  return target;
}

const completingHistory = new Set();
async function completeHistory(body) {
  const source = String(body.source || "").trim();
  if (!source || /^https?:\/\//.test(source)) throw new AppError('error.unshallowLocal');
  const repo = localRepository(source);
  if (completingHistory.has(repo)) throw new AppError('error.unshallowBusy');
  if (!repositoryInfo(repo).shallow) return;
  completingHistory.add(repo);
  try {
    const { env } = gitAuthentication();
    await new Promise((done, reject) => {
      execFile("git", ["-C", repo, "fetch", "--unshallow"], { env, encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, error => {
        if (error) return reject(new AppError(error.killed ? 'error.unshallowTimeout' : 'error.unshallowFailed'));
        done();
      });
    });
    if (repositoryInfo(repo).shallow) throw new AppError('error.unshallowIncomplete');
  } finally { completingHistory.delete(repo); }
}

async function analyze(body, onProgress = () => {}) {
  const source = String(body.source || "").trim();
  if (!source) throw new AppError('error.analyzeSource');
  const branch = String(body.branch || "main");
  const remote = source.startsWith("http://") || source.startsWith("https://");
  onProgress({ stage: remote ? "download" : "repository" });
  await new Promise(resolve => setImmediate(resolve));
  const repo = remote ? await cloneRepository(source, body.token, branch) : localRepository(source);
  const info = requireFullHistory(repo);
  const resolvedBranch = resolveBranch(repo, remote && !info.bare ? `origin/${branch}` : branch);
  const duration = Math.min(180, Math.max(15, Number(body.duration) || 60));
  const cacheKey = createHash("sha256").update(`${source}\0${remote ? branch : resolvedBranch}`).digest("hex").slice(0, 20);
  const cachePath = join(manifestCacheDir, `${cacheKey}.json`);
  let previousManifest = null;
  try { previousManifest = JSON.parse(readFileSync(cachePath, "utf8")); } catch {}
  if (remote && [branch, `origin/${branch}`].includes(previousManifest?.project.branch)) previousManifest.project.branch = resolvedBranch;
  const manifest = await analyzeHistory({ repo, branch: resolvedBranch, duration, projectName: basename(repo), previousManifest, timeZone: String(body.timeZone || "Asia/Shanghai"), maxAuthors: body.maxAuthors, accountLinks: body.accountLinks, onProgress });
  manifest.settings.locale = normalizeLocale(body.locale);
  manifest.project.source = source;
  writeFileSync(cachePath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dataDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dataDir, "manifest.js"), `window.__GIT_MANIFEST__ = ${JSON.stringify(manifest)};\n`);
  return manifest;
}

function contentType(path) {
  return { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" }[extname(path)] || "application/octet-stream";
}

const exportStatusPath = join(dataDir, 'export.json');
const activeStages = new Set(['preparing', 'rendering', 'encoding']);
let exportTask = null, lastStatusSave = 0;
function saveExportStatus() {
  writeFileSync(`${exportStatusPath}.tmp`, JSON.stringify(exportTask));
  renameSync(`${exportStatusPath}.tmp`, exportStatusPath);
  lastStatusSave = Date.now();
}
function checkExportFile() {
  if (exportTask?.stage !== 'complete') return;
  const file = exportTask.file;
  const path = typeof file === 'string' && /^\/exports\/[^/\\]+\.mp4$/.test(file) ? join(exportDir, basename(file)) : null;
  if (!path || !existsSync(path) || realpathSync(path) !== path) {
    exportTask = { ...exportTask, stage: 'failed', file: undefined, errorCode: 'error.exportFileMissing' };
    saveExportStatus();
  }
}
try { exportTask = JSON.parse(readFileSync(exportStatusPath, 'utf8')); } catch {}
if (activeStages.has(exportTask?.stage)) {
  exportTask = { ...exportTask, stage: 'interrupted', errorCode: 'exportInterrupted' };
  saveExportStatus();
}
checkExportFile();

function serveAudio(request, response, audio) {
  const size = statSync(audio.path).size;
  const headers = { 'content-type': audio.type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  let start = 0, end = size - 1;
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    }
    if (!match || (!match[1] && !match[2]) || start > end || start >= size) {
      response.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }); return response.end();
    }
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  response.writeHead(request.headers.range ? 206 : 200, { ...headers, 'content-length': end - start + 1 });
  if (request.method === 'HEAD') return response.end();
  const stream = createReadStream(audio.path, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

let exporting = false, analyzing = false;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const rejectStatic = (status, code) => json(response, status, {
      ok: false, ...errorPayload(new AppError(code), { method: request.method, path: url.pathname, status }),
    });
    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204, { "cache-control": "private, max-age=86400" });
        return response.end();
      }
      if (url.pathname === "/.well-known/appspecific/com.chrome.devtools.json") {
        response.writeHead(404, { "cache-control": "no-store" });
        return response.end();
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/export/status') {
      checkExportFile();
      return json(response, 200, { ok: true, task: exportTask });
    }
    const audioRoute = /^\/api\/audio\/([^/]+)(\/file)?$/.exec(url.pathname);
    if (audioRoute && (request.method === 'GET' || request.method === 'HEAD')) {
      const audio = audioFiles.get(audioRoute[1]);
      if (!audio || !existsSync(audio.path)) return json(response, 404, { ok: false, errorCode: 'error.audioMissing' });
      if (audioRoute[2]) return serveAudio(request, response, audio);
      return json(response, 200, { ok: true, id: audioRoute[1], duration: audio.duration });
    }
    if (request.method === "POST" && url.pathname === "/api/audio") {
      return json(response, 200, { ok: true, ...await uploadAudio(request) });
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/audio/")) {
      const id = url.pathname.slice('/api/audio/'.length), audio = audioFiles.get(id);
      if (exporting && exportTask?.audioId === id) return json(response, 409, { ok: false, errorCode: 'error.audioBusy' });
      if (audio) { rmSync(audio.path, { force: true }); audioFiles.delete(id); }
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/pick-local") {
      const path = await pickLocalDirectory(normalizeLocale(request.headers["accept-language"]?.split(",")[0]));
      return json(response, 200, path ? { ok: true, path } : { ok: false, cancelled: true });
    }
    if (request.method === "POST" && url.pathname === "/api/branches") {
      return json(response, 200, { ok: true, ...await readBranches(await readBody(request)) });
    }
    if (request.method === "POST" && url.pathname === "/api/unshallow") {
      await completeHistory(await readBody(request));
      return json(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/analyze") {
      if (analyzing) return json(response, 409, { ok: false, ...errorPayload(new AppError('error.analyzeBusy')) });
      analyzing = true;
      const streaming = request.headers.accept?.includes("application/x-ndjson");
      const send = event => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); };
      try {
        const body = await readBody(request);
        if (streaming) response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
        let lastStage, lastProgress = -Infinity;
        const manifest = await analyze(body, event => {
          if (!streaming) return;
          const now = performance.now();
          if (event.stage !== lastStage || event.completed === 0 || event.completed === event.total || event.cacheHit || now - lastProgress >= 250) {
            send({ type: "progress", ...event }); lastStage = event.stage; lastProgress = now;
          }
        });
        const result = { ok: true, manifest, analysis: manifest.analysis };
        if (streaming) { send({ type: "complete", ...result }); return response.end(); }
        return json(response, 200, result);
      } catch (error) {
        if (!response.headersSent) throw error;
        send({ type: "error", ...errorPayload(error) }); return response.end();
      } finally { analyzing = false; }
    }
    if (request.method === "POST" && url.pathname === "/api/export") {
      if (exporting) return json(response, 409, { ok: false, ...errorPayload(new AppError('error.exportBusy')) });
      exporting = true;
      exportTask = { id: randomUUID(), stage: 'preparing', frame: 0, total: 0 };
      saveExportStatus();
      const streaming = request.headers.accept?.includes("application/x-ndjson");
      const send = event => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); };
      try {
        const { manifest, audioId } = await readBody(request, 64 * 1024 * 1024);
        exportTask.audioId = audioId;
        const audioPath = audioId ? audioFiles.get(audioId)?.path : undefined;
        if (audioId && !audioPath) throw new AppError('error.audioMissing');
        if (manifest?.version !== 2 || !Array.isArray(manifest.commits) || !Array.isArray(manifest.authors)) throw new AppError('error.invalidManifest');
        if (!(manifest.duration > 0 && Number.isFinite(manifest.duration))) throw new AppError('error.invalidDuration');
        exportTask.total = Math.max(1, Math.round(manifest.duration * 30));
        saveExportStatus();
        const output = join(exportDir, `git-history-${Date.now()}.mp4`);
        let lastProgress = -Infinity;
        if (streaming) {
          response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
          send({ type: "start", taskId: exportTask.id });
        }
        const totals = await exportVideo({ manifest, output, audioPath, onProgress: (frame, total) => {
          exportTask.stage = frame === total ? 'encoding' : 'rendering';
          exportTask.frame = frame; exportTask.total = total;
          if (frame === total || Date.now() - lastStatusSave >= 1000) saveExportStatus();
          if (!streaming) return;
          const now = performance.now();
          if (frame === 1 || frame === total || now - lastProgress >= 250) {
            lastProgress = now;
            send({ type: "progress", frame, total });
          }
        } });
        const file = `/exports/${basename(output)}`;
        exportTask = { ...exportTask, stage: 'complete', file, ...totals };
        saveExportStatus();
        if (streaming) { send({ type: "complete", file }); return response.end(); }
        return json(response, 200, { ok: true, file });
      } catch (error) {
        exportTask = { ...exportTask, stage: 'failed', ...errorPayload(error) };
        saveExportStatus();
        if (!response.headersSent) throw error;
        send({ type: "error", ...errorPayload(error) });
        return response.end();
      } finally { exporting = false; }
    }
    const file = url.pathname === "/" ? "/studio.html" : decodeURIComponent(url.pathname);
    const video = /^\/exports\/[^/\\]+\.mp4$/.test(file);
    if (!browserAssets.has(file) && !video) return rejectStatic(403, 'error.forbidden');
    if (request.method !== "GET" && request.method !== "HEAD") return rejectStatic(405, 'error.method');
    const currentManifest = join(dataDir, "manifest.js");
    const target = file === "/data/manifest.js" && existsSync(currentManifest) ? currentManifest : resolve(root, `.${file}`);
    let content;
    try {
      if (realpathSync(target) !== target) return rejectStatic(403, 'error.forbidden');
      content = readFileSync(target);
    } catch { return rejectStatic(404, 'error.notFound'); }
    response.writeHead(200, { "content-type": video ? "video/mp4" : contentType(target), "cache-control": "no-store" });
    return response.end(content);
  } catch (error) {
    return json(response, 400, { ok: false, ...errorPayload(error) });
  }
});

const port = Number(process.env.GIT_HISTORY_PORT || 4173);
server.listen(port, "127.0.0.1", () => {
  const address = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Git History Visualizer: ${address}`);
  if (process.platform === "darwin" && !process.argv.includes("--no-open")) {
    execFile("open", [address], error => {
      if (error) console.error(`无法自动打开浏览器，请手动访问 ${address}`);
    });
  }
});
