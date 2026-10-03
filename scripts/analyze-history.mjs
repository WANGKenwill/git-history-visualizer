import { analyzeRetention, numstatEntries } from './retention.mjs';
import { accountLinks as normalizeAccountLinks } from '../src/accounts.js';
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { prepareHistory } from "../src/visualizer.js";
import { basename, dirname, resolve } from "node:path";

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
];


function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trimEnd();
}

function excluded(path, excludes) {
  return excludes.some((pattern) => pattern.test(path));
}

function parseNumstat(repo, sha, parent, excludes) {
  const args = parent ? ["diff", "--numstat", "-z", "--no-renames", parent, sha] : ["show", "--format=", "--numstat", "-z", "--no-renames", sha];
  const output = git(repo, args);
  let additions = 0;
  let deletions = 0;
  for (const entry of numstatEntries(output)) {
    if (entry.binary || excluded(entry.path, excludes)) continue;
    additions += entry.additions; deletions += entry.deletions;
  }
  return { additions, deletions, churn: additions + deletions };
}

function parseNumstatLog(repo, args, excludes) {
  const format = "%x1e%H%x00%P%x00%aI%x00%cI%x00%an%x00%ae%x00%s";
  const output = git(repo, ["log", ...args, `--format=${format}`, "--numstat", "-z", "--no-renames"]);
  const statsBySha = new Map();
  for (const record of output.split("\x1e").filter(Boolean)) {
    const fields = record.replace(/^\n+/, '').split("\0");
    const sha = fields[0];
    if (!sha) continue;
    let additions = 0, deletions = 0;
    for (const entry of numstatEntries(fields.slice(7).join("\0"))) {
      if (entry.binary || excluded(entry.path, excludes)) continue;
      additions += entry.additions; deletions += entry.deletions;
    }
    statsBySha.set(sha, { additions, deletions, churn: additions + deletions });
  }
  return statsBySha;
}

function parseLog(repo, branch, firstParent = true) {
  const format = "%H%x00%P%x00%aI%x00%cI%x00%an%x00%ae%x00%s";
  const output = git(repo, ["log", ...(firstParent ? ["--first-parent"] : []), "--reverse", `--format=${format}`, branch]);
  return output.split("\n").filter(Boolean).map((line) => {
    const [sha, parents, authoredAt, committedAt, authorName, authorEmail, subject] = line.split("\0");
    return { sha, parents: parents ? parents.split(" ") : [], authoredAt, committedAt, authorName, authorEmail, subject };
  });
}

// Stable identities survive appended history and cache rebuilds.
export function identityHash(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function makeAuthorMap(commits) {
  const aliases = new Map();
  for (const commit of commits) {
    const id = commit.authorEmail.toLowerCase();
    if (!aliases.has(id)) aliases.set(id, { id, name: commit.authorName, email: commit.authorEmail });
  }
  return [...aliases.values()].map((author) => ({ ...author, color: `hsl(${identityHash(author.id) % 360}, 78%, 68%)` }));
}

function normalizedTimeline(commits, duration) {
  // Square-root gap compression preserves ordering without long inactive stretches.
  const weights = commits.map((commit, index) => index ? Math.sqrt(Math.max(0, Date.parse(commit.authoredAt) - Date.parse(commits[index - 1].authoredAt))) : 0);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  return commits.map((commit, index) => {
    elapsed += weights[index];
    const fraction = total ? elapsed / total : index / Math.max(1, commits.length - 1);
    return { ...commit, at: 0.6 + fraction * Math.max(0, duration - 3.6) };
  });
}

export function analyzeHistory({ repo, branch = "main", excludes = DEFAULT_EXCLUDES, duration = 60, projectName = "Git history", previousManifest = null, timeZone = "Asia/Shanghai", maxAuthors = 16, accountLinks }) {
  if (!existsSync(resolve(repo, ".git"))) throw new Error(`不是 Git 仓库: ${repo}`);
  new Intl.DateTimeFormat("zh-CN", { timeZone }).format(0);
  duration = Math.min(180, Math.max(15, Number(duration) || 60));
  maxAuthors = Math.min(32, Math.max(1, Math.floor(Number(maxAuthors) || 16)));
  const head = git(repo, ["rev-parse", `${branch}^{commit}`]);
  const allCommits = parseLog(repo, head, false);
  const regular = allCommits.filter((commit) => commit.parents.length < 2);
  const rulesKey = JSON.stringify(excludes);
  const pathExcludes = excludes.map((pattern) => new RegExp(`^${pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/|\*\*|\*/g, (wildcard) => wildcard === "**/" ? "(?:.*/)?" : wildcard === "**" ? ".*" : "[^/]*")}$`));
  const compatible = previousManifest?.version === 2 && previousManifest.project.repo === repo && previousManifest.project.branch === branch && JSON.stringify(previousManifest.rules.excludes) === rulesKey;
  const canIncrement = compatible && previousManifest.rules.exclusionMatching === "path-glob" && previousManifest.rules.numstatFormat === "nul-v1" && allCommits.some((commit) => commit.sha === previousManifest.project.head);
  const previous = new Map(canIncrement ? previousManifest.commits.map((commit) => [commit.sha, commit]) : []);
  const newShas = regular.filter((commit) => !previous.has(commit.sha)).map((commit) => commit.sha);
  const stats = newShas.length ? parseNumstatLog(repo, ["--no-merges", head, ...(canIncrement ? [`^${previousManifest.project.head}`] : [])], pathExcludes) : new Map();
  const commits = regular.map((commit) => ({
    ...commit, authorId: commit.authorEmail.toLowerCase(),
    ...(previous.get(commit.sha) || stats.get(commit.sha) || parseNumstat(repo, commit.sha, commit.parents[0], pathExcludes)),
    groupIds: [],
  })).sort((a, b) => Date.parse(a.authoredAt) - Date.parse(b.authoredAt) || Date.parse(a.committedAt) - Date.parse(b.committedAt) || a.sha.localeCompare(b.sha));
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const groups = allCommits.filter((commit) => commit.parents.length > 1).map((merge) => {
    const shas = git(repo, ["rev-list", "--no-merges", ...merge.parents.slice(1), `^${merge.parents[0]}`]).split("\n").filter((sha) => bySha.has(sha));
    for (const sha of shas) bySha.get(sha).groupIds.push(merge.sha);
    return { id: merge.sha, kind: "merge-group", title: merge.subject, integratedAt: merge.committedAt, commitShas: shas };
  });
  const retentionResult = analyzeRetention(repo, head, commits, rulesKey, path => excluded(path, pathExcludes), canIncrement ? previousManifest : null);
  const authors = makeAuthorMap(commits).map((author) => ({ ...author, additions: 0, deletions: 0, churn: 0, retainedLines: 0, commitCount: 0 }));
  const authorMap = new Map(authors.map((author) => [author.id, author]));
  for (const commit of commits) {
    const author = authorMap.get(commit.authorId);
    author.additions += commit.additions; author.deletions += commit.deletions; author.churn += commit.churn; author.commitCount++; author.retainedLines += commit.retainedLines;
  }
  // Project stock is counted separately from author churn, including the final merge tree.
  const treeStats = canIncrement && head === previousManifest.project.head ? null : parseNumstat(repo, head, git(repo, ["hash-object", "-t", "tree", "--stdin"]), pathExcludes);
  const manifest = {
    version: 2,
    project: { name: projectName, branch, repo, head, generatedAt: new Date().toISOString() },
    rules: { excludes, exclusionMatching: "path-glob", numstatFormat: "nul-v1", timeline: "authored-time-compressed-gaps", contribution: "additions+deletions", mergeResolution: "excluded", identity: "author-email" },
    settings: { timeZone, maxAuthors, accountLinks: normalizeAccountLinks(authors, accountLinks ?? (compatible ? previousManifest.settings.accountLinks : {})) },
    layout: compatible ? previousManifest.layout : {},
    retention: retentionResult.retention,
    authors, groups, commits: normalizedTimeline(commits, duration), duration,
    totalChurn: authors.reduce((sum, author) => sum + author.churn, 0),
    totalLines: treeStats ? treeStats.additions : previousManifest.totalLines,
    analysis: { cacheHit: Boolean(canIncrement && head === previousManifest.project.head), incremental: Boolean(canIncrement && head !== previousManifest.project.head), analyzedEvents: newShas.length, retentionCacheHit: retentionResult.cacheHit, retentionMs: retentionResult.elapsedMs },
  };
  manifest.layout = Object.fromEntries(prepareHistory(manifest).nodes.map(n=>[n.id,{x:n.x,y:n.y}]));
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [repo = process.cwd(), branch = "main", output = "data/manifest.json"] = process.argv.slice(2);
  const manifest = analyzeHistory({ repo: resolve(repo), branch, projectName: basename(resolve(repo)) });
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(output.replace(/\.json$/, ".js")), `window.__GIT_MANIFEST__ = ${JSON.stringify(manifest)};\n`);
  console.log(`已分析 ${manifest.commits.length} 个提交，${manifest.totalChurn} 行改动，写入 ${output}`);
}
