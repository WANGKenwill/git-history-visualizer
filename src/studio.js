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
function tick(now) { if (playing) { if (!lastFrame) lastFrame = now; time += (now - lastFrame) / 1000; if (time >= manifest.duration) { time = manifest.duration; playing = false; $("#play").textContent = tr('play'); } lastFrame = now; syncAudio(); render(); } else lastFrame = 0; requestAnimationFrame(tick); }
const messages = new Map();
let exportFile = null, accountsDirty = false, previousExport = false;
let statusLoading = true, exportRequestPending = false, recoveringExport = false, observedTaskId = null, observedTaskStage = null;
let audioRestoring = false;
const audioStorageKey = 'git-history-audio';
let selectedAudio = null, audioLoading = false, exporting = false;
const previewAudio = document.createElement('audio');
previewAudio.preload = 'auto'; previewAudio.loop = true;
$('#player').append(previewAudio);
function syncAudio(seek = false) {
  if (!playing) previewAudio.pause();
  if (!selectedAudio || previewAudio.readyState < 1) return;
  const target = time % previewAudio.duration;
  if (seek || Math.abs(previewAudio.currentTime - target) > 0.15) previewAudio.currentTime = target;
}
function playAudio() {
  if (!selectedAudio) return;
  syncAudio(true);
  const source = previewAudio.src;
  previewAudio.play().catch(error => {
    if (error.name === 'AbortError' || source !== previewAudio.src || !playing) return;
    playing = false; lastFrame = 0; previewAudio.pause();
    $('#play').textContent = tr('play');
    setMessage($('#player-status'), () => tr('audioPreviewFailed'));
  });
}
previewAudio.addEventListener('loadedmetadata', () => syncAudio(true));

function warnBeforeLeave(event) { event.preventDefault(); event.returnValue = ''; }
function updateAudioControls() {
  if (exporting) window.addEventListener('beforeunload', warnBeforeLeave);
  else window.removeEventListener('beforeunload', warnBeforeLeave);
  $('#audio-file').disabled = audioLoading || audioRestoring || exporting;
  $('#choose-audio').disabled = audioLoading || audioRestoring || exporting;
  $('#clear-audio').disabled = audioLoading || audioRestoring || exporting || !selectedAudio;
  $('#match-audio-duration').disabled = audioLoading || audioRestoring || exporting || generating || !selectedAudio || selectedAudio.duration < 15 || selectedAudio.duration > 180;
  $('#export').disabled = statusLoading || exporting || audioLoading || audioRestoring || accountsDirty || manifest.version !== 2;
}
function saveAudioSelection() {
  try {
    if (selectedAudio) sessionStorage.setItem(audioStorageKey, JSON.stringify({ id: selectedAudio.id, name: selectedAudio.name }));
    else sessionStorage.removeItem(audioStorageKey);
  } catch {}
}
function showAudioSelection() {
  const audio = selectedAudio;
  setMessage($('#audio-status'), () => tr('audioSelected', { name: audio.name, duration: audio.duration.toFixed(2) }) + (audio.duration < 15 || audio.duration > 180 ? ` ${tr('audioDurationRange')}` : ''));
}
function resetAudio(expired = false) {
  selectedAudio = null; audioRestoring = false; saveAudioSelection();
  previewAudio.pause(); previewAudio.removeAttribute('src'); previewAudio.load();
  setMessage($('#player-status'), () => '');
  setMessage($('#audio-status'), () => tr(expired ? 'error.audioMissing' : 'audioHelp'));
  updateAudioControls();
}
async function restoreAudio() {
  let stored;
  try { stored = JSON.parse(sessionStorage.getItem(audioStorageKey)); } catch { resetAudio(); return; }
  if (!stored?.id) { resetAudio(); return; }
  audioRestoring = true; updateAudioControls();
  try {
    const result = await (await fetch(`/api/audio/${encodeURIComponent(stored.id)}`)).json();
    if (!result.ok) {
      if (result.errorCode === 'error.audioMissing') { resetAudio(true); return; }
      throw apiError(result);
    }
    selectedAudio = { id: result.id, duration: result.duration, name: stored.name };
    previewAudio.src = `/api/audio/${encodeURIComponent(result.id)}/file`;
    audioRestoring = false; showAudioSelection(); updateAudioControls();
    if (playing) playAudio();
  } catch {
    setMessage($('#audio-status'), () => tr('audioRecovering'));
    setTimeout(restoreAudio, 1000);
  }
}
function showTask(task) {
  exportFile = null; previousExport = true;
  exporting = ['preparing', 'rendering', 'encoding'].includes(task.stage);
  if (task.stage === 'preparing') setMessage($('#export-status'), () => tr('exportPreparing'));
  else if (task.stage === 'rendering') setMessage($('#export-status'), () => tr('exportFrames', { done: task.frame, total: task.total, percent: Math.floor(task.frame / task.total * 100) }));
  else if (task.stage === 'encoding') setMessage($('#export-status'), () => tr('exportEncoding', { done: task.frame, total: task.total }));
  else if (task.stage === 'complete') {
    setMessage($('#export-status'), () => `${tr('previousExportComplete')} `);
    exportFile = task.file; showExportLink();
  } else {
    setMessage($('#export-status'), () => tr('exportFailed', { error: tr(task.errorCode || 'error.unknown', task.errorParams) }));
    if (task.errorCode === 'error.audioMissing' && task.audioId === selectedAudio?.id) resetAudio(true);
  }
}
async function refreshExportStatus() {
  try {
    if (exportRequestPending) return;
    const result = await (await fetch('/api/export/status')).json();
    if (!result.ok) throw apiError(result);
    if (exportRequestPending) return;
    const wasLoading = statusLoading;
    statusLoading = false;
    if (result.task && (result.task.id !== observedTaskId || result.task.stage !== observedTaskStage || exporting || recoveringExport || wasLoading)) {
      observedTaskId = result.task.id; observedTaskStage = result.task.stage; showTask(result.task);
    } else if (!result.task && recoveringExport) {
      exporting = false;
      setMessage($('#export-status'), () => tr('exportFailed', { error: tr('exportInterrupted') }));
    }
    if (!result.task && wasLoading && !recoveringExport) setMessage($('#export-status'), () => '');
    recoveringExport = false;
    updateAudioControls();
  } catch {
    statusLoading = true;
    setMessage($('#export-status'), () => tr('exportRecovering'));
    updateAudioControls();
  } finally { setTimeout(refreshExportStatus, 1000); }
}
async function handleAudioFile() {
  const file = $('#audio-file').files[0];
  if (!file || audioRestoring || exporting) return;
  audioLoading = true; updateAudioControls();
  setMessage($('#audio-status'), () => tr('audioLoading'));
  try {
    if (file.size > 100 * 1024 * 1024) throw new AppError('error.audioTooLarge');
    const response = await fetch('/api/audio', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
    const result = await response.json();
    if (!result.ok) throw apiError(result);
    const previous = selectedAudio;
    selectedAudio = { id: result.id, duration: result.duration, name: file.name };
    previewAudio.pause();
    previewAudio.src = `/api/audio/${encodeURIComponent(result.id)}/file`;
    saveAudioSelection();
    setMessage($('#player-status'), () => '');
    if (playing) playAudio();
    if (previous) await fetch(`/api/audio/${previous.id}`, { method: 'DELETE' }).catch(console.error);
    showAudioSelection();
  } catch (error) {
    setMessage($('#audio-status'), () => tr('audioFailed', { error: errorMessage(error) }) + (selectedAudio ? ` ${tr('audioSelected', { name: selectedAudio.name, duration: selectedAudio.duration.toFixed(2) })}` : ''));
  } finally { $('#audio-file').value = ''; audioLoading = false; updateAudioControls(); }
}
async function handleClearAudio() {
  if (exporting || audioRestoring || !selectedAudio) return;
  audioLoading = true; updateAudioControls();
  try {
    const result = await (await fetch(`/api/audio/${selectedAudio.id}`, { method: 'DELETE' })).json();
    if (!result.ok) throw apiError(result);
    resetAudio();
  } catch (error) {
    setMessage($('#audio-status'), () => tr('audioFailed', { error: errorMessage(error) }));
  } finally { audioLoading = false; updateAudioControls(); }
}
function handleMatchAudioDuration() {
  if (!selectedAudio || $('#match-audio-duration').disabled) return;
  const duration = selectedAudio.duration;
  $('#duration').value = duration;
  manifest = { ...manifest, duration, commits: normalizedTimeline(manifest.commits, duration) };
  playing = false; lastFrame = 0; time = 0; syncAudio(true);
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
  const link = document.createElement('a'); link.href = exportFile; link.download = ''; link.textContent = tr(previousExport ? 'downloadPreviousVideo' : 'downloadVideo');
  $('#export-status').append(link);
}
const commonTimeZones = ['Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'Europe/London', 'America/New_York'];
const timeZoneCities = { 'Asia/Shanghai': 'timeZoneBeijing', 'UTC': 'timeZoneUTC', 'Asia/Tokyo': 'timeZoneTokyo', 'Europe/London': 'timeZoneLondon', 'America/New_York': 'timeZoneNewYork' };
const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let timeZoneOptions = [];
function updateTimeZones(selected = $('#time-zone').value || localTimeZone) {
  try { new Intl.DateTimeFormat(locale, { timeZone: selected }); } catch { selected = localTimeZone; }
  const zones = [...new Set([...commonTimeZones, ...Intl.supportedValuesOf('timeZone'), selected])];
  const now = new Date();
  timeZoneOptions = zones.map(id => {
    const city = timeZoneCities[id] ? tr(timeZoneCities[id]) : id.split('/').at(-1).replaceAll('_', ' ');
    const offsetName = new Intl.DateTimeFormat('en', { timeZone: id, timeZoneName: 'shortOffset' }).formatToParts(now).find(part => part.type === 'timeZoneName').value;
    const match = /^GMT([+-])(\d+)(?::(\d+))?$/.exec(offsetName);
    const offset = match ? `UTC${match[1]}${match[2].padStart(2, '0')}:${(match[3] || '00').padStart(2, '0')}` : 'UTC+00:00';
    return { id, label: `${city} · ${offset} · ${id}`, common: commonTimeZones.includes(id), search: `${city} ${id.replaceAll('_', ' ')} ${id} ${offset} ${id === 'Asia/Shanghai' ? '上海 Beijing Shanghai' : ''}`.toLowerCase() };
  });
  filterTimeZones(selected);
}
function filterTimeZones(selected = $('#time-zone').value) {
  const query = $('#time-zone-search').value.trim().toLowerCase();
  const matches = timeZoneOptions.filter(option => option.search.includes(query));
  const select = $('#time-zone'); select.replaceChildren();
  const addGroup = (label, options) => {
    if (!options.length) return;
    const group = document.createElement('optgroup'); group.label = tr(label);
    for (const option of options) group.append(new Option(option.label, option.id));
    select.append(group);
  };
  if (!matches.some(option => option.id === selected)) addGroup('timeZoneSelected', timeZoneOptions.filter(option => option.id === selected));
  addGroup('timeZoneCommon', matches.filter(option => option.common));
  addGroup('timeZoneAll', matches.filter(option => !option.common));
  select.value = selected;
  select.title = select.selectedOptions[0]?.textContent || '';
  $('#time-zone-results').hidden = !query;
  setMessage($('#time-zone-results'), () => tr(matches.length ? 'timeZoneMatches' : 'timeZoneNoMatches', { count: matches.length }));
}
function changeLanguage() {
  locale = normalizeLocale($('#language').value);
  try { localStorage.setItem('git-history-locale', locale); } catch {}
  manifest = { ...manifest, settings: { ...manifest.settings, locale } };
  applyTranslations(document, locale);
  updateTimeZones();
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
    selectedAuthor = null; playing = false; lastFrame = 0; time = 0; syncAudio(true);
    $("#play").textContent = tr('play');
    $("#scrub").max = manifest.duration;
    updateAudioControls();
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
  lastFrame = 0; syncAudio(true);
  render();
}
function handlePlay() {
  if (!playing && time >= manifest.duration) { time = 0; render(); }
  playing = !playing;
  lastFrame = 0;
  $("#play").textContent = playing ? tr('pause') : tr('play');
  if (playing) { setMessage($('#player-status'), () => ''); playAudio(); }
  else syncAudio(true);
}
async function handleExport() {
  if (statusLoading || exporting || audioLoading || audioRestoring || accountsDirty) return;
  exportFile = null; previousExport = false; recoveringExport = false; exportRequestPending = true;
  exporting = true; updateAudioControls(); setMessage($("#export-status"), () => tr('exportPreparing'));
  try {
    const response = await fetch("/api/export", { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ manifest, audioId: selectedAudio?.id }) });
    let file;
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
      const result = await response.json(); if (!result.ok) throw apiError(result); file = result.file;
    } else {
      await readEvents(response, event => {
        if (event.type === 'start' && event.taskId) { observedTaskId = event.taskId; observedTaskStage = 'preparing'; }
        if (event.type === 'start') setMessage($("#export-status"), () => tr('exportPreparing'));
        else if (event.type === 'progress') setMessage($("#export-status"), () => event.frame === event.total ? tr('exportEncoding', { done: event.frame, total: event.total }) : tr('exportFrames', { done: event.frame, total: event.total, percent: Math.floor(event.frame / event.total * 100) }));
        else if (event.type === 'complete') file = event.file;
        else if (event.type === 'error') throw apiError(event);
      });
    }
    if (!file) throw new AppError('exportInterrupted');
    setMessage($('#export-status'), () => `${tr('exportComplete')} `);
    exportFile = file; observedTaskStage = 'complete'; showExportLink();
  } catch (error) {
    if (error instanceof AppError && error.code !== 'exportInterrupted' && error.code !== 'error.exportBusy') {
      if (error.code === 'error.audioMissing') resetAudio(true);
      setMessage($('#export-status'), () => tr('exportFailed', { error: errorMessage(error) }));
    } else {
      recoveringExport = true; statusLoading = true;
      setMessage($('#export-status'), () => tr('exportRecovering'));
    }
  } finally {
    exportRequestPending = false;
    if (!recoveringExport) exporting = false;
    updateAudioControls();
  }
}
applyTranslations(document, locale);
if (manifest.version === 2) {
  $("#source").value = manifest.project.source?.startsWith("http") ? "" : manifest.project.repo || "";
  if (manifest.project.source?.startsWith("http")) $("#remote-source").value = manifest.project.source;
  $("#duration").value = manifest.duration;
  updateTimeZones(manifest.settings.timeZone);
  $("#max-authors").value = manifest.settings.maxAuthors;
  $("#scrub").max = manifest.duration;
  updateAudioControls();
  setMessage($("#status"), () => manifest.commits.length ? tr('loaded') : tr('chooseRepository'));
}
if (manifest.version !== 2) updateTimeZones();
$('#time-zone-search').addEventListener('input', () => filterTimeZones());
$('#time-zone').addEventListener('change', () => { $('#time-zone-search').value = ''; filterTimeZones(); });
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

restoreAudio();
refreshExportStatus();
