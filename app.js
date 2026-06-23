const $=s=>document.querySelector(s);
const vid=$("#vid"), thumbVid=$("#thumbvid"), rows=$("#rows"), timeline=$("#timeline");
const played=timeline.querySelector(".played"), playhead=timeline.querySelector(".playhead");
const SHOT_TYPES=["gimbal choreo","gimbal freestyle","static close-up","static wide"];
const TYPE_COLOR={"static wide":"#bfe3ff","static close-up":"#bfe3ff","gimbal freestyle":"#ffc2dd","gimbal choreo":"#ffc2dd"};

let shots=[], sections=[], selId=null, nextId=1, zoom=1, storeKey=null, dragSec=-1;

const fmt=t=>{ if(!isFinite(t))return"0:00.0"; const m=Math.floor(t/60),s=(t%60).toFixed(1).padStart(4,"0"); return m+":"+s; };
function parseTime(str){ str=String(str).trim(); if(str.includes(":")){const[m,s]=str.split(":");return (+m)*60+(+s);} return +str; }
const clampT=t=>Math.max(0,Math.min(t, vid.duration||t));
const sortShots=()=>shots.sort((a,b)=>a.time-b.time);
function durOf(i){ const end=(i+1<shots.length)?shots[i+1].time:(vid.duration||shots[i].time); return Math.max(0,end-shots[i].time); }

function view(){ const dur=vid.duration||1; const vis=dur/zoom; let start=vid.currentTime-vis/2; start=Math.max(0,Math.min(start,dur-vis)); if(!(start>=0))start=0; return {start,vis,end:start+vis}; }
const pct=(t,v)=>((t-v.start)/v.vis)*100;

let thumbChain=Promise.resolve();
function thumbAt(t){
  thumbChain=thumbChain.then(()=>new Promise(res=>{
    const grab=()=>{ thumbVid.removeEventListener("seeked",grab);
      const c=document.createElement("canvas"); c.width=160; c.height=90;
      try{ c.getContext("2d").drawImage(thumbVid,0,0,160,90); res(c.toDataURL("image/jpeg",0.7)); }catch{ res(""); } };
    const target=Math.min(t, thumbVid.duration||t);
    thumbVid.addEventListener("seeked",grab);
    if(Math.abs(thumbVid.currentTime-target)<0.001) grab(); else thumbVid.currentTime=target;
  }));
  return thumbChain;
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

thumbVid.addEventListener("loadeddata",()=>{ shots.forEach(s=>{ if(!s.thumb) thumbAt(s.time).then(d=>{s.thumb=d;renderTable();}); }); });

async function addShot(t){
  const s={id:nextId++, time:clampT(t), move:"", focus:"", type:"static wide", remarks:"", thumb:""};
  shots.push(s); sortShots(); selId=s.id; render(); save();
  s.thumb=await thumbAt(s.time); render();
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

const render=()=>{ renderTable(); renderTimeline(); syncAddWidth(); };
// addrow is width:100% of the *visible* wrap, so it stops short when the table scrolls wider; match table width instead
function syncAddWidth(){ const t=document.querySelector(".tablewrap table"); if(t)$("#add").style.minWidth=t.offsetWidth+"px"; }
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
    text(td(`<textarea class="form-control form-control-sm" rows="1" placeholder="pan / push…"></textarea>`),s,"move");
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
  timeline.querySelectorAll(".marker,.tick,.band,.bhandle").forEach(m=>m.remove());
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
    const band=document.createElement("div"); band.className="band"+(i%2?" alt":"")+(s.name?"":" empty");
    band.style.left=L+"%"; band.style.width=Math.max(0,R-L)+"%";
    band.textContent=s.name||"name…"; band.title=s.name||"";
    band.onpointerdown=ev=>ev.stopPropagation();
    band.onclick=()=>{ vid.currentTime=clampT(s.start); };                 // single click: jump to section start
    band.ondblclick=()=>{ const n=prompt("Section name",s.name);           // double click: rename
      if(n!==null){ s.name=n.trim(); renderTimeline(); save(); } };
    timeline.appendChild(band);
    if(i>0){ const h=document.createElement("div"); h.className="bhandle"; h.style.left=L+"%";
      h.onpointerdown=ev=>{ ev.stopPropagation(); dragSec=i; }; timeline.appendChild(h); }
  });
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
      if(moved){ render(); thumbAt(s.time).then(d=>{s.thumb=d;render();}); save(); }
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

timeline.addEventListener("wheel",e=>{ e.preventDefault(); setZoom(zoom*(e.deltaY<0?1.25:0.8)); },{passive:false});
function setZoom(z){ zoom=Math.max(1,Math.min(80,z)); renderTimeline(); }
$("#zoomIn").onclick=()=>setZoom(zoom*1.4);
$("#zoomOut").onclick=()=>setZoom(zoom*0.7);

vid.addEventListener("timeupdate",()=>{
  renderTimeline();
  let cur=-1; for(let i=0;i<shots.length;i++) if(shots[i].time<=vid.currentTime+0.05) cur=i;
  if(cur>=0 && shots[cur].id!==selId){ selId=shots[cur].id; highlight(); scrollToRow(selId); }
});
vid.addEventListener("loadedmetadata",renderTimeline);

function retime(s,t){ s.time=clampT(t); sortShots(); render(); save(); thumbAt(s.time).then(d=>{s.thumb=d;render();}); }

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
