import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeHistory } from "./analyze-history.mjs";
import { exportVideo } from "./export-video.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cacheDir = join(root, ".cache", "repositories");
const exportDir = join(root, "exports");
const manifestCacheDir = join(root, ".cache", "manifests");
const dataDir = join(root, ".cache", "current");
const browserAssets = new Set([
  "/studio.html", "/index.html", "/data/manifest.js",
  "/src/studio.js", "/src/visualizer.js", "/src/motion.js", "/src/accounts.js",
]);
mkdirSync(cacheDir, { recursive: true });
mkdirSync(exportDir, { recursive: true });
mkdirSync(manifestCacheDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

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
    request.on("data", (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > maxBytes) { reject(new Error("请求过大")); return; } body += chunk; });
    request.on("end", () => { try { resolveBody(JSON.parse(body || "{}")); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

function pickLocalDirectory() {
  if (process.platform !== "darwin") throw new Error("本地目录弹窗目前只支持 macOS，请手动输入路径");
  return new Promise((resolvePath, rejectPath) => {
    execFile("osascript", ["-e", 'POSIX path of (choose folder with prompt "选择一个 Git 仓库文件夹")'], { encoding: "utf8" }, (error, stdout) => {
      if (error) return resolvePath(null);
      resolvePath(stdout.trim());
    });
  });
}

function localRepository(source) {
  const candidate = resolve(source);
  try { return execFileSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  throw new Error("本地路径不是 Git 仓库");
}

function resolveBranch(repo, requested) {
  for (const candidate of [requested, `origin/${requested}`]) {
    try { execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${candidate}^{commit}`], { stdio: "ignore" }); return candidate; } catch {}
  }
  return requested;
}

function cloneRepository(source, token, branch) {
  const key = createHash("sha256").update(`${source}\0${token ? "token" : "public"}`).digest("hex").slice(0, 16);
  const target = join(cacheDir, key);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const authArgs = token ? ["-c", "credential.helper="] : [];
  if (token) {
    env.GIT_ASKPASS = join(root, "scripts", "git-askpass.sh");
    env.GIT_HISTORY_TOKEN = token;
  }
  try {
    statSync(join(target, ".git"));
    execFileSync("git", [...authArgs, "-C", target, "fetch", "--no-tags", "origin", `+${branch}:refs/remotes/origin/${branch}`], { stdio: "ignore", env });
    return target;
  } catch {}
  try { rmSync(target, { recursive: true, force: true }); } catch {}
  execFileSync("git", [...authArgs, "clone", "--no-tags", "--single-branch", "--branch", branch, source, target], { stdio: "pipe", maxBuffer: 4 * 1024 * 1024, env });
  return target;
}

async function analyze(body) {
  const source = String(body.source || "").trim();
  if (!source) throw new Error("请输入 GitLab 仓库链接或本地 Git 路径");
  const branch = String(body.branch || "main");
  const remote = source.startsWith("http://") || source.startsWith("https://");
  const repo = remote ? cloneRepository(source, body.token, branch) : localRepository(source);
  const resolvedBranch = resolveBranch(repo, remote ? `origin/${branch}` : branch);
  const duration = Math.min(180, Math.max(15, Number(body.duration) || 60));
  const cacheKey = createHash("sha256").update(`${source}\0${remote ? branch : resolvedBranch}`).digest("hex").slice(0, 20);
  const cachePath = join(manifestCacheDir, `${cacheKey}.json`);
  let previousManifest = null;
  try { previousManifest = JSON.parse(readFileSync(cachePath, "utf8")); } catch {}
  if (remote && previousManifest?.project.branch === branch) previousManifest.project.branch = resolvedBranch;
  const manifest = await analyzeHistory({ repo, branch: resolvedBranch, duration, projectName: basename(repo), previousManifest, timeZone: String(body.timeZone || "Asia/Shanghai"), maxAuthors: body.maxAuthors, accountLinks: body.accountLinks });
  manifest.project.source = source;
  writeFileSync(cachePath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dataDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dataDir, "manifest.js"), `window.__GIT_MANIFEST__ = ${JSON.stringify(manifest)};\n`);
  return manifest;
}

function contentType(path) {
  return { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" }[extname(path)] || "application/octet-stream";
}

let exporting = false;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/pick-local") {
      const path = await pickLocalDirectory();
      return json(response, 200, path ? { ok: true, path } : { ok: false, cancelled: true });
    }
    if (request.method === "POST" && url.pathname === "/api/analyze") {
      const manifest = await analyze(await readBody(request));
      return json(response, 200, { ok: true, manifest, analysis: manifest.analysis });
    }
    if (request.method === "POST" && url.pathname === "/api/export") {
      if (exporting) return json(response, 409, { ok: false, error: "已有导出任务正在运行，请等待完成" });
      exporting = true;
      const streaming = request.headers.accept?.includes("application/x-ndjson");
      const send = event => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); };
      try {
        const { manifest } = await readBody(request, 64 * 1024 * 1024);
        if (manifest?.version !== 2 || !Array.isArray(manifest.commits) || !Array.isArray(manifest.authors)) throw new Error("缺少有效的当前页面 manifest，请刷新页面后重试");
        if (!(manifest.duration > 0 && Number.isFinite(manifest.duration))) throw new Error("导出时长无效");
        const output = join(exportDir, `git-history-${Date.now()}.mp4`);
        let lastProgress = -Infinity;
        if (streaming) {
          response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
          send({ type: "start" });
        }
        await exportVideo({ manifest, output, onProgress: (frame, total) => {
          if (!streaming) return;
          const now = performance.now();
          if (frame === 1 || frame === total || now - lastProgress >= 250) {
            lastProgress = now;
            send({ type: "progress", frame, total });
          }
        } });
        const file = `/exports/${basename(output)}`;
        if (streaming) { send({ type: "complete", file }); return response.end(); }
        return json(response, 200, { ok: true, file });
      } catch (error) {
        if (!response.headersSent) throw error;
        send({ type: "error", error: error instanceof Error ? error.message : String(error) });
        return response.end();
      } finally { exporting = false; }
    }
    const file = url.pathname === "/" ? "/studio.html" : decodeURIComponent(url.pathname);
    const video = /^\/exports\/[^/\\]+\.mp4$/.test(file);
    if (!browserAssets.has(file) && !video) return json(response, 403, { ok: false, error: "禁止访问" });
    if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { ok: false, error: "不支持的请求方法" });
    const currentManifest = join(dataDir, "manifest.js");
    const target = file === "/data/manifest.js" && existsSync(currentManifest) ? currentManifest : resolve(root, `.${file}`);
    let content;
    try {
      if (realpathSync(target) !== target) return json(response, 403, { ok: false, error: "禁止访问" });
      content = readFileSync(target);
    } catch { return json(response, 404, { ok: false, error: "文件不存在" }); }
    response.writeHead(200, { "content-type": video ? "video/mp4" : contentType(target), "cache-control": "no-store" });
    return response.end(content);
  } catch (error) {
    return json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
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
