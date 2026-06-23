const $=s=>document.querySelector(s);
const vid=$("#vid"), thumbVid=$("#thumbvid"), rows=$("#rows"), timeline=$("#timeline");
const played=timeline.querySelector(".played"), playhead=timeline.querySelector(".playhead");
const SHOT_TYPES=["gimbal choreo","gimbal freestyle","static close-up","static wide"];
const TYPE_COLOR={"static wide":"#bfe3ff","static close-up":"#bfe3ff","gimbal freestyle":"#ffc2dd","gimbal choreo":"#ffc2dd"};

let shots=[], sections=[], selId=null, nextId=1, zoom=1, storeKey=null, dragSec=-1, editId=null;
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
function capture(t){
  return new Promise(res=>{
    let done=false;
    const finish=v=>{ if(done)return; done=true; thumbVid.removeEventListener("seeked",onSeeked); res(v); };
    const draw=()=>{ if(done)return;
      try{ const c=document.createElement("canvas"); c.width=160; c.height=90;
        c.getContext("2d").drawImage(thumbVid,0,0,160,90); finish(c.toDataURL("image/jpeg",0.7)); }catch{ finish(""); } };
    // rAF gives iOS a paint tick to composite the seek frame; setTimeout is the backstop (rAF is paused on backgrounded tabs)
    const schedule=()=>{ requestAnimationFrame(draw); setTimeout(draw,60); };
    const onSeeked=()=>schedule();
    const target=Math.min(t, thumbVid.duration||t);
    // ponytail: register BOTH frame signals and let whichever fires first win — Chromium fires `seeked` (rVFC doesn't fire
    // for paused seeks), iOS Safari presents the seek frame to rVFC; neither alone is reliable across both
    thumbVid.addEventListener("seeked",onSeeked);
    if(thumbVid.requestVideoFrameCallback) thumbVid.requestVideoFrameCallback(draw);
    if(Math.abs(thumbVid.currentTime-target)<0.001) schedule();  // already there → no seek event coming
    else thumbVid.currentTime=target;
  });
}
function thumbAt(t){
  // ponytail: race the chain itself against a hard 2.5s timeout, so one hung capture can't block every future thumbnail
  const work=thumbChain.then(()=>capture(t));
  const guarded=Promise.race([work, new Promise(res=>setTimeout(()=>res(""),2500))]);
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
  vid.src=url; thumbVid.src=url;
  storeKey="shotlist:"+file.name+":"+file.size;
  shots=[]; selId=null; nextId=1; zoom=1;
  restore();
  $("#drop").classList.add("d-none"); $("#app").classList.remove("d-none");
  render();
}

$("#drop").onclick=()=>$("#file").click();
$("#file").onchange=e=>{ if(e.target.files[0]) load(e.target.files[0]); };
$("#drop").ondragover=e=>e.preventDefault();
$("#drop").ondrop=e=>{ e.preventDefault(); if(e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); };
$("#swap").onclick=()=>$("#file").click();

thumbVid.addEventListener("loadeddata",()=>{
  // ponytail: iOS Safari won't decode frames for canvas until the video has actually run once; play+pause unlocks it
  thumbVid.play().then(()=>thumbVid.pause()).catch(()=>{});
  shots.forEach(s=>{ if(!s.thumb) thumbAt(s.time).then(d=>{ if(d){s.thumb=d;renderTable();} }); });
});

async function addShot(t){
  const s={id:nextId++, time:clampT(t), move:"", focus:"", type:"static wide", remarks:"", thumb:""};
  shots.push(s); sortShots(); selId=s.id; render(); save();
  const d=await thumbAt(s.time); if(d){ s.thumb=d; render(); }
}
function endTime(){ if(!shots.length) return vid.currentTime; const last=shots[shots.length-1].time; return Math.min(last+5, vid.duration||last+5); }

const sortSections=()=>sections.sort((a,b)=>a.start-b.start);
function secEnd(i){ return i+1<sections.length ? sections[i+1].start : (vid.duration||sections[i].start); }
function sectionIndexAt(t){ let idx=-1; for(let i=0;i<sections.length;i++) if(sections[i].start<=t+1e-6) idx=i; return idx; }
function addSection(){
  const t=vid.currentTime, dur=vid.duration||0;
  if(t<=0.05 || (dur && t>=dur-0.05)) return;
  if(!sections.length) sections=[{id:nextId++,start:0,name:""}];
  if(!sections.some(s=>Math.abs(s.start-t)<0.05)) sections.push({id:nextId++,start:t,name:""});
  sortSections(); renderTimeline(); save();
}
function removeSection(){
  if(!sections.length) return;
  const i=sectionIndexAt(vid.currentTime); if(i<0) return;
  sections.splice(i,1);
  if(sections.length && sections[0].start>0.0001) sections[0].start=0;
  renderTimeline(); save();
}
function del(id){ shots=shots.filter(s=>s.id!==id); if(selId===id)selId=null; render(); save(); }
function selectShot(id,seek){ selId=id; const s=shots.find(x=>x.id===id);
  if(s&&seek) vid.currentTime=s.time;
  highlight(); renderTimeline(); scrollToRow(id);
}

const render=()=>{ renderTable(); renderTimeline(); };
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
    if(!s.thumb && !thumbReq.has(s.id)){ thumbReq.add(s.id); thumbAt(s.time).then(d=>{ if(d){s.thumb=d;renderTable();} else thumbReq.delete(s.id); }); }
    text(td(`<textarea class="form-control form-control-sm" rows="1" placeholder="movement/angle"></textarea>`),s,"move");
    text(td(`<textarea class="form-control form-control-sm" rows="1" placeholder="subject…"></textarea>`),s,"focus");
    const sel=td(`<select class="form-select form-select-sm">${SHOT_TYPES.map(t=>`<option ${t===s.type?"selected":""}>${t}</option>`).join("")}</select>`).firstChild;
    sel.onchange=e=>{ s.type=e.target.value; renderTimeline(); save(); };
    text(td(`<textarea class="form-control form-control-sm" rows="1" placeholder="notes…"></textarea>`),s,"remarks");
    const d=td('<button class="btn btn-sm text-danger del" title="delete">✕</button>').firstChild; d.onclick=()=>del(s.id);
    tr.onclick=e=>{ if(!e.target.closest("input,select,textarea,button")) selectShot(s.id,false); };
    rows.appendChild(tr);
  });
  rows.querySelectorAll("textarea").forEach(autogrow);
}
const autogrow=t=>{ t.style.height="auto"; t.style.height=t.scrollHeight+"px"; };
function text(cell,s,key){ const inp=cell.firstChild; inp.value=s[key]; inp.oninput=e=>{ s[key]=e.target.value; autogrow(inp); save(); }; }

function highlight(){ rows.querySelectorAll("tr").forEach(tr=>tr.classList.toggle("shot-sel", +tr.dataset.id===selId)); }

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
      inp.oninput=ev=>{ s.name=ev.target.value; };
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
        if(now-(lastSecTap[s.id]||0)<350){ lastSecTap[s.id]=0; editId=s.id; renderTimeline(); }
        else { lastSecTap[s.id]=now; vid.currentTime=clampT(s.start); } };
      timeline.appendChild(band);
    }
    if(i>0){ const h=document.createElement("div"); h.className="bhandle"; h.style.left=L+"%";
      h.onpointerdown=ev=>{ ev.stopPropagation(); dragSec=i; }; timeline.appendChild(h); }
  });
  if(keep){ const el=timeline.querySelector('.blabel[data-sid="'+keep.sid+'"]'); if(el){ el.focus(); try{el.setSelectionRange(keep.pos,keep.pos);}catch{} } }
  else if(editId!=null){ const el=timeline.querySelector('.blabel[data-sid="'+editId+'"]'); if(el){ el.focus(); el.select(); } }
  shots.forEach((s,i)=>{
    if(s.time<v.start-0.01||s.time>v.end+0.01)return;
    const m=document.createElement("div"); m.className="marker"+(s.id===selId?" sel":""); m.textContent=i+1;
    m.style.background=TYPE_COLOR[s.type]||"var(--pink)"; m.style.color="#3a2a33";
    m.style.left=pct(s.time,v)+"%"; dragMarker(m,s); timeline.appendChild(m);
  });
}

function dragMarker(el,s){
  el.addEventListener("pointerdown",e=>{
    e.stopPropagation(); el.setPointerCapture(e.pointerId); let moved=false;
    el.onpointermove=ev=>{ moved=true; const v=view(); const r=timeline.getBoundingClientRect();
      let x=Math.max(0,Math.min(1,(ev.clientX-r.left)/r.width));
      s.time=clampT(v.start+x*v.vis); sortShots(); el.style.left=pct(s.time,v)+"%"; renderTable(); };
    el.onpointerup=()=>{ el.onpointermove=null; el.onpointerup=null;
      if(moved){ render(); thumbAt(s.time).then(d=>{ if(d){s.thumb=d;render();} }); save(); }
      else selectShot(s.id,true); };
  });
}

timeline.addEventListener("pointerdown",e=>{
  if(e.target.closest(".marker"))return;
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
  const v=view(), r=timeline.getBoundingClientRect();
  let x=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)), t=v.start+x*v.vis;
  const lo=sections[dragSec-1].start+0.02, hi=(dragSec+1<sections.length?sections[dragSec+1].start:(vid.duration||t))-0.02;
  sections[dragSec].start=Math.max(lo,Math.min(hi,t)); renderTimeline();
});
document.addEventListener("pointerup",()=>{ if(dragSec>=0){ dragSec=-1; save(); } });
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
$("#miniToggle").onclick=()=>{
  const on=document.body.classList.toggle("mini");
  $("#miniToggle").textContent=on?"⤡":"⤢";
  if(on){ setZoom(1); }   // lock zoom to 1.0× in minimised mode
};

timeline.addEventListener("wheel",e=>{ e.preventDefault(); setZoom(zoom*(e.deltaY<0?1.25:0.8)); },{passive:false});
function setZoom(z){ if(document.body.classList.contains("mini")) z=1; zoom=Math.max(1,Math.min(80,z)); viewStart=null; renderTimeline(); }
$("#zoomIn").onclick=()=>setZoom(zoom*1.4);
$("#zoomOut").onclick=()=>setZoom(zoom*0.7);

vid.addEventListener("timeupdate",()=>{
  renderTimeline();
  let cur=-1; for(let i=0;i<shots.length;i++) if(shots[i].time<=vid.currentTime+0.05) cur=i;
  if(cur>=0 && shots[cur].id!==selId){ selId=shots[cur].id; highlight(); scrollToRow(selId); }
});
vid.addEventListener("loadedmetadata",renderTimeline);

function retime(s,t){ if(!isFinite(t)){ renderTable(); return; }   // reject bad input; re-render restores the displayed fmt(s.time)
  s.time=clampT(t); sortShots(); render(); save(); thumbAt(s.time).then(d=>{ if(d){s.thumb=d;render();} }); }

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
    sortShots(); selId=null; render(); save();
    shots.forEach(s=>thumbAt(s.time).then(d=>{s.thumb=d;renderTable();}));
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
  if(e.key.toLowerCase()==="m" && !/input|select|textarea/i.test(e.target.tagName) && !$("#app").classList.contains("d-none")){ e.preventDefault(); addShot(vid.currentTime); }
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
