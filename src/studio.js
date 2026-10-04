import { drawHistory, hitAuthor, prepareHistory, historyState } from "./visualizer.js";
import { accountLinks, changeAccount } from "./accounts.js";
const $ = (selector) => document.querySelector(selector);
const canvas = $("#preview"); const ctx = canvas.getContext("2d");
const fallback = { project: { name: "Git history", branch: "main" }, duration: 60, commits: [], groups: [], settings: { timeZone: "Asia/Shanghai", maxAuthors: 16 }, totalChurn: 0, authors: [], initialLines: 0, totalLines: 0 };
let manifest = window.__GIT_MANIFEST__?.version === 2 ? window.__GIT_MANIFEST__ : fallback; let time = 0; let playing = false; let lastFrame = 0;
function render() { const nodes = drawHistory(ctx, manifest, time); currentChurn = nodes.reduce((sum,n)=>sum+n.churn,0); showDetail(); $("#scrub").value = time; $("#time-label").textContent = `${time.toFixed(1)}s / ${manifest.duration}s`; }
function tick(now) { if (playing) { if (!lastFrame) lastFrame = now; time += (now - lastFrame) / 1000; if (time >= manifest.duration) { time = manifest.duration; playing = false; $("#play").textContent = "播放"; } lastFrame = now; render(); } else lastFrame = 0; requestAnimationFrame(tick); }
let selectedAuthor = null;
let loadedSource = manifest.project.source || manifest.project.repo;
let draftLinks = accountLinks(manifest.authors, manifest.settings?.accountLinks);
let configOpen = !(manifest.version === 2 && manifest.commits.length);
let focused = false;
function showConfig() {
  $('#config-panel').hidden = focused || !configOpen;
  $('.shell').classList.toggle('config-open', !focused && configOpen);
  $('#toggle-config').setAttribute('aria-expanded', String(!focused && configOpen));
  $('#toggle-config').disabled = focused;
}
function handleConfigToggle() { configOpen = !configOpen; showConfig(); }
function handleFocusView() {
  focused = !focused;
  document.body.classList.toggle('focus-mode', focused);
  $('#focus-view').textContent = focused ? '退出专注' : '专注观看';
  $('#focus-view').setAttribute('aria-pressed', String(focused));
  showConfig();
}
async function handleFullscreen() {
  $('#player-status').textContent = '';
  try {
    if (document.fullscreenElement === $('#player')) await document.exitFullscreen();
    else await $('#player').requestFullscreen();
  } catch (error) { $('#player-status').textContent = `无法切换全屏：${error.message}`; }
}
function showFullscreen() {
  const fullscreen = document.fullscreenElement === $('#player');
  $('#fullscreen').textContent = fullscreen ? '退出全屏' : '全屏';
  $('#fullscreen').setAttribute('aria-pressed', String(fullscreen));
}
function handleFullscreenKey(event) {
  if (event.key === 'Escape' && document.fullscreenElement === $('#player')) handleFullscreen();
}
function showHeading() {
  $('#project-title').textContent = manifest.version === 2 && manifest.commits.length ? manifest.project.name : 'Git History';
  $('#project-branch').textContent = manifest.version === 2 && manifest.commits.length ? manifest.project.branch : '';
}

function showAccounts() {
  const list = $('#account-list'); list.replaceChildren();
  const roots = manifest.authors.filter(a => !draftLinks[a.id]);
  for (const author of manifest.authors) {
    const root = draftLinks[author.id] || author.id;
    const row = document.createElement('div'); row.className='account-row';
    const name = document.createElement('div'); name.className='account-name'; name.textContent=author.name;
    const email = document.createElement('small'); email.textContent=author.email || author.id; name.append(email);
    const relation = document.createElement('div'); relation.className='account-name';
    relation.textContent=root===author.id ? '主账号' : `关联到：${manifest.authors.find(a=>a.id===root).name}`;
    const actions = document.createElement('div'); actions.className='account-actions';
    const chooser=document.createElement('select'); chooser.hidden=true; chooser.setAttribute('aria-label',`将 ${author.id} 关联到主账号`);
    const placeholder=document.createElement('option'); placeholder.value='';placeholder.textContent='选择主账号…';chooser.append(placeholder);
    for (const main of roots.filter(a=>a.id!==root)) { const option=document.createElement('option');option.value=main.id;option.textContent=`${main.name} · ${main.email || main.id}`;chooser.append(option); }
    const apply=(action,target)=>{ draftLinks=changeAccount(manifest.authors,draftLinks,author.id,action,target);showAccounts();$('#account-status').textContent='关联配置已修改，点击仓库配置中的“生成可视化”后生效并保存。';$('#export').disabled=true; };
    chooser.addEventListener('change',()=>{if(chooser.value)apply('link',chooser.value);});
    for (const [title,action,disabled] of [['关联到','link',roots.every(a=>a.id===root)],['解除关联','unlink',root===author.id],['设为主账号','primary',root===author.id]]) {
      const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=title;button.disabled=disabled;
      button.addEventListener('click',()=>{if(action==='link'){chooser.hidden=!chooser.hidden;}else apply(action);});actions.append(button);
    }
    row.append(name,relation,actions,chooser);list.append(row);
  }
  $('#account-status').textContent=`${manifest.authors.length} 个账号 → ${roots.length} 位开发者。关联主账号会将该组一起归入目标主账号；解除关联仅拆出当前账号。`;
}
function showDetail() {
  const stats = $("#author-stats");
  const node = selectedAuthor && historyState(manifest,time).nodes.find(n=>n.id===selectedAuthor && n.commitCount);
  if (!node) { stats.textContent = "点击开发者球查看累计改动与最终存留。"; return; }
  stats.textContent = `${node.name} · 新增 ${node.additions.toLocaleString()} / 删除 ${node.deletions.toLocaleString()} / 改动 ${node.churn.toLocaleString()} · 占当前累计改动 ${(node.churn / Math.max(1, currentChurn) * 100).toFixed(1)}% · ${node.commitCount} 个提交`;
  if ([1,2].includes(manifest.retention?.version)) {
    stats.append(` · 当前已呈现的最终存留 ${node.retainedLines.toLocaleString()} / 作者最终存留 ${node.finalRetainedLines.toLocaleString()} · 作者占项目最终存留 ${(node.finalRetainedLines / Math.max(1,manifest.retention.totalLines) * 100).toFixed(1)}%`);
    if(manifest.retention.unmappedLines)stats.append(` · 项目有 ${manifest.retention.unmappedLines.toLocaleString()} 行未纳入贡献事件`);
  } else stats.append(' · 最终存留未分析，请重新生成');

}
let currentChurn = 0;
function handleCanvasClick(event) {
  const bounds = canvas.getBoundingClientRect();
  selectedAuthor = hitAuthor(manifest,time,(event.clientX-bounds.left)*1920/bounds.width,(event.clientY-bounds.top)*1080/bounds.height)?.id;
  showDetail();
}
function showSummary() {
  const values = [[(manifest.totalChurn || 0).toLocaleString('zh-CN'), '总变更'], [[1,2].includes(manifest.retention?.version) ? manifest.retention.totalLines.toLocaleString('zh-CN') : '未分析', '最终存留'], [manifest.commits.length, '非合并提交'], [prepareHistory(manifest).authors.length, '开发者']];
  $('#summary').innerHTML = values.map(([value, label]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join('');
  $('#extra-stats').textContent = `${[1,2].includes(manifest.retention?.version) ? (manifest.retention.unmappedLines || 0).toLocaleString('zh-CN')+' 行未纳入贡献事件' : '最终存留未分析'}`;
}
function handleLocalInput() {
  if ($("#source").value.trim()) {
    $("#remote-source").value = "";
    $("#status").textContent = "将使用输入的本地路径，点击“生成可视化”读取仓库。";
  }
}
async function handlePickLocal() {
  const button = $("#pick-local");
  button.disabled = true;
  try {
    const result = await (await fetch("/api/pick-local")).json();
    if (result.ok) {
      $("#source").value = result.path;
      $("#remote-source").value = "";
      $("#status").textContent = "已选择本地仓库，可以生成可视化。";
    } else if (!result.cancelled) {
      $("#status").textContent = result.error || "本地目录弹窗不可用。";
    }
  } catch (error) {
    $("#status").textContent = `选择失败：${error.message}`;
  } finally { button.disabled = false; }
}
async function handleGenerate(event) {
  event.preventDefault();
  const button = $("#analyze"), remote = $("#remote-source").value.trim();
  const source = remote || $("#source").value.trim();
  if (!source) {
    $("#status").textContent = "请输入本地仓库路径、选择文件夹，或在远程 GitLab 区域填写 URL。";
    return;
  }
  button.disabled = true;
  $("#status").textContent = "正在读取 Git 历史与最终存留归属…";
  try {
    const response = await fetch("/api/analyze", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, token: remote ? $("#token").value : "", branch: $("#branch").value,
        duration: $("#duration").value, timeZone: $("#time-zone").value.trim(), maxAuthors: $("#max-authors").value,
        accountLinks: source === manifest.project.repo || source === loadedSource ? draftLinks : undefined }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    manifest = result.manifest;
    loadedSource = source;
    draftLinks = accountLinks(manifest.authors,manifest.settings.accountLinks);
    showAccounts();
    selectedAuthor = null; playing = false; lastFrame = 0; time = 0;
    $("#play").textContent = "播放";
    $("#scrub").max = manifest.duration;
    $("#export").disabled = false;
    const cacheText = result.analysis?.cacheHit ? "命中缓存" : result.analysis?.incremental ? `增量分析 ${result.analysis.analyzedEvents} 个新事件` : "首次全量分析";
    $("#status").textContent = `已生成 ${manifest.commits.length} 个事件（${cacheText}）。Token 未写入项目文件。`;
    showSummary(); showHeading(); render();
    configOpen = false; showConfig();
  } catch (error) {
    $("#status").textContent = `生成失败：${error.message}`;
    if (focused) handleFocusView();
    configOpen = true; showConfig();
  } finally { button.disabled = false; }
}
function handleSeek() {
  playing = false;
  $("#play").textContent = "播放";
  time = Number($("#scrub").value);
  render();
}
function handlePlay() {
  if (!playing && time >= manifest.duration) { time = 0; render(); }
  playing = !playing;
  lastFrame = 0;
  $("#play").textContent = playing ? "暂停" : "播放";
}
async function handleExport() {
  const button = $("#export"); button.disabled = true; $("#export-status").textContent = "准备导出…";
  try {
    const response = await fetch("/api/export", { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ manifest }) });
    let file;
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
      const result = await response.json(); if (!result.ok) throw new Error(result.error); file = result.file;
    } else {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = '';
      const consume = line => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === 'start') $("#export-status").textContent = '准备导出…';
        else if (event.type === 'progress') $("#export-status").textContent = event.frame === event.total ? `画面已生成 ${event.frame}/${event.total} 帧（100%），正在完成编码…` : `正在导出 ${event.frame}/${event.total} 帧（${Math.floor(event.frame / event.total * 100)}%）`;
        else if (event.type === 'complete') file = event.file;
        else if (event.type === 'error') throw new Error(event.error);
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = pending.indexOf('\n')) !== -1) { const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1); consume(line); }
          if (done) { consume(pending); break; }
        }
      } finally { reader.releaseLock(); }
    }
    if (!file) throw new Error('导出连接中断，未收到完成结果，请重试');
    $("#export-status").innerHTML = `导出完成：<a href="${file}" download>下载 MP4</a>`;
  } catch (error) { $("#export-status").textContent = `导出失败：${error.message}`; }
  finally { button.disabled = false; }
}
if (manifest.version === 2) {
  $("#source").value = manifest.project.repo;
  if (manifest.project.source?.startsWith("http")) $("#remote-source").value = manifest.project.source;
  $("#branch").value = manifest.project.source?.startsWith("http") ? manifest.project.branch.replace(/^origin\//, "") : manifest.project.branch;
  $("#duration").value = manifest.duration;
  $("#time-zone").value = manifest.settings.timeZone;
  $("#max-authors").value = manifest.settings.maxAuthors;
  $("#scrub").max = manifest.duration;
  $("#export").disabled = false;
  $("#status").textContent = manifest.commits.length ? "已载入历史，可以播放或重新分析。" : "请选择本地仓库或输入远程 URL，生成可视化。";
}
$('#toggle-config').addEventListener('click', handleConfigToggle);
$('#focus-view').addEventListener('click', handleFocusView);
$('#fullscreen').addEventListener('click', handleFullscreen);
document.addEventListener('fullscreenchange', showFullscreen);
document.addEventListener('keydown', handleFullscreenKey);
$("#source").addEventListener("input", handleLocalInput);
$("#pick-local").addEventListener("click", handlePickLocal);
$("#form").addEventListener("submit", handleGenerate);
$("#scrub").addEventListener("input", handleSeek);
$("#play").addEventListener("click", handlePlay);
$("#export").addEventListener("click", handleExport);
canvas.addEventListener("click", handleCanvasClick);
showHeading(); showConfig(); render(); showSummary(); showAccounts(); requestAnimationFrame(tick);
