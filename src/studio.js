import { t, normalizeLocale, preferredLocale, applyTranslations, AppError } from './i18n.js';
import { drawHistory, hitAuthor, prepareHistory, historyState } from "./visualizer.js";
import { accountLinks, changeAccount } from "./accounts.js";
import { normalizedTimeline } from './timeline.js';
let locale = preferredLocale();
const tr = (key, params) => t(locale, key, params);
const number = value => new Intl.NumberFormat(locale).format(value);
const $ = (selector) => document.querySelector(selector);
const canvas = $("#preview"); const ctx = canvas.getContext("2d");
const fallback = { project: { name: "Git history", branch: "main" }, duration: 60, commits: [], groups: [], settings: { timeZone: "Asia/Shanghai", maxAuthors: 16 }, totalChurn: 0, authors: [], initialLines: 0, totalLines: 0 };
let manifest = window.__GIT_MANIFEST__?.version === 2 ? window.__GIT_MANIFEST__ : fallback; manifest = { ...manifest, settings: { ...manifest.settings, locale } }; let time = 0; let playing = false; let lastFrame = 0;
function render() { const nodes = drawHistory(ctx, manifest, time); currentChurn = nodes.reduce((sum,n)=>sum+n.churn,0); showDetail(); $("#scrub").value = time; $("#time-label").textContent = `${time.toFixed(1)}s / ${manifest.duration}s`; }
function tick(now) { if (playing) { if (!lastFrame) lastFrame = now; time += (now - lastFrame) / 1000; if (time >= manifest.duration) { time = manifest.duration; playing = false; $("#play").textContent = tr('play'); } lastFrame = now; render(); } else lastFrame = 0; requestAnimationFrame(tick); }
const messages = new Map();
let exportFile = null, accountsDirty = false;
let selectedAudio = null, audioLoading = false, exporting = false;
function updateAudioControls() {
  $('#audio-file').disabled = audioLoading || exporting;
  $('#choose-audio').disabled = audioLoading || exporting;
  $('#clear-audio').disabled = audioLoading || exporting || !selectedAudio;
  $('#match-audio-duration').disabled = audioLoading || exporting || generating || !selectedAudio || selectedAudio.duration < 15 || selectedAudio.duration > 180;
  $('#export').disabled = exporting || audioLoading || accountsDirty || manifest.version !== 2;
}
async function handleAudioFile() {
  const file = $('#audio-file').files[0];
  if (!file) return;
  audioLoading = true; updateAudioControls();
  setMessage($('#audio-status'), () => tr('audioLoading'));
  try {
    if (file.size > 100 * 1024 * 1024) throw new AppError('error.audioTooLarge');
    const response = await fetch('/api/audio', { method: 'POST', body: file });
    const result = await response.json();
    if (!result.ok) throw apiError(result);
    const previous = selectedAudio;
    selectedAudio = { id: result.id, duration: result.duration, name: file.name };
    if (previous) await fetch(`/api/audio/${previous.id}`, { method: 'DELETE' }).catch(console.error);
    const audio = selectedAudio;
    setMessage($('#audio-status'), () => tr('audioSelected', { name: audio.name, duration: audio.duration.toFixed(2) }) + (audio.duration < 15 || audio.duration > 180 ? ` ${tr('audioDurationRange')}` : ''));
  } catch (error) {
    setMessage($('#audio-status'), () => tr('audioFailed', { error: errorMessage(error) }) + (selectedAudio ? ` ${tr('audioSelected', { name: selectedAudio.name, duration: selectedAudio.duration.toFixed(2) })}` : ''));
  } finally { $('#audio-file').value = ''; audioLoading = false; updateAudioControls(); }
}
async function handleClearAudio() {
  const audio = selectedAudio; selectedAudio = null;
  setMessage($('#audio-status'), () => tr('audioHelp')); updateAudioControls();
  if (audio) await fetch(`/api/audio/${audio.id}`, { method: 'DELETE' }).catch(console.error);
}
function handleMatchAudioDuration() {
  if (!selectedAudio || $('#match-audio-duration').disabled) return;
  const duration = selectedAudio.duration;
  $('#duration').value = duration;
  manifest = { ...manifest, duration, commits: normalizedTimeline(manifest.commits, duration) };
  playing = false; lastFrame = 0; time = 0;
  $('#play').textContent = tr('play'); $('#scrub').max = duration;
  exportFile = null; setMessage($('#export-status'), () => '');
  render();
}
function setMessage(element, render) { messages.set(element, render); element.textContent = render(); }
function apiError(result) {
  if (!result.errorCode) console.error(result.error);
  return new AppError(result.errorCode || 'error.unknown', result.errorParams);
}
function errorMessage(error) {
  if (error instanceof AppError) return tr(error.code, error.params);
  console.error(error); return tr('error.unknown');
}
function showExportLink() {
  if (!exportFile) return;
  const link = document.createElement('a'); link.href = exportFile; link.download = ''; link.textContent = tr('downloadVideo');
  $('#export-status').append(link);
}
function changeLanguage() {
  locale = normalizeLocale($('#language').value);
  try { localStorage.setItem('git-history-locale', locale); } catch {}
  manifest = { ...manifest, settings: { ...manifest.settings, locale } };
  applyTranslations(document, locale);
  for (const [element, render] of messages) element.textContent = render();
  showExportLink(); showAccounts(); showSummary(); showFullscreen(); updateBranchControls();
  $('#play').textContent = tr(playing ? 'pause' : 'play');
  if (!branchesReady) $('#branch option').textContent = tr('branchesPlaceholder');
  render();
}
let selectedAuthor = null;
let loadedSource = manifest.project.source || manifest.project.repo;
let draftLinks = accountLinks(manifest.authors, manifest.settings?.accountLinks);
async function handleFullscreen() {
  setMessage($('#player-status'), () => '');
  try {
    if (document.fullscreenElement === $('#player')) await document.exitFullscreen();
    else await $('#player').requestFullscreen();
  } catch (error) { setMessage($('#player-status'), () => tr('fullscreenFailed', { error: errorMessage(error) })); }
}
function showFullscreen() {
  const fullscreen = document.fullscreenElement === $('#player');
  $('#fullscreen').textContent = fullscreen ? tr('exitFullscreen') : tr('fullscreen');
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
  const list = $('#account-list');
  const open = [...list.querySelectorAll('select')].map(el => !el.hidden); list.replaceChildren();
  const roots = manifest.authors.filter(a => !draftLinks[a.id]);
  for (const [index, author] of manifest.authors.entries()) {
    const root = draftLinks[author.id] || author.id;
    const row = document.createElement('div'); row.className='account-row';
    const name = document.createElement('div'); name.className='account-name'; name.textContent=author.name;
    const email = document.createElement('small'); email.textContent=author.email || author.id; name.append(email);
    const relation = document.createElement('div'); relation.className='account-name';
    relation.textContent=root===author.id ? tr('primaryAccount') : tr('linkedAccount', { name: manifest.authors.find(a=>a.id===root).name });
    const actions = document.createElement('div'); actions.className='account-actions';
    const chooser=document.createElement('select'); chooser.hidden=!open[index]; chooser.setAttribute('aria-label',tr('linkLabel', { account: author.id }));
    const placeholder=document.createElement('option'); placeholder.value='';placeholder.textContent=tr('choosePrimary');chooser.append(placeholder);
    for (const main of roots.filter(a=>a.id!==root)) { const option=document.createElement('option');option.value=main.id;option.textContent=`${main.name} · ${main.email || main.id}`;chooser.append(option); }
    const apply=(action,target)=>{ accountsDirty=true; draftLinks=changeAccount(manifest.authors,draftLinks,author.id,action,target);showAccounts();setMessage($('#account-status'), () => tr('accountsChanged'));$('#export').disabled=true; };
    chooser.addEventListener('change',()=>{if(chooser.value)apply('link',chooser.value);});
    for (const [title,action,disabled] of [[tr('linkAccount'),'link',roots.every(a=>a.id===root)],[tr('unlinkAccount'),'unlink',root===author.id],[tr('makePrimary'),'primary',root===author.id]]) {
      const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=title;button.disabled=disabled;
      button.addEventListener('click',()=>{if(action==='link'){chooser.hidden=!chooser.hidden;}else apply(action);});actions.append(button);
    }
    row.append(name,relation,actions,chooser);list.append(row);
  }
  if (!accountsDirty) setMessage($('#account-status'), () => tr('accountsSummary', { accounts: manifest.authors.length, developers: roots.length }));
}
function showDetail() {
  const stats = $("#author-stats");
  const node = selectedAuthor && historyState(manifest,time).nodes.find(n=>n.id===selectedAuthor && n.commitCount);
  if (!node) { stats.textContent = tr('authorHint'); return; }
  stats.textContent = tr('authorDetail', { name: node.name, added: node.additions.toLocaleString(locale), deleted: node.deletions.toLocaleString(locale), changes: node.churn.toLocaleString(locale), share: (node.churn / Math.max(1, currentChurn) * 100).toFixed(1), commits: node.commitCount });
  if ([1,2].includes(manifest.retention?.version)) {
    stats.append(tr('retentionDetail', { shown: node.retainedLines.toLocaleString(locale), final: node.finalRetainedLines.toLocaleString(locale), share: (node.finalRetainedLines / Math.max(1,manifest.retention.totalLines) * 100).toFixed(1) }));
    if(manifest.retention.unmappedLines)stats.append(tr('unmappedDetail', { count: manifest.retention.unmappedLines.toLocaleString(locale) }));
  } else stats.append(tr('retentionDetailMissing'));

}
let currentChurn = 0;
function handleCanvasClick(event) {
  const bounds = canvas.getBoundingClientRect();
  selectedAuthor = hitAuthor(manifest,time,(event.clientX-bounds.left)*1920/bounds.width,(event.clientY-bounds.top)*1080/bounds.height)?.id;
  showDetail();
}
function showSummary() {
  const values = [[(manifest.totalChurn || 0).toLocaleString(locale), tr('totalChurn')], [[1,2].includes(manifest.retention?.version) ? manifest.retention.totalLines.toLocaleString(locale) : tr('notAnalyzed'), tr('retention')], [number(manifest.commits.length), tr('commits')], [number(prepareHistory(manifest).authors.length), tr('authors')]];
  $('#summary').innerHTML = values.map(([value, label]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join('');
  $('#extra-stats').textContent = `${[1,2].includes(manifest.retention?.version) ? tr('unmappedLines', {count: number(manifest.retention.unmappedLines || 0)}) : tr('retentionMissing')}`;
}
let branchRequest = 0, branchesReady = false, readingBranches = false, generating = false, shallow = false, completingHistory = false;
function updateBranchControls() {
  for (const selector of ['#source', '#remote-source', '#token']) $(selector).disabled = completingHistory;
  $("#unshallow").disabled = completingHistory || readingBranches || !shallow;
  $("#retry-branches").disabled = completingHistory || readingBranches;
  $("#copy-unshallow").disabled = completingHistory;
  $("#unshallow").textContent = completingHistory ? tr('unshallowProgress') : tr('unshallow');
  $("#analyze").disabled = generating || completingHistory || !branchesReady || shallow;
  $("#branch").disabled = generating || completingHistory || !branchesReady;
  $("#read-branches").disabled = generating || completingHistory || readingBranches || (!$("#remote-source").value.trim() && !shallow);
  updateAudioControls();
}
function clearBranches() {
  branchRequest++;
  branchesReady = false; readingBranches = false; shallow = false;
  $("#shallow-warning").hidden = true;
  $("#branch").replaceChildren(new Option(tr('branchesPlaceholder'), ""));
  updateBranchControls();
}
async function handleReadBranches() {
  const remote = $("#remote-source").value.trim();
  const source = remote || $("#source").value.trim();
  clearBranches();
  if (!source) return;
  const request = branchRequest;
  readingBranches = true; updateBranchControls();
  setMessage($("#status"), () => tr('readingBranches'));
  try {
    const response = await fetch("/api/branches", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, token: remote ? $("#token").value : "" }),
    });
    const result = await response.json();
    if (request !== branchRequest) return;
    if (!result.ok) throw apiError(result);
    if (!result.branches.length) throw new AppError('noBranches');
    $("#branch").replaceChildren(...result.branches.map(branch => new Option(branch, branch)));
    const preferred = remote ? manifest.project.branch.replace(/^origin\//, "") : manifest.project.branch;
    $("#branch").value = (source === loadedSource || (!remote && source === manifest.project.repo)) && result.branches.includes(preferred) ? preferred : result.defaultBranch;
    shallow = result.shallow === true;
    $("#shallow-warning").hidden = !shallow;
    branchesReady = true;
    if ($("#status").textContent === tr('readingBranches')) setMessage($("#status"), () => tr('branchesReady'));
  } catch (error) {
    if (request === branchRequest && $("#status").textContent === tr('readingBranches')) setMessage($("#status"), () => tr('branchesFailed', { error: errorMessage(error) }));
  } finally {
    if (request === branchRequest) { readingBranches = false; updateBranchControls(); }
  }
}
async function handleCompleteHistory() {
  const source = $("#source").value.trim(), selectedBranch = $("#branch").value;
  if (!shallow || completingHistory || !source || $("#remote-source").value.trim()) return;
  completingHistory = true; $("#pick-local").disabled = true; updateBranchControls();
  setMessage($("#status"), () => tr('unshallowStarting'));
  try {
    const response = await fetch("/api/unshallow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) });
    const result = await response.json();
    if (!result.ok) throw apiError(result);
    await handleReadBranches();
    if (branchesReady && !shallow) {
      if ([...$("#branch").options].some(option => option.value === selectedBranch)) $("#branch").value = selectedBranch;
      setMessage($("#status"), () => tr('unshallowComplete'));
    }
  } catch (error) { setMessage($("#status"), () => tr('unshallowFailed', { error: errorMessage(error) })); }
  finally { completingHistory = false; $("#pick-local").disabled = false; updateBranchControls(); }
}

function handleLocalInput() {
  if ($("#source").value.trim()) $("#remote-source").value = "";
  clearBranches();
  setMessage($("#status"), () => tr('localInput'));
}
function handleRemoteInput() {
  if ($("#remote-source").value.trim()) $("#source").value = "";
  clearBranches();
  setMessage($("#status"), () => tr('remoteInput'));
}
async function handlePickLocal() {
  const button = $("#pick-local");
  button.disabled = true;
  try {
    const result = await (await fetch("/api/pick-local", { headers: { "accept-language": locale } })).json();
    if (result.ok) {
      $("#source").value = result.path;
      $("#remote-source").value = "";
      await handleReadBranches();
    } else if (!result.cancelled) {
      setMessage($("#status"), () => errorMessage(apiError(result)));
    }
  } catch (error) {
    setMessage($("#status"), () => tr('folderFailed', { error: errorMessage(error) }));
  } finally { button.disabled = false; }
}
async function readEvents(response, consume) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '';
  const line = value => { if (value.trim()) consume(JSON.parse(value)); };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf('\n')) !== -1) { line(pending.slice(0, boundary)); pending = pending.slice(boundary + 1); }
      if (done) { line(pending); break; }
    }
  } finally { reader.releaseLock(); }
}

async function handleGenerate(event) {
  event.preventDefault();
  const remote = $("#remote-source").value.trim();
  const source = remote || $("#source").value.trim();
  if (!source) {
    setMessage($("#status"), () => tr('sourceRequired'));
    return;
  }
  if (!branchesReady || !$("#branch").value || generating || shallow || completingHistory) return;
  generating = true; updateBranchControls();
  setMessage($("#status"), () => tr('analyzing'));
  try {
    const response = await fetch("/api/analyze", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ source, token: remote ? $("#token").value : "", branch: $("#branch").value,
        locale, duration: $("#duration").value, timeZone: $("#time-zone").value.trim(), maxAuthors: $("#max-authors").value,
        accountLinks: source === manifest.project.repo || source === loadedSource ? draftLinks : undefined }),
    });
    let result;
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) result = await response.json();
    else await readEvents(response, event => {
      if (event.type === 'error') throw apiError(event);
      if (event.type === 'complete') result = event;
      if (event.type === 'progress') {
        const labels = { repository: 'repositoryProgress', download: 'downloadProgress', history: 'historyProgress', changes: 'changesProgress', retention: 'retentionProgress', layout: 'layoutProgress' };
        setMessage($("#status"), () => event.cacheHit ? tr('retentionCache') : event.stage === 'retention' && Number.isInteger(event.completed) ? tr('retentionFiles', { done: event.completed, total: event.total }) : tr(labels[event.stage] || 'analysisProgress'));
      }
    });
    if (!result) throw new AppError('analysisInterrupted');
    if (!result.ok) throw apiError(result);
    manifest = { ...result.manifest, settings: { ...result.manifest.settings, locale } };
    loadedSource = source;
    accountsDirty = false; draftLinks = accountLinks(manifest.authors,manifest.settings.accountLinks);
    showAccounts();
    selectedAuthor = null; playing = false; lastFrame = 0; time = 0;
    $("#play").textContent = tr('play');
    $("#scrub").max = manifest.duration;
    $("#export").disabled = false;
    const cacheText = () => result.analysis?.cacheHit ? tr('cacheHit') : result.analysis?.incremental ? tr('incrementalAnalysis', { count: result.analysis.analyzedEvents }) : tr('fullAnalysis');
    setMessage($("#status"), () => tr('analysisComplete', { count: manifest.commits.length, cache: cacheText() }));
    showSummary(); showHeading(); render();
  } catch (error) {
    setMessage($("#status"), () => tr('analysisFailed', { error: errorMessage(error) }));
  } finally { generating = false; updateBranchControls(); }
}
function handleSeek() {
  playing = false;
  $("#play").textContent = tr('play');
  time = Number($("#scrub").value);
  render();
}
function handlePlay() {
  if (!playing && time >= manifest.duration) { time = 0; render(); }
  playing = !playing;
  lastFrame = 0;
  $("#play").textContent = playing ? tr('pause') : tr('play');
}
async function handleExport() {
  if (exporting || audioLoading || accountsDirty) return;
  exportFile = null;
  exporting = true; updateAudioControls(); setMessage($("#export-status"), () => tr('exportPreparing'));
  try {
    const response = await fetch("/api/export", { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ manifest, audioId: selectedAudio?.id }) });
    let file;
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
      const result = await response.json(); if (!result.ok) throw apiError(result); file = result.file;
    } else {
      await readEvents(response, event => {
        if (event.type === 'start') setMessage($("#export-status"), () => tr('exportPreparing'));
        else if (event.type === 'progress') setMessage($("#export-status"), () => event.frame === event.total ? tr('exportEncoding', { done: event.frame, total: event.total }) : tr('exportFrames', { done: event.frame, total: event.total, percent: Math.floor(event.frame / event.total * 100) }));
        else if (event.type === 'complete') file = event.file;
        else if (event.type === 'error') throw apiError(event);
      });
    }
    if (!file) throw new AppError('exportInterrupted');
    setMessage($('#export-status'), () => `${tr('exportComplete')} `);
    exportFile = file; showExportLink();
  } catch (error) { setMessage($("#export-status"), () => tr('exportFailed', { error: errorMessage(error) })); }
  finally { exporting = false; updateAudioControls(); }
}
applyTranslations(document, locale);
if (manifest.version === 2) {
  $("#source").value = manifest.project.source?.startsWith("http") ? "" : manifest.project.repo || "";
  if (manifest.project.source?.startsWith("http")) $("#remote-source").value = manifest.project.source;
  $("#duration").value = manifest.duration;
  $("#time-zone").value = manifest.settings.timeZone;
  $("#max-authors").value = manifest.settings.maxAuthors;
  $("#scrub").max = manifest.duration;
  $("#export").disabled = false;
  setMessage($("#status"), () => manifest.commits.length ? tr('loaded') : tr('chooseRepository'));
}
$('#language').value = locale;
$('#language').addEventListener('change', changeLanguage);
$('#fullscreen').addEventListener('click', handleFullscreen);
document.addEventListener('fullscreenchange', showFullscreen);
document.addEventListener('keydown', handleFullscreenKey);
$("#source").addEventListener("input", handleLocalInput);
$("#source").addEventListener("blur", () => { if (!$("#remote-source").value.trim() && !branchesReady && !readingBranches) handleReadBranches(); });
$("#remote-source").addEventListener("input", handleRemoteInput);
$("#token").addEventListener("input", () => { if ($("#remote-source").value.trim()) handleRemoteInput(); });
$("#read-branches").addEventListener("click", handleReadBranches);
$("#copy-unshallow").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText("git fetch --unshallow"); setMessage($("#status"), () => tr('commandCopied')); }
  catch { setMessage($("#status"), () => tr('copyFailed')); }
});
$("#retry-branches").addEventListener("click", handleReadBranches);
$("#unshallow").addEventListener("click", handleCompleteHistory);
$("#pick-local").addEventListener("click", handlePickLocal);
$("#form").addEventListener("submit", handleGenerate);
$("#scrub").addEventListener("input", handleSeek);
$("#play").addEventListener("click", handlePlay);
$("#export").addEventListener("click", handleExport);
$('#audio-file').addEventListener('change', handleAudioFile);
$('#choose-audio').addEventListener('click', () => $('#audio-file').click());
$('#clear-audio').addEventListener('click', handleClearAudio);
$('#match-audio-duration').addEventListener('click', handleMatchAudioDuration);
canvas.addEventListener("click", handleCanvasClick);
showHeading(); render(); showSummary(); showAccounts(); requestAnimationFrame(tick);

updateBranchControls();
if ($("#source").value.trim() && !$("#remote-source").value.trim()) handleReadBranches();
