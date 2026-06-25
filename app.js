const $=s=>document.querySelector(s);
const vid=$("#vid"), thumbVid=$("#thumbvid"), rows=$("#rows"), timeline=$("#timeline");
const played=timeline.querySelector(".played"), playhead=timeline.querySelector(".playhead");
const SHOT_TYPES=["gimbal choreo","gimbal freestyle","static close-up","static wide"];
const TYPE_COLOR={"static wide":"#bfe3ff","static close-up":"#bfe3ff","gimbal freestyle":"#ffc2dd","gimbal choreo":"#ffc2dd"};

let shots=[], sections=[], selId=null, nextId=1, zoom=1, storeKey=null, dragSec=-1, editId=null;
const isPlayback=()=>document.body.classList.contains("playback");
let explicitSel=false;   // true only when the user actually clicked a marker or a shot row — not auto-highlight or scrub

// ---- undo (Ctrl/Cmd+Z) ----------------------------------------------------------------------------------------------
// One snapshot of {shots,sections,selId} per discrete action. Continuous edits (typing in a cell, dragging a marker or a
// section boundary) record a single snapshot taken BEFORE the edit began: beginAction() stashes it, commitAction() pushes
// it on the first real change. Thumbs ride along in the snapshot so undo restores them instantly.
const undoStack=[]; let pendingSnap=null;
const snapshot=()=>JSON.stringify({shots, sections, selId});
function pushUndo(){ undoStack.push(snapshot()); if(undoStack.length>40) undoStack.shift(); pendingSnap=null; }
function beginAction(){ pendingSnap=snapshot(); }
function commitAction(){ if(pendingSnap){ undoStack.push(pendingSnap); if(undoStack.length>40) undoStack.shift(); pendingSnap=null; } }
function undo(){
  if(!undoStack.length) return;
  const st=JSON.parse(undoStack.pop());
  shots=st.shots; sections=st.sections; selId=st.selId;
  editId=null; dragSec=-1; pendingSnap=null; explicitSel=false;
  save();
  if(shots.some(s=>!s.thumb)) generateAllThumbs();   // sets genRunning before render so the retry path won't double-capture
  render();
}

// iOS won't let us seek a <video> reliably until it has been played once from a user gesture. The thumbnail grabber
// also plays a second element off the same blob, which can leave the main player in a stuck "can't seek" state. So on
// the first touch after a video loads we prime it (gesture-allowed play → pause), which hands seeking back to us.
let vidPrimed=false;
function primeVideo(){
  if(vidPrimed) return; vidPrimed=true;
  try{ const p=vid.play(); if(p&&p.then) p.then(()=>{ try{vid.pause();}catch{} }).catch(()=>{ vidPrimed=false; }); }
  catch{ vidPrimed=false; }
}
const lastSecTap={};  // keyed by section id; survives timeupdate-triggered re-renders that swap the DOM element
const thumbReq=new Set();  // shot ids we've already kicked off a thumbnail request for, so renderTable retries don't spin

const fmt=t=>{ if(!isFinite(t))return"0:00.0"; const m=Math.floor(t/60),s=(t%60).toFixed(1).padStart(4,"0"); return m+":"+s; };
function parseTime(str){ str=String(str).trim(); if(str.includes(":")){const[m,s]=str.split(":");return (+m)*60+(+s);} return +str; }
const clampT=t=>Math.max(0,Math.min(t, vid.duration||t));
const sortShots=()=>shots.sort((a,b)=>a.time-b.time);
function durOf(i){ const end=(i+1<shots.length)?shots[i+1].time:(vid.duration||shots[i].time); return Math.max(0,end-shots[i].time); }

let viewStart=null;  // null = recompute; set on zoom change so the view re-centers, then frozen until playhead exits
function view(){
  const dur=vid.duration||1, vis=dur/zoom, t=vid.currentTime;
  if(viewStart===null || t<viewStart-0.001 || t>viewStart+vis+0.001 || vis>=dur-0.01){
    viewStart=Math.max(0,Math.min(t-vis/2,dur-vis)); if(!(viewStart>=0)) viewStart=0;
  }
  return {start:viewStart, vis, end:viewStart+vis};
}
const pct=(t,v)=>((t-v.start)/v.vis)*100;

let thumbChain=Promise.resolve();
// returns true when the canvas frame is essentially all black — iOS hands those back before the decoder has presented
function isBlank(ctx,w,h){
  try{ const d=ctx.getImageData(0,0,w,h).data;
    for(let i=0;i<d.length;i+=4){ if(d[i]>8||d[i+1]>8||d[i+2]>8) return false; }
    return true;
  }catch{ return false; }  // a same-origin blob shouldn't taint the canvas, but if we can't read it, assume the frame is real
}
// iOS WebKit never presents a frame to <canvas> for a *paused* seek — drawImage just yields black. The reliable HTML5
// trick: a muted inline video may play without a user gesture, and *playing* is what forces the decoder to present
// frames. So we seek, play, grab the first frame at/after the target (rVFC hands us a guaranteed-presented frame),
// then pause again. Chromium, which fired `seeked` for paused seeks before, keeps working via the same path.
function captureFrame(t){
  return new Promise(res=>{
    let done=false, tmo;
    const target=Math.min(t, thumbVid.duration||t);
    const grab=force=>{ if(done)return true;
      try{ const c=document.createElement("canvas"); c.width=160; c.height=90;
        const ctx=c.getContext("2d",{willReadFrequently:true}); ctx.drawImage(thumbVid,0,0,160,90);
        if(!force && isBlank(ctx,c.width,c.height)) return false;  // decoder hasn't presented a frame yet → keep waiting
        finish(c.toDataURL("image/jpeg",0.7)); return true;
      }catch{ finish(""); return true; }  // secured/tainted canvas: bail rather than hang
    };
    // rVFC delivers a frame already presented, with its real presentation time in meta.mediaTime. Only accept a frame
    // whose mediaTime sits in a window AT/just-after the target. This is the crucial guard for batch (reopen) capture:
    // when seeking *backward* to an earlier shot, the still-presented pre-seek frame has a far larger mediaTime, so a
    // plain `>=target` test would grab that stale frame — which is exactly why every reopened thumbnail came out the
    // same. Bounding the window above rejects it and we wait for the seek to actually land. Cold decoders can hand back
    // black for the first few frames, so reject blanks and keep pulling until one presents (or a small budget runs out).
    let blanks=0;
    const onFrame=(now,meta)=>{ if(done)return;
      if(meta.mediaTime>=target-0.05 && meta.mediaTime<=target+0.6){
        if(grab(false)) return;                  // captured a real, non-blank frame at the target
        if(++blanks>=10){ grab(true); return; }  // decoder kept handing back black — take what we have rather than hang
      }
      if(thumbVid.requestVideoFrameCallback) thumbVid.requestVideoFrameCallback(onFrame);
    };
    // When the seek lands, re-poll a presented frame through rVFC (which is window-guarded on mediaTime). We must NOT
    // grab off currentTime directly on rVFC engines: iOS keeps the *previous* shot's frame presented to the canvas for a
    // beat after a seek, and since it isn't black, a direct grab would silently duplicate it onto the next shot — the
    // mobile "wrong thumbnail" bug. Only engines without rVFC fall back to a delayed best-effort grab.
    const hasRVFC=!!thumbVid.requestVideoFrameCallback;
    const onSeeked=()=>{ if(done)return; if(Math.abs(thumbVid.currentTime-target)>=0.3) return;
      if(hasRVFC) thumbVid.requestVideoFrameCallback(onFrame);
      else setTimeout(()=>{ if(!done) grab(false); },80);
    };
    const cleanup=()=>{ clearTimeout(tmo); thumbVid.removeEventListener("seeked",onSeeked); };
    const finish=v=>{ if(done)return; done=true; cleanup(); try{thumbVid.pause();}catch{} res(v); };

    tmo=setTimeout(()=>finish(""),2500);  // self-heal: never leave thumbVid playing if frames never arrive
    if(hasRVFC) thumbVid.requestVideoFrameCallback(onFrame);
    thumbVid.addEventListener("seeked",onSeeked);
    if(Math.abs(thumbVid.currentTime-target)>=0.05) thumbVid.currentTime=target; else onSeeked();
    const p=thumbVid.play(); if(p&&p.catch) p.catch(()=>{});  // muted+playsinline ⇒ allowed; if blocked, seeked-fallback still tries
  });
}
// ---- thumbnail decoder lifecycle -----------------------------------------------------------------------------------
// The hidden thumbnail <video> ties up one of the device's scarce hardware video decoders. We only need it while actually
// grabbing frames (adding/retiming shots, or the startup/import batch), so its source is attached on demand and detached
// after a short idle — freeing the decoder so it can't compete with the main player and stutter playback. In playback
// mode nothing captures, so it stays released the whole time.
let thumbUrl=null, thumbUses=0, thumbIdle=0;
function acquireThumb(){
  if(thumbIdle){ clearTimeout(thumbIdle); thumbIdle=0; }
  thumbUses++;
  if(thumbVid.getAttribute("src") && thumbVid.readyState>=2) return Promise.resolve();
  if(!thumbVid.getAttribute("src") && thumbUrl) thumbVid.src=thumbUrl;
  return new Promise(res=>{
    let to; const ok=()=>{ clearTimeout(to); thumbVid.removeEventListener("loadeddata",ok); res(); };
    to=setTimeout(ok,3000);                              // don't hang if the source never decodes
    thumbVid.addEventListener("loadeddata",ok);
    if(thumbVid.readyState>=2) ok();
  });
}
function endThumbUse(){ if(thumbUses>0) thumbUses--; if(thumbUses>0) return;
  if(thumbIdle) clearTimeout(thumbIdle);
  thumbIdle=setTimeout(releaseThumb,1500);               // grace period so back-to-back captures don't reload each time
}
function releaseThumb(){ thumbIdle=0; if(thumbUses>0) return;
  try{ thumbVid.pause(); }catch{}
  if(thumbVid.getAttribute("src")){ thumbVid.removeAttribute("src"); try{ thumbVid.load(); }catch{} }  // detach ⇒ decoder freed
}
async function capture(t){
  await acquireThumb();
  try{ return await captureFrame(t); }
  finally{ endThumbUse(); }
}
function thumbAt(t){
  // race the chain against a hard timeout so one hung capture can't block every future thumbnail. Allow for a possible
  // decoder re-acquire (≤3s) on top of the capture (≤2.5s) so a legitimately slow grab isn't cut short.
  const work=thumbChain.then(()=>capture(t));
  const guarded=Promise.race([work, new Promise(res=>setTimeout(()=>res(""),6000))]);
  thumbChain=guarded;  // future thumbAt calls queue behind the guarded promise, which is guaranteed to resolve
  return guarded;
}

function save(){ if(!storeKey)return; try{ localStorage.setItem(storeKey, JSON.stringify({
  shots:shots.map(({id,thumb,...r})=>r), sections:sections.map(({id,...r})=>r) })); }catch{} }
function restore(){ if(!storeKey)return; const raw=localStorage.getItem(storeKey); if(!raw)return;
  try{ const d=JSON.parse(raw); const arr=Array.isArray(d)?d:(d.shots||[]);
    shots=arr.map(r=>({id:nextId++, thumb:"", ...r})); sortShots();
    sections=(d.sections||[]).map(r=>({id:nextId++, ...r})); sortSections(); }catch{} }

function load(file){
  const url=URL.createObjectURL(file);
  vid.src=url; thumbUrl=url;                 // thumbVid source is attached on demand by acquireThumb(), not held here
  releaseThumb();                            // drop any decoder left attached from a previous video
  storeKey="shotlist:"+file.name+":"+file.size;
  genRunning=false;   // abort any thumbnail batch still running for a previous video
  shots=[]; selId=null; nextId=1; zoom=1;
  restore();
  $("#drop").classList.add("d-none"); $("#app").classList.remove("d-none");
  // prime the player on the first touch/click anywhere, so the very first scrub or marker can't break seeking on iOS
  vidPrimed=false;
  const primer=()=>{ primeVideo(); document.removeEventListener("pointerdown",primer,true); };
  document.addEventListener("pointerdown",primer,true);
  generateAllThumbs();                       // sets genRunning first so renderTable's retry path won't race the batch
  render();                                  // fills restored shots' thumbnails; decoder is released once the batch ends
}

$("#drop").onclick=()=>$("#file").click();
$("#file").onchange=e=>{ if(e.target.files[0]) load(e.target.files[0]); };
$("#drop").ondragover=e=>e.preventDefault();
$("#drop").ondrop=e=>{ e.preventDefault(); if(e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); };
$("#swap").onclick=()=>$("#file").click();

// Batch thumbnailer for a restored/imported session: capture each pending shot one at a time, in time order, awaiting
// each before the next. Doing them strictly serially (rather than firing them all at once) is what stops the captures
// from racing over the single hidden <video> — which on a cold reopen produced black or duplicated thumbnails. A second
// pass mops up any that transiently timed out to empty. Restored shots arrive with empty thumbs, so they refill here.
let genRunning=false;
async function generateAllThumbs(){
  if(genRunning) return;
  genRunning=true;
  try{
    for(let pass=0; pass<2; pass++){
      const ordered=shots.filter(s=>!s.thumb).sort((a,b)=>a.time-b.time);
      if(!ordered.length) break;
      for(const shot of ordered){
        if(!genRunning) return;                  // aborted (e.g. a new video was loaded)
        // The thumbnail grabber drives a second hidden <video>; decoding it while the main player is running fights over
        // the device's limited video decoders and makes playback stutter on mobile. Hold off until the user pauses.
        while(!vid.paused && !vid.ended && genRunning){ await new Promise(r=>setTimeout(r,250)); }
        if(!genRunning) return;
        const d=await capture(shot.time);
        if(d){ shot.thumb=d; setThumb(shot); }
      }
    }
  } finally { genRunning=false; }
}

async function addShot(t){
  primeVideo(); pushUndo();
  const s={id:nextId++, time:clampT(t), move:"", focus:"", type:"static wide", remarks:"", thumb:""};
  shots.push(s); sortShots(); selId=s.id; explicitSel=false; render(); save();
  const d=await thumbAt(s.time); if(d){ s.thumb=d; render(); }
}
function endTime(){ if(!shots.length) return vid.currentTime; const last=shots[shots.length-1].time; return Math.min(last+5, vid.duration||last+5); }

const sortSections=()=>sections.sort((a,b)=>a.start-b.start);
function secEnd(i){ return i+1<sections.length ? sections[i+1].start : (vid.duration||sections[i].start); }
function sectionIndexAt(t){ let idx=-1; for(let i=0;i<sections.length;i++) if(sections[i].start<=t+1e-6) idx=i; return idx; }
function addSection(){
  const t=vid.currentTime, dur=vid.duration||0;
  if(t<=0.05 || (dur && t>=dur-0.05)) return;
  pushUndo();
  if(!sections.length) sections=[{id:nextId++,start:0,name:""}];
  if(!sections.some(s=>Math.abs(s.start-t)<0.05)) sections.push({id:nextId++,start:t,name:""});
  sortSections(); renderTimeline(); save();
}
function removeSection(){
  if(!sections.length) return;
  const i=sectionIndexAt(vid.currentTime); if(i<0) return;
  pushUndo();
  sections.splice(i,1);
  if(sections.length && sections[0].start>0.0001) sections[0].start=0;
  renderTimeline(); save();
}
function del(id){ pushUndo(); shots=shots.filter(s=>s.id!==id); if(selId===id)selId=null; explicitSel=false; render(); save(); }
function selectShot(id,seek){ selId=id; explicitSel=true; const s=shots.find(x=>x.id===id);
  if(s&&seek) vid.currentTime=s.time;
  highlight(); renderTimeline(); scrollToRow(id);
}

const render=()=>{ renderTable(); renderTimeline(); };
// Coalesce drag-driven rebuilds to at most one per frame, so a burst of pointermove events can't queue dozens of them.
let rafTable=0, rafTimeline=0;
const scheduleTable=()=>{ if(!rafTable) rafTable=requestAnimationFrame(()=>{ rafTable=0; renderTable(); }); };
const scheduleTimeline=()=>{ if(!rafTimeline) rafTimeline=requestAnimationFrame(()=>{ rafTimeline=0; renderTimeline(); }); };
// Update just one row's thumbnail cell instead of rebuilding the whole table — used by the startup batch (was N full
// table rebuilds, one per captured thumb).
function setThumb(s){
  const tr=rows.querySelector('tr[data-id="'+s.id+'"]'); if(!tr){ renderTable(); return; }
  const cell=tr.children[3]; if(!cell) return;
  cell.innerHTML=s.thumb?`<img src="${s.thumb}">`:'<span class="text-muted">…</span>';
  if(s.thumb) cell.firstChild.onclick=()=>selectShot(s.id,true);
}
function scrollToRow(id){
  const tr=rows.querySelector('tr[data-id="'+id+'"]'); if(!tr)return;
  const wrap=$(".tablewrap"), thead=wrap.querySelector("thead");
  wrap.scrollTo({top:Math.max(0, tr.offsetTop - thead.offsetHeight - tr.offsetHeight), behavior:"smooth"});
}

function renderTable(){
  rows.innerHTML="";
  if(!shots.length){ rows.innerHTML='<tr><td colspan="9" class="text-center text-brand py-4">No shots yet — hit ＋ or press M 🌷</td></tr>'; return; }
  shots.forEach((s,i)=>{
    const tr=document.createElement("tr"); tr.dataset.id=s.id; if(s.id===selId)tr.className="shot-sel";
    const td=(h,cls="")=>{ const c=document.createElement("td"); if(cls)c.className=cls; c.innerHTML=h; tr.appendChild(c); return c; };
    td(i+1,"num").onclick=()=>selectShot(s.id,true);
    td(`<input class="form-control form-control-sm" value="${fmt(s.time)}">`).firstChild.onchange=e=>retime(s,parseTime(e.target.value));
    td(durOf(i).toFixed(1)+"s","text-center text-brand");
    const timg=td(s.thumb?`<img src="${s.thumb}">`:'<span class="text-muted">…</span>'); if(s.thumb)timg.firstChild.onclick=()=>selectShot(s.id,true);
    // retry if the initial batch (loadeddata) failed to produce a thumb for this shot
    if(!s.thumb && !thumbReq.has(s.id) && !genRunning){ thumbReq.add(s.id); thumbAt(s.time).then(d=>{ if(d){s.thumb=d;setThumb(s);} else thumbReq.delete(s.id); }); }  // don't race the batch
    text(td(`<textarea class="form-control form-control-sm" rows="1" placeholder="movement/ angle..."></textarea>`),s,"move");
    text(td(`<textarea class="form-control form-control-sm" rows="1" placeholder="subject…"></textarea>`),s,"focus");
    const sel=td(`<select class="form-select form-select-sm">${SHOT_TYPES.map(t=>`<option ${t===s.type?"selected":""}>${t}</option>`).join("")}</select>`).firstChild;
    sel.onchange=e=>{ pushUndo(); s.type=e.target.value; renderTimeline(); save(); };
    text(td(`<textarea class="form-control form-control-sm" rows="1" placeholder="notes…"></textarea>`),s,"remarks");
    const d=td('<button class="btn btn-sm text-danger del" title="delete">✕</button>').firstChild; d.onclick=()=>del(s.id);
    tr.onclick=e=>{ if(!e.target.closest("input,select,textarea,button")) selectShot(s.id,false); };
    rows.appendChild(tr);
  });
  autogrowAll(rows.querySelectorAll("textarea"));
}
const autogrow=t=>{ t.style.height="auto"; t.style.height=t.scrollHeight+"px"; };
// Sizing every textarea individually thrashed layout (write→read per element = one forced reflow each — ~36ms for 40
// rows). Batch it: all writes, then all reads (a single reflow), then all writes. This is the biggest renderTable win.
function autogrowAll(list){
  const tas=[...list]; if(!tas.length) return;
  for(const t of tas) t.style.height="auto";
  const hs=tas.map(t=>t.scrollHeight);
  tas.forEach((t,i)=>{ t.style.height=hs[i]+"px"; });
}
function text(cell,s,key){ const inp=cell.firstChild; inp.value=s[key];
  inp.onfocus=()=>beginAction();                                   // remember pre-edit state for undo
  inp.oninput=e=>{ commitAction(); s[key]=e.target.value; autogrow(inp); save(); }; }   // record once, on first keystroke

function highlight(){
  rows.querySelectorAll("tr").forEach(tr=>tr.classList.toggle("shot-sel", +tr.dataset.id===selId));
  timeline.querySelectorAll(".marker").forEach(m=>m.classList.toggle("sel", +m.dataset.id===selId));   // keep timeline markers in sync without a full rebuild
}

const TICK_STEPS=[0.1,0.25,0.5,1,2,5,10,15,30,60,120,300];
function renderTimeline(){
  const ae=document.activeElement;  // preserve caret across the rebuilds that fire while typing a section name
  const keep=(ae&&ae.classList&&ae.classList.contains("blabel"))?{sid:ae.dataset.sid,pos:ae.selectionStart}:null;
  timeline.querySelectorAll(".marker,.tick,.band,.bhandle,.blabel").forEach(m=>m.remove());
  const v=view();
  played.style.width=Math.max(0,Math.min(100,pct(vid.currentTime,v)))+"%";
  playhead.style.left=pct(vid.currentTime,v)+"%";
  $("#zoomLbl").textContent=zoom.toFixed(1)+"×";
  const step=TICK_STEPS.find(s=>s>=v.vis/8)||300;
  for(let tk=Math.ceil(v.start/step)*step; tk<=v.end; tk+=step){
    const el=document.createElement("div"); el.className="tick"; el.style.left=pct(tk,v)+"%";
    el.innerHTML=`<span>${tk.toFixed(step<1?1:0)}s</span>`; timeline.appendChild(el);
  }
  sections.forEach((s,i)=>{
    const start=s.start, end=secEnd(i);
    if(end<v.start-0.01||start>v.end+0.01) return;
    const L=pct(start,v), R=pct(end,v);
    if(s.id===editId){                                                     // inline rename (double-click/tap)
      const inp=document.createElement("input"); inp.className="blabel"; inp.dataset.sid=s.id;
      inp.value=s.name; inp.placeholder="name…";
      inp.style.left=Math.max(0,L)+"%"; inp.style.width=Math.max(0,R-L)+"%";
      inp.onpointerdown=ev=>ev.stopPropagation();
      inp.oninput=ev=>{ commitAction(); s.name=ev.target.value; };   // record the pre-rename state once
      const commit=()=>{ if(editId!==s.id)return; editId=null; s.name=s.name.trim(); save(); renderTimeline(); };
      inp.onkeydown=ev=>{ if(ev.key==="Enter"){ev.preventDefault();commit();} else if(ev.key==="Escape"){editId=null;renderTimeline();} };
      inp.onblur=commit;
      timeline.appendChild(inp);
    } else {
      const band=document.createElement("div"); band.className="band"+(i%2?" alt":"")+(s.name?"":" empty");
      band.style.left=L+"%"; band.style.width=Math.max(0,R-L)+"%";
      band.textContent=s.name||"name…"; band.title=s.name||"";
      band.onpointerdown=ev=>ev.stopPropagation();
      band.onclick=()=>{ const now=Date.now();                            // single click: jump to start; double: edit
        if(!isPlayback() && now-(lastSecTap[s.id]||0)<350){ lastSecTap[s.id]=0; beginAction(); editId=s.id; renderTimeline(); }   // rename locked in playback
        else { lastSecTap[s.id]=now; vid.currentTime=clampT(s.start); } };
      timeline.appendChild(band);
    }
    if(i>0 && !isPlayback()){ const h=document.createElement("div"); h.className="bhandle"; h.style.left=L+"%";   // boundary drag locked in playback
      h.onpointerdown=ev=>{ ev.stopPropagation(); beginAction(); dragSec=i; }; timeline.appendChild(h); }
  });
  if(keep){ const el=timeline.querySelector('.blabel[data-sid="'+keep.sid+'"]'); if(el){ el.focus(); try{el.setSelectionRange(keep.pos,keep.pos);}catch{} } }
  else if(editId!=null){ const el=timeline.querySelector('.blabel[data-sid="'+editId+'"]'); if(el){ el.focus(); el.select(); } }
  shots.forEach((s,i)=>{
    if(s.time<v.start-0.01||s.time>v.end+0.01)return;
    const m=document.createElement("div"); m.className="marker"+(s.id===selId?" sel":""); m.dataset.id=s.id; m.textContent=i+1;
    m.style.background=TYPE_COLOR[s.type]||"var(--pink)"; m.style.color="#3a2a33";
    m.style.left=pct(s.time,v)+"%"; dragMarker(m,s); timeline.appendChild(m);
  });
}

function dragMarker(el,s){
  el.addEventListener("pointerdown",e=>{
    e.stopPropagation();
    if(isPlayback()){ selectShot(s.id,true); return; }   // locked: tap only seeks, no dragging
    primeVideo(); beginAction();
    el.setPointerCapture(e.pointerId); let moved=false;
    el.onpointermove=ev=>{ if(!moved) commitAction(); moved=true; const v=view(); const r=timeline.getBoundingClientRect();
      let x=Math.max(0,Math.min(1,(ev.clientX-r.left)/r.width));
      s.time=clampT(v.start+x*v.vis); sortShots(); el.style.left=pct(s.time,v)+"%"; scheduleTable(); };  // table rebuild ≤1/frame
    el.onpointerup=()=>{ el.onpointermove=null; el.onpointerup=null;
      if(moved){ if(rafTable){ cancelAnimationFrame(rafTable); rafTable=0; } render(); thumbAt(s.time).then(d=>{ if(d){s.thumb=d;render();} }); save(); }
      else selectShot(s.id,true); };
  });
}

timeline.addEventListener("pointerdown",e=>{
  if(e.target.closest(".marker"))return;
  primeVideo();
  explicitSel=false;   // scrubbing empty timeline is not a shot selection — Delete must not remove the auto-highlighted shot
  timeline.setPointerCapture(e.pointerId); scrub(e);
  timeline.onpointermove=scrub; timeline.onpointerup=()=>{ timeline.onpointermove=null; timeline.onpointerup=null; };
});
function scrub(e){ const v=view(); const r=timeline.getBoundingClientRect();
  let x=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)); const t=v.start+x*v.vis;
  // ponytail: fastSeek decodes to nearest keyframe live; plain currentTime coalesces seeks so frames only show on release
  if(vid.fastSeek){ try{vid.fastSeek(t);}catch{vid.currentTime=t;} } else vid.currentTime=t;
  played.style.width=Math.max(0,Math.min(100,pct(t,v)))+"%"; playhead.style.left=pct(t,v)+"%"; }

document.addEventListener("pointermove",e=>{
  if(dragSec<0) return;
  commitAction();   // first move of this drag records the pre-drag state
  const v=view(), r=timeline.getBoundingClientRect();
  let x=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)), t=v.start+x*v.vis;
  const lo=sections[dragSec-1].start+0.02, hi=(dragSec+1<sections.length?sections[dragSec+1].start:(vid.duration||t))-0.02;
  sections[dragSec].start=Math.max(lo,Math.min(hi,t)); scheduleTimeline();   // ≤1 rebuild/frame while dragging
});
document.addEventListener("pointerup",()=>{ if(dragSec>=0){ dragSec=-1; if(rafTimeline){ cancelAnimationFrame(rafTimeline); rafTimeline=0; } renderTimeline(); save(); } });
$("#addSec").onclick=addSection;
$("#delSec").onclick=removeSection;
function jumpSection(dir){
  if(!sections.length) return;
  const t=vid.currentTime;
  if(dir>0){ const nx=sections.find(s=>s.start>t+0.05); if(nx) vid.currentTime=nx.start; }
  else{ const pr=[...sections].reverse().find(s=>s.start<t-0.05); vid.currentTime=pr?pr.start:0; }
}
$("#prevSec").onclick=()=>jumpSection(-1);
$("#nextSec").onclick=()=>jumpSection(1);
$("#modeSwitch").onchange=e=>{
  const on=e.target.checked;   // on = playback mode, off = edit mode
  document.body.classList.toggle("playback",on);
  $("#modeEdit").classList.toggle("active",!on);
  $("#modePlay").classList.toggle("active",on);
  if(on){ editId=null; releaseThumb(); }   // close any open rename + free the thumbnail decoder (no captures in playback)
  renderTimeline();        // rebuild so marker/section locks take effect immediately
};

timeline.addEventListener("wheel",e=>{ e.preventDefault(); setZoom(zoom*(e.deltaY<0?1.25:0.8)); },{passive:false});
function setZoom(z){ zoom=Math.max(1,Math.min(80,z)); viewStart=null; renderTimeline(); }
$("#zoomIn").onclick=()=>setZoom(zoom*1.4);
$("#zoomOut").onclick=()=>setZoom(zoom*0.7);

// Move only the playhead/played fill — the cheap per-frame update (~0.01ms vs ~0.4ms+ to rebuild every tick/marker/band).
function movePlayhead(v){ v=v||view();
  played.style.width=Math.max(0,Math.min(100,pct(vid.currentTime,v)))+"%";
  playhead.style.left=pct(vid.currentTime,v)+"%";
}
vid.addEventListener("timeupdate",()=>{
  const prevStart=viewStart; const v=view();           // view() re-centers only when the playhead leaves the window
  if(viewStart!==prevStart) renderTimeline();           // window scrolled → ticks/markers/bands must reposition
  else movePlayhead(v);                                 // common case: nothing structural changed, just glide the playhead
  let cur=-1; for(let i=0;i<shots.length;i++) if(shots[i].time<=vid.currentTime+0.05) cur=i;
  if(cur>=0 && shots[cur].id!==selId){ selId=shots[cur].id; explicitSel=false; highlight(); scrollToRow(selId); }   // auto-highlight ≠ user selection
});
vid.addEventListener("loadedmetadata",renderTimeline);

function retime(s,t){ if(!isFinite(t)){ renderTable(); return; }   // reject bad input; re-render restores the displayed fmt(s.time)
  pushUndo(); s.time=clampT(t); sortShots(); render(); save(); thumbAt(s.time).then(d=>{ if(d){s.thumb=d;render();} }); }

// ponytail: char-by-char parser, not split(",") — exported fields are quoted and can hold commas/quotes/newlines
function parseCSV(text){
  const rows=[]; let row=[], f="", q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
    else if(c==='"') q=true;
    else if(c===',') { row.push(f); f=""; }
    else if(c==='\n'||c==='\r'){ if(c==='\r'&&text[i+1]==='\n')i++; row.push(f); rows.push(row); row=[]; f=""; }
    else f+=c; }
  if(f!==""||row.length){ row.push(f); rows.push(row); }
  return rows;
}
function importCSV(file){
  const r=new FileReader();
  r.onload=()=>{
    const rows=parseCSV(r.result).filter(c=>c.length>1); rows.shift(); // drop header
    if(!rows.length) return;
    shots=rows.map(c=>({ id:nextId++, time:clampT(parseTime(c[1])),
      move:c[3]||"", focus:c[4]||"", type:SHOT_TYPES.includes(c[5])?c[5]:"static wide",
      remarks:c[6]||"", thumb:"" }));
    sortShots(); selId=null; save();
    generateAllThumbs(); render();
  };
  r.readAsText(file);
}
$("#import").onclick=()=>$("#importFile").click();
$("#importFile").onchange=e=>{ if(e.target.files[0]) importCSV(e.target.files[0]); e.target.value=""; };

$("#add").onclick=()=>addShot(endTime());
$("#addHere").onclick=()=>addShot(vid.currentTime);
$("#export").onclick=()=>{
  const head=["#","Time","Duration(s)","Camera movement","Focus","Shot type","Remarks"];
  const q=v=>'"'+String(v).replace(/"/g,'""')+'"';
  const lines=[head.join(",")];
  shots.forEach((s,i)=>lines.push([i+1,fmt(s.time),durOf(i).toFixed(1),s.move,s.focus,s.type,s.remarks].map(q).join(",")));
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([lines.join("\n")],{type:"text/csv"})); a.download="shotlist.csv"; a.click();
};

// ponytail: print-to-PDF via a popup, not a PDF lib — thumbnails are data URLs so they embed for free
const esc=v=>String(v).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])).replace(/\n/g,"<br>");
$("#exportPdf").onclick=()=>{
  const body=shots.map((s,i)=>`<tr><td>${i+1}</td><td>${fmt(s.time)}</td><td>${durOf(i).toFixed(1)}s</td>`+
    `<td>${s.thumb?`<img src="${s.thumb}">`:""}</td><td>${esc(s.move)}</td><td>${esc(s.focus)}</td>`+
    `<td>${esc(s.type)}</td><td>${esc(s.remarks)}</td></tr>`).join("");
  const html=`<!doctype html><meta charset="utf-8"><title>shotlist</title><style>
    body{font-family:system-ui,sans-serif;margin:16px;color:#3a2a33;}h2{color:#ff5c93;}
    table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:5px 6px;font-size:11px;vertical-align:top;text-align:left;}
    thead th{background:#ffd6e6;}img{width:160px;height:90px;object-fit:cover;border-radius:4px;}tr{break-inside:avoid;}
    </style><h2>🌸 Shot List</h2><table><thead><tr><th>#</th><th>Time</th><th>Length</th><th>Thumbnail</th>
    <th>Camera movement</th><th>Focus</th><th>Shot type</th><th>Remarks</th></tr></thead><tbody>${body}</tbody></table>`;
  const w=window.open("","_blank"); if(!w){ alert("Allow pop-ups to export PDF"); return; }
  w.document.write(html); w.document.close();
  setTimeout(()=>{ w.focus(); w.print(); },300);
};

document.addEventListener("keydown",e=>{
  if($("#app").classList.contains("d-none")) return;                 // no video loaded yet
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="z" && !e.shiftKey){ e.preventDefault(); undo(); return; }  // works even mid-edit
  if(/input|select|textarea/i.test(e.target.tagName)) return;        // don't hijack keys while typing in a cell
  if(e.key.toLowerCase()==="m"){ e.preventDefault(); addShot(vid.currentTime); return; }
  if((e.key==="Delete"||e.key==="Backspace") && selId!=null && explicitSel && !isPlayback()){ e.preventDefault(); del(selId); return; }  // only a shot the user actually clicked; locked in playback
  if(e.key===" "||e.code==="Space"){                                 // play/pause the video
    if(e.target===vid) return;                                       // let the native player toggle itself when it's focused
    e.preventDefault(); if(vid.paused) vid.play(); else vid.pause();
  }
});

(()=>{ const r=parseCSV('"a","b,c","d""e"\n"x","y\nz","w"');
  console.assert(r.length===2&&r[0][1]==="b,c"&&r[0][2]==='d"e'&&r[1][1]==="y\nz","parseCSV quotes/commas/newlines"); })();
console.assert(parseTime("1:30.5")===90.5,"parseTime mm:ss");
console.assert(fmt(90.5)==="1:30.5","fmt");
(()=>{ shots=[{time:5},{time:1},{time:3}]; sortShots();
  console.assert(shots.map(s=>s.time).join()==="1,3,5","sort");
  console.assert(durOf(0)===2,"dur"); shots=[]; })();
(()=>{ const sv=sections; sections=[{start:0,name:"a"},{start:10,name:"b"}];
  console.assert(secEnd(0)===10&&sectionIndexAt(4)===0&&sectionIndexAt(12)===1,"section split");
  sections.splice(0,1); if(sections[0].start>0) sections[0].start=0;
  console.assert(sections.length===1&&sections[0].start===0,"section remove");
  sections=sv; })();
(()=>{ const sv=sections; sections=[{start:0},{start:10},{start:25}];
  const next=t=>{const n=sections.find(s=>s.start>t+0.05);return n?n.start:t;};
  const prev=t=>{const p=[...sections].reverse().find(s=>s.start<t-0.05);return p?p.start:0;};
  console.assert(next(3)===10&&next(10)===25&&prev(12)===10&&prev(0)===0,"section jump");
  sections=sv; })();
