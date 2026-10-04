import { execFile, execFileSync } from 'node:child_process';

// NUL-separated numstat preserves tabs, newlines and Unicode in file names.
export function numstatEntries(output) {
  return output.split('\0').flatMap(record => {
    const match=record.replace(/^\n+/, '').match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    return match ? [{path:match[3],binary:match[1]==='-',additions:Number(match[1])||0,deletions:Number(match[2])||0}] : [];
  });
}
function originalPath(value) {
  if(!value.startsWith('"'))return value;
  const escapes={a:'\x07',b:'\b',t:'\t',n:'\n',v:'\v',f:'\f',r:'\r','"':'"','\\':'\\'};
  return value.slice(1,-1).replace(/\\([0-7]{1,3}|[abtnvfr"\\])/g,(_,c)=>escapes[c]??String.fromCharCode(parseInt(c,8)));
}
export async function analyzeRetention(repo,head,commits,excludesKey,isExcluded,previousManifest,onProgress=()=>{}) {
  const started=performance.now(), old=previousManifest?.retention;
  const cacheHit=old?.version===2&&old.head===head&&old.excludesKey===excludesKey&&commits.every(c=>Number.isInteger(c.retainedLines)&&c.retainedLines>=0&&c.retainedLines<=c.churn);
  if(cacheHit){onProgress({stage:"retention",cacheHit:true});return {retention:{...old},cacheHit:true,elapsedMs:performance.now()-started};}
  const git=args=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:'pipe',maxBuffer:64*1024*1024});
  const empty=git(['hash-object','-t','tree','--stdin']).trim();
  const regularFiles=new Set(git(['ls-tree','-r','-z',head]).split('\0').filter(record=>record.startsWith('100')).map(record=>record.slice(record.indexOf('\t')+1)));
  const files=numstatEntries(git(['diff','--numstat','-z','--no-renames',empty,head])).filter(f=>!f.binary&&regularFiles.has(f.path)&&!isExcluded(f.path));
  const total=files.filter(f=>f.additions>0).length;let completed=0;
  onProgress({stage:"retention",completed,total});
  const bySha=new Map(commits.map(c=>{c.retainedLines=0;return [c.sha,c];}));
  const origins=new Map();
  let totalLines=0,mappedLines=0;
  let cursor=0,failure;
  async function worker() {
    while(!failure&&cursor<files.length) {
      const file=files[cursor++];
      if(!file.additions)continue;
      let sha,start,count;
      let output;
      try {
        output=await new Promise((resolve,reject)=>execFile('git',['-C',repo,'-c','core.quotePath=false','-c','blame.blankBoundary=false','blame','--root','--incremental','--ignore-revs-file','',head,'--',file.path],{encoding:'utf8',maxBuffer:64*1024*1024},(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve(stdout)));
      } catch(error) {failure??=error;return;}
      for(const line of output.split('\n')) {
        const header=line.match(/^([\da-f]{40,64}) (\d+) \d+ (\d+)$/);
        if(header){sha=header[1];start=Number(header[2]);count=Number(header[3]);}
        else if(line.startsWith('filename ')) {
          totalLines+=count;
          const commit=bySha.get(sha);
          const path=originalPath(line.slice(9));
          if(commit&&!isExcluded(path)) {
            if(!origins.has(sha))origins.set(sha,new Map());
            const paths=origins.get(sha);
            if(!paths.has(path))paths.set(path,[]);
            paths.get(path).push([start,start+count]);
          }
        }
      }
      onProgress({stage:"retention",completed:++completed,total});
    }
  }
  await Promise.all(Array.from({length:Math.min(4,files.length)},()=>worker()));
  if(failure)throw failure;
  // Divergent renames can leave the same original lines in multiple HEAD files.
  for(const [sha,paths] of origins) {
    const commit=bySha.get(sha);
    for(const ranges of paths.values()) {
      ranges.sort((a,b)=>a[0]-b[0]);let end=0;
      for(const [start,stop] of ranges) {
        commit.retainedLines+=Math.max(0,stop-Math.max(start,end));end=Math.max(end,stop);
      }
    }
    mappedLines+=commit.retainedLines;
  }
  for(const commit of commits)if(commit.retainedLines>commit.churn)throw new Error(`存留统计异常：${commit.sha.slice(0,8)} 的存留量超过改动量`);
  const expected=files.reduce((sum,f)=>sum+f.additions,0);
  if(totalLines!==expected)throw new Error(`存留统计不完整：逐行归属 ${totalLines} 行，目标版本 ${expected} 行`);
  return {retention:{version:2,head,excludesKey,totalLines,mappedLines,unmappedLines:totalLines-mappedLines},cacheHit:false,elapsedMs:performance.now()-started};
}
