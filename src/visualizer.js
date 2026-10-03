import { precomputeMotion, motionPosition, safetyRadius } from './motion.js';
import { groupedAuthors } from './accounts.js';
export const WIDTH = 1920;
export const HEIGHT = 1080;
const CX = 960, CY = 555, RX = 735, RY = 355;
const FLIGHT = 1.65;
const prepared = new WeakMap();
const clocks = new WeakMap();
const clamp = (v) => Math.max(0, Math.min(1, v));
const number = (v) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(v);

function hash(value) {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function clockFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}
function clockParts(timestamp, formatter) {
  const parts = formatter.formatToParts(new Date(timestamp));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { day: Date.UTC(get('year'), get('month') - 1, get('day')) / 86400000,
    hour: get('hour') + get('minute') / 60 + (get('second') + ((timestamp % 1000 + 1000) % 1000) / 1000) / 3600 };
}
export function clockAngle(timestamp, timeZone = 'Asia/Shanghai') {
  return Math.PI / 2 + clockParts(new Date(timestamp).getTime(), clockFormatter(timeZone)).hour * Math.PI / 12;
}

// Find local date boundaries by epoch time, including 23/25-hour dates.
function dayBoundary(timestamp, day, formatter) {
  let low = timestamp - 48 * 3600000, high = timestamp + 48 * 3600000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (clockParts(middle, formatter).day < day) low = middle;
    else high = middle;
  }
  return high;
}
function prepareClock(manifest) {
  if (clocks.has(manifest)) return clocks.get(manifest);
  const timeZone = manifest.settings?.timeZone || 'Asia/Shanghai';
  const formatter = clockFormatter(timeZone);
  const points = (manifest.commits || []).map(c => ({ at: c.at, timestamp: Date.parse(c.authoredAt) }));
  const spans = points.slice(1).map((end, i) => {
    const start = points[i];
    const startDay = clockParts(start.timestamp, formatter).day, endDay = clockParts(end.timestamp, formatter).day;
    const skippedDays = Math.max(0, endDay - startDay - 1);
    const firstEnd = skippedDays ? dayBoundary(start.timestamp, startDay + 1, formatter) : end.timestamp;
    const lastStart = skippedDays ? dayBoundary(end.timestamp, endDay, formatter) : end.timestamp;
    return { firstEnd, lastStart, skippedDays, firstDuration: firstEnd - start.timestamp,
      retainedDuration: firstEnd - start.timestamp + end.timestamp - lastStart };
  });
  const result = { points, spans, formatter, label: new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) };
  clocks.set(manifest, result); return result;
}

export function clockState(manifest, time) {
  const { points, spans, formatter, label } = prepareClock(manifest);
  if (!points.length) return null;
  // Upper bound handles simultaneous commits and seeks without frame history.
  let low = 0, high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].at <= time) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, low - 1), start = points[index], end = points[index + 1];
  let timestamp = start.timestamp, skippedDays = 0;
  if (time >= start.at && end && end.at > start.at) {
    const span = spans[index], progress = clamp((time - start.at) / (end.at - start.at));
    const elapsed = Math.round(progress * span.retainedDuration);
    timestamp = elapsed < span.firstDuration ? start.timestamp + elapsed : span.lastStart + elapsed - span.firstDuration;
    skippedDays = span.skippedDays;
  }
  const angle = Math.PI / 2 + clockParts(timestamp, formatter).hour * Math.PI / 12;
  return { timestamp, angle, skippedDays, label: label.format(new Date(timestamp)) };
}

function pack(authors, previousPositions = {}) {
  const max = Math.max(1, ...authors.map((a) => a.churn));
  for (let scale = 132; scale > 10; scale *= .9) {
    const placed = [];
    for (const author of [...authors].sort((a,b)=>Number(Boolean(previousPositions[b.id]))-Number(Boolean(previousPositions[a.id])) || b.churn-a.churn || a.id.localeCompare(b.id))) {
      const radius = author.churn ? Math.sqrt(author.churn / max) * scale : 0;
      // Reserve a legible nameplate even for very small contributors.
      const envelope = Math.max(radius + 12, 47);
      let position;
      const old = previousPositions[author.id];
      if (old && Number.isFinite(old.x) && Number.isFinite(old.y) && ((old.x-CX)/(570-envelope))**2 + ((old.y-CY)/(290-envelope))**2 <= 1 && placed.every(p=>Math.hypot(p.x-old.x,p.y-old.y)>p.envelope+envelope+5)) position = { ...author, finalChurn:author.churn, x:old.x, y:old.y, radius, envelope };
      if (old && !position) break;
      const orientation = (hash(author.id) % 360) * Math.PI / 180;
      for (let i = 0; !position && i < 2400; i++) {
        const r = Math.sqrt(i) * 9;
        const angle = i * 2.399963229728653 + orientation;
        const x = Math.cos(angle) * r * 1.45, y = Math.sin(angle) * r;
        if ((x / (570 - envelope)) ** 2 + (y / (290 - envelope)) ** 2 > 1) continue;
        if (placed.every((p) => Math.hypot(p.x - CX - x, p.y - CY - y) > p.envelope + envelope + 5)) {
          position = { ...author, finalChurn:author.churn, x: CX + x, y: CY + y, radius, envelope }; break;
        }
      }
      if (!position) break;
      placed.push(position);
    }
    if (placed.length === authors.length) return placed;
  }
  if (Object.keys(previousPositions).length) return pack(authors);
  throw new Error('作者布局空间不足，请减少显示人数');
}

export function particleRadius(churn) {
  return churn > 0 ? Math.max(1.5, Math.min(18, Math.sqrt(churn) * .5)) : 1.5;
}

export function prepareHistory(manifest) {
  if (prepared.has(manifest)) return prepared.get(manifest);
  const identities = groupedAuthors(manifest);
  const ranked = [...identities.authors].sort((a, b) => b.churn - a.churn || a.id.localeCompare(b.id));
  const visible = ranked.slice(0, manifest.settings?.maxAuthors || 16).map((a) => ({ ...a }));
  const hidden = ranked.slice(visible.length);
  const selected = new Set(visible.map((a) => a.id));
  if (hidden.length) visible.push({ id: '__other__', name: `其他 · ${hidden.length} 人`, color: '#a6b8cc', churn: hidden.reduce((sum, a) => sum + a.churn, 0), hiddenCount: hidden.length, retainedLines: hidden.reduce((sum,a)=>sum+(a.retainedLines||0),0) });
  const nodes = pack(visible, manifest.layout || {});
  const nodeById = new Map(nodes.map((a) => [a.id, a]));
  const formatter = clockFormatter(manifest.settings?.timeZone || 'Asia/Shanghai');
  const particles = new Map();
  for (const commit of manifest.commits || []) {
    const identity = identities.links[commit.authorId] || commit.authorId;
    const authorId = selected.has(identity) ? identity : '__other__';
    const { hour } = clockParts(Date.parse(commit.authoredAt), formatter);
    // Only truly simultaneous commits may share a visual particle.
    const key = `${identity}:${commit.authoredAt}:${commit.at}`;
    let particle = particles.get(key);
    if (!particle) {
      particle = { id: commit.sha, authorId, color: identities.authors.find((a) => a.id === identity)?.color || '#a6b8cc', at: commit.at, latestAt: commit.at, angle: Math.PI / 2 + hour * Math.PI / 12, churn: 0, commits: [] };
      particles.set(key, particle);
    }
    particle.latestAt = Math.max(particle.latestAt, commit.at);
    particle.churn += commit.churn; particle.commits.push(commit);
  }
  const arrivals = [];
  const cumulative = new Map();
  const growing = new Map();
  const sortedParticles = [...particles.values()].sort((a,b)=>a.latestAt-b.latestAt || a.id.localeCompare(b.id));
  for (const particle of sortedParticles) {
    particle.arrival = particle.latestAt + FLIGHT;
    particle.sx = CX + Math.cos(particle.angle) * RX;
    particle.sy = CY + Math.sin(particle.angle) * RY;
    particle.size = particleRadius(particle.churn);
    for (const commit of particle.commits) arrivals.push({ ...commit, displayAuthorId: particle.authorId, arrival: particle.arrival });
  }
  const motion = precomputeMotion(nodes, sortedParticles, manifest.duration);
  for (const [index, particle] of sortedParticles.entries()) {
    particle.impactX = motion.impacts[index*2]; particle.impactY = motion.impacts[index*2+1];
    const node = nodeById.get(particle.authorId);
    const target = { ...node, ...motionPosition(motion, nodes.indexOf(node), particle.arrival) };
    const { sx, sy } = particle;
    const dx = target.x - sx, dy = target.y - sy, length = Math.max(1, Math.hypot(dx, dy));
    const bend = ((hash(particle.id) % 2) ? 1 : -1) * Math.min(65, length * .12);
    const endDirection = Math.atan2(-particle.impactY, -particle.impactX);
    const before = cumulative.get(target.id) || 0;
    const recent = (growing.get(target.id) || []).filter(p => particle.arrival-p.arrival < .35);
    const visibleAmount = before - recent.reduce((sum,p) => { const q=clamp((particle.arrival-p.arrival)/.35); return sum+p.churn*(1-q*q*(3-2*q)); },0);
    cumulative.set(target.id, before + particle.churn);
    growing.set(target.id, [...recent, particle]);
    const arrivalRadius = Math.max(1, target.churn ? target.radius * Math.sqrt(Math.max(0,visibleAmount) / target.churn) : 1);
    const ex = target.x + Math.cos(endDirection) * arrivalRadius, ey = target.y + Math.sin(endDirection) * arrivalRadius;
    particle.path = { sx, sy, c1x: sx + dx * .4 - dy / length * bend, c1y: sy + dy * .4 + dx / length * bend, c2x: ex - particle.impactX * length * .22, c2y: ey - particle.impactY * length * .22, ex, ey };
    particle.endDirection = endDirection;
  }
  arrivals.sort((a, b) => a.arrival - b.arrival || a.sha.localeCompare(b.sha));
  const result = { nodes, motion, particles: sortedParticles, arrivals, authors: identities.authors };
  prepared.set(manifest, result); return result;
}

export function historyState(manifest, time) {
  const scene = prepareHistory(manifest);
  const totals = new Map(scene.nodes.map((n) => [n.id, { additions: 0, deletions: 0, churn: 0, visualChurn: 0, retainedLines: 0, visualRetainedLines: 0, commitCount: 0, lastArrival: -100 }]));
  let churn = 0, retainedLines = 0;
  for (const commit of scene.arrivals) {
    if (commit.arrival > time + 1e-8) break;
    const value = totals.get(commit.displayAuthorId);
    value.additions += commit.additions; value.deletions += commit.deletions; value.churn += commit.churn; value.commitCount++; value.lastArrival = commit.arrival;
    const growth = clamp((time - commit.arrival) / .35);
    value.visualChurn += commit.churn * (growth * growth * (3 - 2 * growth));
    const retained = commit.retainedLines || 0;
    value.retainedLines += retained; value.visualRetainedLines += retained * (growth * growth * (3 - 2 * growth));
    retainedLines += retained; churn += commit.churn;
  }
  return { churn, retainedLines, retentionAvailable: manifest.retention?.version === 1, nodes: scene.nodes.map((n, i) => ({ ...n, ...motionPosition(scene.motion, i, time), finalRetainedLines: n.retainedLines || 0, ...totals.get(n.id), safeRadius: safetyRadius(n, totals.get(n.id).visualChurn, time-totals.get(n.id).lastArrival) })), particles: scene.particles };
}

function curve(path, p) {
  return { x: (1-p)**3 * path.sx + 3*(1-p)**2*p*path.c1x + 3*(1-p)*p*p*path.c2x + p**3*path.ex, y: (1-p)**3 * path.sy + 3*(1-p)**2*p*path.c1y + 3*(1-p)*p*p*path.c2y + p**3*path.ey };
}
function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, Math.max(.1, r), 0, Math.PI*2); }
function fitText(ctx, text, width) {
  let result = text;
  while (ctx.measureText(result).width > width && result.length > 1) result = result.slice(0,-1);
  return result === text ? result : `${result.slice(0,-1)}…`;
}

export function drawHistory(ctx, manifest, time) {
  const state = historyState(manifest, time);
  const clock = clockState(manifest, time);
  ctx.clearRect(0,0,WIDTH,HEIGHT);
  ctx.fillStyle = '#080e18'; ctx.fillRect(0,0,WIDTH,HEIGHT);
  const bg = ctx.createRadialGradient(CX,CY,10,CX,CY,800);
  bg.addColorStop(0,'#13263a'); bg.addColorStop(1,'#080e18'); ctx.fillStyle=bg; ctx.fillRect(0,0,WIDTH,HEIGHT);
  ctx.textAlign='left'; ctx.fillStyle='#e9f4ff'; ctx.font='600 36px system-ui'; ctx.fillText(fitText(ctx,manifest.project.name,1050),82,77);
  ctx.font='18px system-ui'; ctx.fillStyle='#9aaec4'; ctx.fillText(`${manifest.project.branch}  /  ${manifest.commits?.length || 0} commits  /  ${manifest.settings?.timeZone || 'Asia/Shanghai'}`,84,111);
  ctx.textAlign='right'; ctx.fillStyle='#e9f4ff'; ctx.font='600 34px system-ui'; ctx.fillText(`${number(state.churn)} 行改动`,1838,77);
  if(state.retentionAvailable) {
    ctx.font='600 25px system-ui';ctx.fillStyle='#9fe5e1';
    ctx.fillText(`已呈现存留 ${number(state.retainedLines)} 行`,1838,112);
    ctx.font='16px system-ui';ctx.fillStyle='#9aaec4';
    const unmapped=manifest.retention.unmappedLines;
    ctx.fillText(`项目最终存留 ${manifest.retention.totalLines.toLocaleString('zh-CN')} 行${unmapped ? ` · 未纳入事件 ${unmapped.toLocaleString('zh-CN')} 行` : ''}`,1838,139);
  } else {
    ctx.font='18px system-ui';ctx.fillStyle='#9aaec4';ctx.fillText('最终存留未分析',1838,112);
  }
  ctx.font='18px system-ui'; ctx.fillStyle='#9aaec4'; ctx.fillText(clock ? clock.label : '等待首次贡献',1838,166);
  if (clock?.skippedDays) { ctx.font='16px system-ui'; ctx.fillStyle='#9fe5e1'; ctx.fillText(`跳过 ${clock.skippedDays} 个无提交日`,1838,192); }

  ctx.strokeStyle='#294156'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.ellipse(CX,CY,RX,RY,0,0,Math.PI*2); ctx.stroke();
  for (let h=0;h<24;h++) {
    const a=Math.PI/2+h*Math.PI/12, major=h%6===0;
    ctx.strokeStyle=major?'#8ba5bd':'#365168'; ctx.lineWidth=major?2:1;
    ctx.beginPath(); ctx.moveTo(CX+Math.cos(a)*RX,CY+Math.sin(a)*RY); ctx.lineTo(CX+Math.cos(a)*(RX+ (major?15:7)),CY+Math.sin(a)*(RY+(major?15:7))); ctx.stroke();
    if (h%3===0) { ctx.textAlign='center'; ctx.font=major?'600 24px system-ui':'17px system-ui'; ctx.fillStyle=major?'#d7e8f7':'#9aaec4'; ctx.fillText(`${String(h).padStart(2,'0')}:00`,CX+Math.cos(a)*(RX+58),CY+Math.sin(a)*(RY+38)+8); }
  }


  for (const particle of state.particles) {
    const p=clamp((time-particle.at)/(particle.arrival-particle.at));
    if (time<particle.at || p>=1) continue;
    const motion=clamp((p-.12)/.88), q=motion*motion;
    const opacity=clamp(p/.12)*clamp((1-p)/.1);
    const pos=curve(particle.path,q);
    ctx.save(); ctx.strokeStyle=particle.color; ctx.lineWidth=2;
    for(let i=8;i>0;i--) {
      const before=curve(particle.path,clamp(q-i*.012)), after=curve(particle.path,clamp(q-(i-1)*.012));
      ctx.globalAlpha=opacity*(1-i/9)*.55; ctx.beginPath(); ctx.moveTo(before.x,before.y); ctx.lineTo(after.x,after.y); ctx.stroke();
    }
    ctx.globalAlpha=opacity; ctx.shadowBlur=14; ctx.shadowColor=particle.color; ctx.fillStyle=particle.color;
    circle(ctx,pos.x,pos.y,particleRadius(particle.churn)); ctx.fill();
    if(p<.22) { ctx.globalAlpha=(1-p/.22)*.8; circle(ctx,particle.path.sx,particle.path.sy,8+p*55); ctx.stroke(); }
    ctx.restore();
  }

  for(const node of state.nodes) {
    if(!node.commitCount) continue;
    const since=time-node.lastArrival;
    const radius=node.radius ? node.radius*Math.sqrt(node.visualChurn/Math.max(1,node.finalChurn)) : 0;
    const pulse=since<.5 ? Math.sin(Math.PI*since/.5)*2.5 : 0;
    const r=Math.max(1,radius)+pulse;
    ctx.save(); ctx.shadowBlur=22; ctx.shadowColor=node.color; ctx.fillStyle=node.color; ctx.globalAlpha=.14;
    circle(ctx,node.x,node.y,r);ctx.fill();
    if(state.retentionAvailable && node.visualRetainedLines>0){
      const inner=node.radius*Math.sqrt(node.visualRetainedLines/Math.max(1,node.finalChurn));
      ctx.globalAlpha=.48;ctx.shadowBlur=0;circle(ctx,node.x,node.y,inner);ctx.fill();
    }
    ctx.globalAlpha=1;ctx.shadowBlur=0;ctx.strokeStyle=node.color;ctx.lineWidth=2;
    circle(ctx,node.x,node.y,r);ctx.stroke();
    if(since<.6){ctx.globalAlpha=(1-since/.6)*.6;circle(ctx,node.x,node.y,r+since*25);ctx.stroke();ctx.globalAlpha=1;}
    ctx.textAlign='center';ctx.fillStyle='#edf5ff';ctx.font='600 20px system-ui';
    ctx.fillText(fitText(ctx,node.name,Math.max(74,Math.min(170,node.envelope*2-12))),node.x,node.y-5);
    ctx.font='16px system-ui';ctx.fillStyle='#b8cede';
    const label = state.retentionAvailable && time >= manifest.duration - 1e-8 ? `${number(node.churn)}（${number(node.retainedLines)}）` : number(node.churn);
    const labelWidth = Math.max(74,Math.min(170,node.envelope*2-12));
    const labelSize = Math.min(16,16*labelWidth/Math.max(1,ctx.measureText(label).width));
    ctx.font=`${labelSize}px system-ui`;ctx.fillText(label,node.x,node.y+20);
    ctx.restore();
  }
  // Local ripples mark the exact absorption point.
  for(const particle of state.particles) {
    const age=time-particle.arrival;
    if(age<0||age>.5)continue;
    ctx.save();ctx.globalAlpha=(1-age/.5)*.7;ctx.strokeStyle=particle.color;ctx.lineWidth=1.5;
    circle(ctx,particle.path.ex,particle.path.ey,4+age*32);ctx.stroke();ctx.restore();
  }
  if (clock) {
    ctx.save(); ctx.strokeStyle='#9fe5e1'; ctx.lineCap='round';
    for (let i=12;i>0;i--) {
      const a=clock.angle-i*.015, b=clock.angle-(i-1)*.015;
      ctx.globalAlpha=(1-i/13)*.8; ctx.lineWidth=3;
      ctx.beginPath(); ctx.ellipse(CX,CY,RX,RY,0,a,b); ctx.stroke();
    }
    const x=CX+Math.cos(clock.angle)*RX, y=CY+Math.sin(clock.angle)*RY;
    ctx.globalAlpha=1;ctx.lineWidth=2;ctx.shadowBlur=16;ctx.shadowColor='#9fe5e1';
    ctx.beginPath();ctx.moveTo(CX+Math.cos(clock.angle)*(RX-8),CY+Math.sin(clock.angle)*(RY-8));
    ctx.lineTo(CX+Math.cos(clock.angle)*(RX+16),CY+Math.sin(clock.angle)*(RY+16));ctx.stroke();
    ctx.shadowBlur=0;ctx.fillStyle='#080e18';circle(ctx,x,y,9);ctx.fill();
    ctx.shadowBlur=18;ctx.fillStyle='#d9fffa';circle(ctx,x,y,6);ctx.fill();ctx.restore();
  }

  ctx.textAlign='left';ctx.font='16px system-ui';ctx.fillStyle='#9aaec4';
  ctx.fillText(state.retentionAvailable ? '外圈 = 累计新增 + 删除   ·   内芯 = 最终存留（以最终 HEAD 为准，非历史当天存量）   ·   末帧括号 = 存留   ·   粒子 = 单次改动量   ·   入口 = 作者提交时刻' : '球面积 = 累计新增 + 删除   ·   粒子 = 单次改动量   ·   入口 = 作者提交时刻   ·   最终存留未分析：请重新生成',82,1009);
  ctx.strokeStyle='#294156';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(82,1043);ctx.lineTo(1838,1043);ctx.stroke();
  ctx.strokeStyle='#9fe5e1';ctx.beginPath();ctx.moveTo(82,1043);ctx.lineTo(82+1756*clamp(time/manifest.duration),1043);ctx.stroke();
  return state.nodes;
}

export function hitAuthor(manifest, time, x, y) {
  return historyState(manifest,time).nodes.find((n)=>n.commitCount && Math.hypot(n.x-x,n.y-y)<=n.safeRadius);
}
