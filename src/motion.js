// Fixed-step, seek-safe motion. No state is advanced by the renderer.
export const MOTION = Object.freeze({ hz:60, repulsion:18, attraction:1, centering:4, damping:2.8, speed:110, impulse:18, impulseSpeed:100, spacing:18, boundary:120 });
const CX=960, CY=555;
const clamp = n => Math.max(0,Math.min(1,n));
export function smoothGrowth(age) { const q=clamp(age/.35); return q*q*(3-2*q); }
export function safetyRadius(node, visualChurn, since) {
  const radius=Math.max(1,node.radius*Math.sqrt(Math.max(0,visualChurn)/Math.max(1,node.finalChurn)));
  const pulse=since>=0&&since<.5 ? Math.sin(Math.PI*since/.5)*2.5 : 0;
  return Math.max(Math.min(85,node.envelope),radius+12+pulse);
}
function seed(id) { let h=2166136261; for(const c of id)h=Math.imul(h^c.charCodeAt(0),16777619); return (h>>>0)/4294967296*Math.PI*2; }
export function precomputeMotion(nodes, particles, duration) {
  const n=nodes.length, frames=Math.ceil(duration*MOTION.hz)+1, dt=1/MOTION.hz;
  const impacts=new Float64Array(particles.length*2), decay=Math.exp(-MOTION.damping*dt);
  const positions=new Float32Array(frames*n*2), births=new Float64Array(n).fill(Infinity), birthPositions=new Float64Array(n*2);
  const x=new Float64Array(n),y=new Float64Array(n),vx=new Float64Array(n),vy=new Float64Array(n),ax=new Float64Array(n),ay=new Float64Array(n),mass=new Float64Array(n),radius=new Float64Array(n),total=new Float64Array(n),last=new Float64Array(n).fill(-100);
  const active=[], recent=nodes.map(()=>[]), byId=new Map(nodes.map((node,i)=>[node.id,i]));
  const maxArea=Math.max(1,...nodes.map(node=>node.radius**2));
  nodes.forEach((node,i)=>{x[i]=node.x;y[i]=node.y;mass[i]=1+node.radius**2/maxArea;birthPositions[i*2]=x[i];birthPositions[i*2+1]=y[i];});
  const events=particles.map((p,index)=>({p,index,i:byId.get(p.authorId),tick:Math.ceil((p.arrival-1e-9)*MOTION.hz)})).sort((a,b)=>a.tick-b.tick||a.p.arrival-b.p.arrival||a.p.id.localeCompare(b.p.id));
  let next=0;
  function bound(i) {
    const a=570-radius[i],b=290-radius[i],dx=x[i]-CX,dy=y[i]-CY,q=Math.hypot(dx/a,dy/b);
    if(q>1){x[i]=CX+dx/q;y[i]=CY+dy/q;const nx=dx/(a*a),ny=dy/(b*b),len=Math.hypot(nx,ny),ux=nx/len,uy=ny/len,out=vx[i]*ux+vy[i]*uy;if(out>0){vx[i]-=out*ux;vy[i]-=out*uy;}}
  }
  for(let frame=0;frame<frames;frame++) {
    const time=frame*dt;
    ax.fill(0);ay.fill(0);
    while(next<events.length&&events[next].tick<=frame) {
      const {p,i,index}=events[next++];
      if(births[i]===Infinity) {
        radius[i]=safetyRadius(nodes[i],0,0); births[i]=time;
        const free=()=>Math.hypot((x[i]-CX)/(570-radius[i]),(y[i]-CY)/(290-radius[i]))<=1&&active.every(j=>Math.hypot(x[i]-x[j],y[i]-y[j])>=radius[i]+radius[j]+3);
        if(!free()) { const phase=seed(nodes[i].id);for(let k=0;k<4000;k++){const r=Math.sqrt(k)*9,a=k*2.399963229728653+phase;x[i]=CX+Math.cos(a)*r*1.45;y[i]=CY+Math.sin(a)*r;if(free())break;} }
        birthPositions[i*2]=x[i];birthPositions[i*2+1]=y[i];active.push(i);
      }
      total[i]+=p.churn;last[i]=p.arrival;recent[i].push(p);
      const dx=x[i]-p.sx,dy=y[i]-p.sy,len=Math.max(1,Math.hypot(dx,dy));
      const ux=dx/len,uy=dy/len;impacts[index*2]=ux;impacts[index*2+1]=uy;
      if(p.churn>0){const strength=MOTION.impulse*(p.size/6)**2;ax[i]+=strength*ux;ay[i]+=strength*uy;}
    }
    for(const i of active) {
      const impulseLength=Math.hypot(ax[i],ay[i])/mass[i],scale=impulseLength>MOTION.impulseSpeed?MOTION.impulseSpeed/impulseLength:1;
      vx[i]+=ax[i]/mass[i]*scale;vy[i]+=ay[i]/mass[i]*scale;ax[i]=0;ay[i]=0;
      const queue=recent[i];while(queue.length&&time-queue[0].arrival>=.35)queue.shift();
      let visible=total[i];for(const p of queue)visible-=p.churn*(1-smoothGrowth(time-p.arrival));
      radius[i]=safetyRadius(nodes[i],visible,time-last[i]);
    }
    let centerX=0,centerY=0,weight=0;
    for(const i of active){centerX+=x[i]*mass[i];centerY+=y[i]*mass[i];weight+=mass[i];}
    const pullX=weight?(CX-centerX/weight)*MOTION.centering:0,pullY=weight?(CY-centerY/weight)*MOTION.centering:0;
    for(let a=0;a<active.length;a++)for(let b=a+1;b<active.length;b++) {
      const i=active[a],j=active[b],dx=x[j]-x[i],dy=y[j]-y[i],d=Math.max(.001,Math.hypot(dx,dy)),gap=d-radius[i]-radius[j]-MOTION.spacing;
      const force=gap*(gap<0?MOTION.repulsion:MOTION.attraction/Math.max(1,active.length-1)),fx=dx/d*force,fy=dy/d*force;
      ax[i]+=fx/mass[i];ay[i]+=fy/mass[i];ax[j]-=fx/mass[j];ay[j]-=fy/mass[j];
    }
    for(const i of active) {
      const dx=x[i]-CX,dy=y[i]-CY,a=570-radius[i],b=290-radius[i],q=Math.hypot(dx/a,dy/b),len=Math.max(1,Math.hypot(dx,dy));
      if(q>.9){ax[i]-=dx/len*(q-.9)*MOTION.boundary;ay[i]-=dy/len*(q-.9)*MOTION.boundary;}
      vx[i]=(vx[i]+(ax[i]+pullX)*dt)*decay;vy[i]=(vy[i]+(ay[i]+pullY)*dt)*decay;
      const speed=Math.hypot(vx[i],vy[i]);if(speed>MOTION.speed){vx[i]*=MOTION.speed/speed;vy[i]*=MOTION.speed/speed;}
      // Store the position at this tick; its impulse affects the following step.
      positions[(frame*n+i)*2]=x[i];positions[(frame*n+i)*2+1]=y[i];
      x[i]+=vx[i]*dt;y[i]+=vy[i]*dt;bound(i);
    }
    for(let pass=0;pass<3;pass++) {
      for(let a=0;a<active.length;a++)for(let b=a+1;b<active.length;b++) {
        const i=active[a],j=active[b];let dx=x[j]-x[i],dy=y[j]-y[i],d=Math.hypot(dx,dy);const overlap=radius[i]+radius[j]+2-d;
        if(overlap<=0)continue;
        if(d<.001){const angle=seed(nodes[i].id+nodes[j].id);dx=Math.cos(angle);dy=Math.sin(angle);d=1;}
        const ux=dx/d,uy=dy/d,share=mass[j]/(mass[i]+mass[j]);
        x[i]-=ux*overlap*share;y[i]-=uy*overlap*share;x[j]+=ux*overlap*(1-share);y[j]+=uy*overlap*(1-share);
        const approaching=(vx[j]-vx[i])*ux+(vy[j]-vy[i])*uy;
        if(approaching<0){vx[i]+=approaching*ux*share;vy[i]+=approaching*uy*share;vx[j]-=approaching*ux*(1-share);vy[j]-=approaching*uy*(1-share);}
      }
      for(const i of active)bound(i);
    }
  }
  return {positions,impacts,births,birthPositions,count:n,frames,duration};
}
export function motionPosition(track,index,time) {
  if(time<=track.births[index])return {x:track.birthPositions[index*2],y:track.birthPositions[index*2+1]};
  const frame=Math.max(0,Math.min(track.frames-1,time*MOTION.hz)),a=Math.floor(frame),b=Math.min(a+1,track.frames-1),q=frame-a,k=(a*track.count+index)*2,l=(b*track.count+index)*2;
  return {x:track.positions[k]*(1-q)+track.positions[l]*q,y:track.positions[k+1]*(1-q)+track.positions[l+1]*q};
}
