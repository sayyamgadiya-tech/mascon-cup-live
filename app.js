import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, signInWithEmailAndPassword, signOut, onAuthStateChanged, EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, onSnapshot, setDoc, deleteDoc, getDoc, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ================= config ================= */
const CFG = window.MASCON_CONFIG || {};
const POOL = window.MASCON_POOL || [];
const PRESET = window.MASCON_TEAMS || [];
const DEF={name:"Ahore Mascon Cup 2026",overs:12,xi:11,minXi:9,squad:13,wideRuns:1,nbRuns:1,freeHit:true,noLbw:true,noLegBye:true,ptsWin:2,ptsTie:1,ptsNR:1,teams:[]};
const STAGES={A:"Group A",B:"Group B",QF1:"Quarter-final 1",QF2:"Quarter-final 2",SF1:"Semi-final 1",SF2:"Semi-final 2",F:"Final"};
const isLeague=m=>m.stage==="A"||m.stage==="B";
const LIVE=["live","break","super","setup"];

let T=null,M={},db=null,auth=null,uid=null,canScore=false,loaded={t:false,m:false},fatal="";
let ui={tab:"live",sel:null,scoreSel:null,sheet:null,draft:null,nm:null,toss:null,stat:"runs",loginErr:"",busyLogin:false};
let pendingConfirm=null,renderDeferred=false,syncState={c:"sync",t:""};
const polls={};
let fantasyLockWritten=false;
let FT={mine:null,myId:null,all:null,allAt:0,draft:null,q:"",err:""};
try{FT.myId=localStorage.getItem("mc-fid")||null}catch(e){}
try{const h=location.hash.slice(1);if(["live","matches","table","stats","fantasy"].includes(h))ui.tab=h}catch(e){}
try{const s=sessionStorage.getItem("mc-score");if(s)ui.scoreSel=s}catch(e){}

/* ================= helpers ================= */
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uidGen=p=>p+Date.now().toString(36).slice(-4)+Math.random().toString(36).slice(2,7);
const clone=o=>JSON.parse(JSON.stringify(o));
const last=a=>a[a.length-1];
const teamOf=id=>(T?.teams||[]).find(t=>t.id===id);
const tname=id=>teamOf(id)?.name||"TBD";
function pname(id){if(!id)return"—";for(const t of T?.teams||[]){const p=t.players.find(p=>p.id===id);if(p)return p.name}return"Player"}
function pteam(id){for(const t of T?.teams||[])if(t.players.some(p=>p.id===id))return t.id;return null}
const isLegal=b=>b.t!=="wd"&&b.t!=="nb";
const ovs=l=>Math.floor(l/6)+"."+(l%6);
const ballRuns=b=>b.t==="wd"?T.wideRuns+b.r:b.t==="nb"?T.nbRuns+b.r:b.r;
const rate=(r,l)=>l?(r*6/l).toFixed(2):"0.00";
const mOvers=m=>m.overs||T.overs;
const ovFor=(m,i)=>i===1&&m.ov2?m.ov2:mOvers(m);
function xiOf(m,team){const x=m.xi?.[team];if(x&&x.length)return x;return(teamOf(team)?.players||[]).slice(0,T.xi).map(p=>p.id)}
const maxW=(m,team)=>Math.max(1,xiOf(m,team).length-1);
const xiPlayers=(m,team)=>xiOf(m,team).map(id=>({id,name:pname(id)}));

/* special overs: powerplay 1–2 and the Mascon over (7th of 12, 6th of 10); 8 overs: 1st + Mascon */
function specials(overs){
  if(overs>=9)return{pp:[1,2],mascon:Math.floor(overs/2)+1};
  if(overs>=7)return{pp:[1],mascon:Math.floor(overs/2)+1};
  return{pp:[],mascon:null};
}
function overTag(overs,n){const s=specials(overs);if(s.pp.includes(n))return"Powerplay";if(s.mascon===n)return"Mascon over";return""}
/* bowling matrix, five bowlers minimum: 12 ov = 2×3 + 3×2, 10 ov = 5×2, 8 ov = 3×2 + 2×1 */
function matrix(overs){const max=Math.ceil(overs/5);return{max,atMax:overs-5*(max-1)}}

const KINDS=[["b","Bowled"],["c","Caught"],["ro","Run out"],["st","Stumped"],["lbw","LBW"],["hw","Hit wicket"],["x","Other"]];
function dismissal(b){
  const bw=pname(b.bw),f=b.w.f?pname(b.w.f):"";
  switch(b.w.k){
    case"b":return"b "+bw;
    case"c":return b.w.f===b.bw?"c & b "+bw:(f?"c "+f+" ":"c ")+"b "+bw;
    case"ro":return"run out"+(f?" ("+f+")":"");
    case"st":return"st "+(f||"keeper")+" b "+bw;
    case"lbw":return"lbw b "+bw;
    case"hw":return"hit wicket b "+bw;
    default:return"out";
  }
}
function chip(b){
  let t,c="";
  if(b.t==="run"){t=b.r===0?"•":b.r;c=b.r===4?"f":b.r===6?"s":""}
  else if(b.t==="wd"){const n=ballRuns(b);t=(n>1?n:"")+"wd";c="x"}
  else if(b.t==="nb"){t="nb"+(b.r?"+"+b.r:"");c=b.r===4?"f":b.r===6?"s":"x"}
  else{t=b.r+(b.t==="bye"?"b":"lb");c="x"}
  if(b.w){t="W"+(b.r?"+"+b.r:"");c="w"}
  return`<span class="b ${c}">${esc(t)}</span>`;
}

/* ================= engine ================= */
function innStats(inn){
  const st={runs:0,wk:0,legal:0,ex:{wd:0,nb:0,b:0,lb:0},bat:{},batOrder:[],bowl:{},bowlOrder:[],fow:[],cur:[],log:[],overBowler:{}};
  const B=id=>{if(!id)return null;if(!st.bat[id]){st.bat[id]={r:0,b:0,f:0,s:0,out:null};st.batOrder.push(id)}return st.bat[id]};
  const W=id=>{if(!st.bowl[id]){st.bowl[id]={l:0,r:0,w:0,wd:0,nb:0};st.bowlOrder.push(id)}return st.bowl[id]};
  (inn.open||[]).forEach(B);
  let over=[];
  for(const b of inn.balls){
    B(b.s);B(b.ns);
    const bt=st.bat[b.s],bw=W(b.bw),tot=ballRuns(b),before=st.legal;
    st.overBowler[Math.floor(before/6)+1]=b.bw;
    st.runs+=tot;
    if(b.t==="run"||b.t==="nb"){bt.r+=b.r;if(b.r===4)bt.f++;if(b.r===6)bt.s++}
    if(b.t!=="wd")bt.b++;
    if(b.t==="wd"){st.ex.wd+=tot;bw.r+=tot;bw.wd++}
    else if(b.t==="nb"){st.ex.nb+=T.nbRuns;bw.r+=tot;bw.nb++}
    else if(b.t==="bye")st.ex.b+=b.r;
    else if(b.t==="lb")st.ex.lb+=b.r;
    else bw.r+=b.r;
    if(isLegal(b)){st.legal++;bw.l++}
    over.push(b);
    if(b.w){st.wk++;const o=B(b.w.out);o.out=dismissal(b);if(b.w.k!=="ro"&&b.w.k!=="x")bw.w++;
      st.fow.push({n:st.wk,r:st.runs,id:b.w.out,ov:ovs(st.legal)})}
    st.log.push({b,lab:Math.floor(before/6)+"."+(before%6+1)});
    if(isLegal(b)&&st.legal%6===0)over=[];
  }
  st.cur=over;
  return st;
}
function targetOf(m){if(m.inn.length<2)return null;return m.tgt||innStats(m.inn[0]).runs+1}
function isFreeHit(inn){if(!T.freeHit)return false;const l=last(inn.balls);return!!l&&(l.t==="nb"||(l.fh&&l.t==="wd"))}
function availBatters(m,inn){const st=innStats(inn);const used=new Set([...st.batOrder,inn.cur.s,inn.cur.ns].filter(Boolean));return xiPlayers(m,inn.bat).filter(p=>!used.has(p.id))}
function bowlerOptions(m,i){
  const inn=m.inn[i],st=innStats(inn),overs=ovFor(m,i),mx=matrix(overs),sp=specials(overs);
  const next=Math.floor(st.legal/6)+1;
  const prev=st.legal>0?st.overBowler[next-1]:null;
  const atMax=Object.keys(st.bowl).filter(id=>st.bowl[id].l>=mx.max*6).length;
  const isSpecial=n=>sp.pp.includes(n)||sp.mascon===n;
  const specialBy=new Set(Object.entries(st.overBowler).filter(([n])=>isSpecial(+n)&&+n!==next).map(([,id])=>id));
  return xiPlayers(m,inn.bowl).map(p=>{
    const done=Math.floor((st.bowl[p.id]?.l||0)/6);let why="",block=false;
    if(p.id===prev){why="bowled last over";block=true}
    else if(done>=mx.max)why=`${mx.max}-over quota done`;
    else if(done===mx.max-1&&mx.max>1&&atMax>=mx.atMax)why=`${mx.atMax} bowlers already bowled ${mx.max}`;
    else if(isSpecial(next)&&specialBy.has(p.id))why="already bowled a special over";
    return{id:p.id,name:`${p.name} (${done} ov)`,disabled:block,why};
  });
}
function checkEnd(m){
  const i=m.inn.length-1,inn=m.inn[i],st=innStats(inn),tg=targetOf(m);
  if(st.wk>=maxW(m,inn.bat)||st.legal>=ovFor(m,i)*6||(tg&&st.runs>=tg))closeInn(m);
}
function closeInn(m){last(m.inn).closed=true;if(m.inn.length===1)m.status="break";else finalize(m)}
function finalize(m){
  const s2=innStats(m.inn[1]),i2=m.inn[1],tg=targetOf(m);
  m.how="normal";
  if(s2.runs>=tg){const w=maxW(m,i2.bat)-s2.wk,left=ovFor(m,1)*6-s2.legal;
    m.winner=i2.bat;m.result=`${tname(i2.bat)} won by ${w} wicket${w===1?"":"s"}`+(left>0?` (${left} ball${left===1?"":"s"} left)`:"");m.status="done"}
  else if(s2.runs===tg-1){
    if(isLeague(m)){m.winner="tie";m.result="Match tied · 1 point each";m.status="done"}
    else{m.winner=null;m.result="Scores level · Super Over to decide";m.status="super"}
  }else{const d=tg-1-s2.runs;m.winner=m.inn[0].bat;m.result=`${tname(m.inn[0].bat)} won by ${d} run${d===1?"":"s"}`;m.status="done"}
}
function batFirst(m){return m.chose==="bat"?m.toss:(m.toss===m.a?m.b:m.a)}

/* ================= tables & stats ================= */
function pointsTable(group){
  const rows={};(T?.teams||[]).filter(t=>t.group===group).forEach(t=>rows[t.id]={id:t.id,p:0,w:0,l:0,t:0,nr:0,pts:0,rf:0,bf:0,ra:0,bb:0});
  Object.values(M).filter(m=>m.stage===group&&m.status==="done").forEach(m=>{
    if(m.how==="normal"&&m.inn.length===2)m.inn.forEach((inn,i)=>{const st=innStats(inn);const balls=st.wk>=maxW(m,inn.bat)?ovFor(m,i)*6:st.legal;
      const R=rows[inn.bat],F=rows[inn.bowl];if(R){R.rf+=st.runs;R.bf+=balls}if(F){F.ra+=st.runs;F.bb+=balls}});
    [m.a,m.b].forEach(id=>{const r=rows[id];if(!r)return;r.p++;
      if(m.winner==="tie"){r.t++;r.pts+=T.ptsTie}else if(m.winner==="nr"){r.nr++;r.pts+=T.ptsNR}else if(m.winner===id){r.w++;r.pts+=T.ptsWin}else r.l++});
  });
  return Object.values(rows).map(r=>({...r,nrr:(r.bf?r.rf/(r.bf/6):0)-(r.bb?r.ra/(r.bb/6):0)})).sort((a,b)=>b.pts-a.pts||b.nrr-a.nrr||b.w-a.w);
}
function tourStats(){
  const bat={},bowl={};
  Object.values(M).forEach(m=>(m.inn||[]).forEach(inn=>{const st=innStats(inn);
    st.batOrder.forEach(id=>{const b=st.bat[id],x=bat[id]||(bat[id]={r:0,b:0,f:0,s:0,inns:0,outs:0,hs:-1,hsNo:false});
      x.r+=b.r;x.b+=b.b;x.f+=b.f;x.s+=b.s;x.inns++;if(b.out)x.outs++;if(b.r>x.hs||(b.r===x.hs&&!b.out)){x.hs=b.r;x.hsNo=!b.out}});
    st.bowlOrder.forEach(id=>{const b=st.bowl[id],x=bowl[id]||(bowl[id]={l:0,r:0,w:0,bw:-1,br:0});
      x.l+=b.l;x.r+=b.r;x.w+=b.w;if(b.w>x.bw||(b.w===x.bw&&b.r<x.br)){x.bw=b.w;x.br=b.r}});
  }));
  return{bat,bowl};
}


/* ================= fantasy ================= */
const FP={run:1,four:1,six:2,thirty:4,fifty:8,wkt:25,haul3:8,field:8,dot:1,maiden:12,duck:-2};
function fantasyPoints(){
  const pts={};const add=(id,n)=>{if(id)pts[id]=(pts[id]||0)+n};
  Object.values(M).forEach(m=>(m.inn||[]).forEach(inn=>{
    const st=innStats(inn);
    st.batOrder.forEach(id=>{const b=st.bat[id];let p=b.r*FP.run+b.f*FP.four+b.s*FP.six;if(b.r>=50)p+=FP.fifty;else if(b.r>=30)p+=FP.thirty;if(b.out&&b.r===0&&b.b>0)p+=FP.duck;add(id,p)});
    st.bowlOrder.forEach(id=>{const b=st.bowl[id];add(id,b.w*FP.wkt+(b.w>=3?FP.haul3:0))});
    const overs={};
    inn.balls.forEach(b=>{
      if(b.w){if(b.w.k==="c"||b.w.k==="st")add(b.w.f,FP.field);if(b.w.k==="ro"&&b.w.f)add(b.w.f,FP.field)}
      if(b.t==="run"&&b.r===0&&!b.w)add(b.bw,FP.dot);
    });
    // maiden: six legal balls, no runs off bat or extras charged to the bowler
    let ov=[],clean=true;
    inn.balls.forEach(b=>{if(!isLegal(b))clean=false;else{if(b.r>0&&b.t!=="bye")clean=false;ov.push(b);if(ov.length===6){if(clean)add(ov[0].bw,FP.maiden);ov=[];clean=true}}});
  }));
  return pts;
}
function fantasyLocked(){return Object.values(M).some(m=>(m.inn||[]).some(i=>i.balls.length>0))}
async function loadFantasy(force){
  if(!db)return;const now=Date.now();if(!force&&FT.all&&now-FT.allAt<120000)return;FT.allAt=now;
  try{const s=await getDocs(collection(db,"fantasy"));FT.all=s.docs.map(d=>({id:d.id,...d.data()}));
    if(FT.myId){FT.mine=FT.all.find(t=>t.id===FT.myId)||null}scheduleRender()}catch(e){}
}
function fantasyBoard(){
  const pts=fantasyPoints();
  return (FT.all||[]).map(t=>({...t,pts:(t.p||[]).reduce((a,id)=>a+(pts[id]||0),0)})).sort((a,b)=>b.pts-a.pts||a.name.localeCompare(b.name));
}
function allPlayers(){return(T?.teams||[]).flatMap(t=>t.players.map(p=>({id:p.id,name:p.name,role:p.role||"",team:t.name,tid:t.id})))}
function fantasyView(){
  if(!T||!T.teams.length)return`<section><div class="empty"><strong>Fantasy league opens after the auction</strong>Once the squads are in, pick your 13 players from any team.</div></section>`;
  loadFantasy();
  const locked=fantasyLocked(),pts=fantasyPoints();
  const board=fantasyBoard();
  const rank=FT.mine?board.findIndex(t=>t.id===FT.mine.id)+1:0;
  const nm=id=>{const p=allPlayers().find(p=>p.id===id);return p?`${esc(p.name)} <span class="muted small">${esc(p.team)}</span>`:"Player"};
  let mine="";
  if(FT.draft&&!locked)mine=pickerHtml();
  else if(FT.mine){
    const my=board.find(t=>t.id===FT.mine.id)||FT.mine;
    mine=`<div class="panel"><div class="row-btns" style="justify-content:space-between;align-items:center"><h2>${esc(my.name)}'s XIII</h2><span class="bigpts">${my.pts||0} pts${rank?` · #${rank}`:""}</span></div>
    <div class="tbl"><table><thead><tr><th>Player</th><th>Pts</th></tr></thead><tbody>${(my.p||[]).map(id=>`<tr><td class="n">${nm(id)}</td><td><b>${pts[id]||0}</b></td></tr>`).join("")}</tbody></table></div>
    ${locked?`<p class="kv">Teams are locked for the tournament.</p>`:`<div class="row-btns"><button class="btn" data-act="fEdit">Change my team</button><button class="btn warn" data-act="fForget">Not my team</button></div>`}</div>`;
  }else mine=locked?`<div class="panel"><h2>Entries closed</h2><p class="kv">Fantasy teams locked when the first ball was bowled.</p></div>`
    :`<div class="panel"><h2>Build your XIII</h2><p class="kv">Pick any 13 players from the 10 squads. One team per person; it locks at the first ball on 29 November.</p><button class="btn pri" data-act="fNew">Pick my 13</button></div>`;
  const lb=board.length?`<h2>Leaderboard</h2><div class="tbl"><table><thead><tr><th>#</th><th style="text-align:left">Team</th><th>Pts</th></tr></thead><tbody>${board.slice(0,100).map((t,i)=>`<tr${t.id===FT.mine?.id?' class="q"':""}><td style="text-align:left">${i+1}</td><td class="n" style="text-align:left"><b>${esc(t.name)}</b></td><td><b>${t.pts}</b></td></tr>`).join("")}</tbody></table></div><p class="kv">${board.length} team${board.length===1?"":"s"} entered.</p>`:"";
  const scoring=`<details class="card"><summary><span>How points work</span></summary><div class="in kv">Run 1 · Four +1 · Six +2 · 30 runs +4 · 50 runs +8 · Duck −2<br>Wicket 25 · 3 wickets +8 · Catch, stumping or run-out 8<br>Dot ball 1 · Maiden over 12</div></details>`;
  return`<section>${mine}${lb}${scoring}</section>`;
}
function pickerHtml(){
  const d=FT.draft,q=FT.q.trim().toLowerCase();
  const sel=new Set(d.p);
  const list=allPlayers().filter(p=>!q||p.name.toLowerCase().includes(q)||p.team.toLowerCase().includes(q));
  const byTeam={};list.forEach(p=>(byTeam[p.team]||(byTeam[p.team]=[])).push(p));
  const full=sel.size>=13;
  return`<div class="panel"><div class="row-btns" style="justify-content:space-between;align-items:center"><h2>Pick your 13</h2><span class="bigpts">${sel.size}/13</span></div>
  <div class="field"><label class="label" for="f-name">Your name (shown on the leaderboard)</label><input id="f-name" value="${esc(d.name)}" maxlength="30" placeholder="e.g. Rahul D" data-fname="1"></div>
  ${sel.size?`<div class="chips">${d.p.map(id=>{const p=allPlayers().find(x=>x.id===id);return`<button class="chip" data-act="fTog" data-id="${id}">${esc(p?.name||"?")} ✕</button>`}).join("")}</div>`:""}
  <input id="f-q" placeholder="Search player or team" value="${esc(FT.q)}" data-fq="1">
  ${Object.entries(byTeam).map(([team,ps])=>`<div class="label">${esc(team)}</div><div class="xi">${ps.map(p=>`<label class="${sel.has(p.id)?"on":""}${full&&!sel.has(p.id)?" dim":""}"><input type="checkbox" data-fpick="${p.id}"${sel.has(p.id)?" checked":""}${full&&!sel.has(p.id)?" disabled":""}>${esc(p.name)}${p.role?` <span class="muted small">${esc(p.role)}</span>`:""}</label>`).join("")}</div>`).join("")}
  ${FT.err?`<div class="msg" style="color:var(--out)">${esc(FT.err)}</div>`:""}
  <div class="row-btns"><button class="btn pri" data-act="fSave"${sel.size===13?"":" disabled"}>Save my team</button><button class="btn" data-act="fCancel">Cancel</button></div></div>`;
}
async function saveFantasy(){
  const d=FT.draft;const name=(d.name||"").trim();
  if(name.length<2){FT.err="Enter your name.";render();return}
  if(d.p.length!==13){FT.err="Pick exactly 13 players.";render();return}
  if(fantasyLocked()){FT.err="Entries closed: the tournament has started.";render();return}
  if(!uid){FT.err="No connection. Try again in a moment.";render();return}
  const id=uid;
  try{await setDoc(doc(db,"fantasy",id),{name,p:d.p,uid,at:Date.now()});FT.myId=id;try{localStorage.setItem("mc-fid",id)}catch(e){}
    FT.mine={id,name,p:d.p};FT.draft=null;FT.err="";loadFantasy(true);render()}
  catch(e){FT.err=e?.code==="permission-denied"?"Entries are closed or this name is already taken on another phone.":"Not saved. Check your connection.";render()}
}

/* ================= predictions ================= */
async function loadPoll(mid,force){
  if(!db)return;const p=polls[mid];
  if(!force&&p&&Date.now()-p.at<60000)return;
  polls[mid]={c:p?.c||{},mine:p?.mine||null,at:Date.now()};
  try{const s=await getDoc(doc(db,"polls",mid));const d=s.exists()?s.data():{};const c={};
    for(const k in d)c[d[k]]=(c[d[k]]||0)+1;
    polls[mid]={c,mine:uid?d[uid]||null:null,at:Date.now()};scheduleRender()}catch(e){}
}
function pollHtml(m){
  if(!db)return"";const p=polls[m.id];if(!p){loadPoll(m.id);return""}
  loadPoll(m.id);
  const ca=p.c[m.a]||0,cb=p.c[m.b]||0,tot=ca+cb,pa=tot?Math.round(ca*100/tot):50;
  const open=m.status==="scheduled"||m.status==="setup";
  if(!open&&!tot)return"";
  const side=(id,n,pc)=>`<button class="pick${p.mine===id?" mine":""}" data-act="vote" data-m="${m.id}" data-t="${id}"${open&&uid?"":" disabled"}><span>${esc(tname(id))}${p.mine===id?" · your pick":""}</span><b>${tot?pc+"%":"–"}</b></button>`;
  const head=open?(p.mine?"Your prediction is in. You can change it until the first ball.":"Who wins? Tap to predict."):`Fans' prediction · ${tot} vote${tot===1?"":"s"}`;
  return`<div class="poll"><div class="label">${head}</div><div class="bar"><span style="width:${pa}%"></span></div><div class="picks">${side(m.a,ca,pa)}${side(m.b,cb,100-pa)}</div>${open&&tot?`<div class="kv">${tot} vote${tot===1?"":"s"} so far</div>`:""}</div>`;
}
async function vote(mid,team){
  if(!uid){flash("Predictions need a connection. Try again in a moment.");return}
  const p=polls[mid]||{c:{},mine:null,at:0};
  if(p.mine)p.c[p.mine]=Math.max(0,(p.c[p.mine]||1)-1);
  p.c[team]=(p.c[team]||0)+1;p.mine=team;polls[mid]=p;render();
  try{await setDoc(doc(db,"polls",mid),{[uid]:team},{merge:true});loadPoll(mid,true)}
  catch(e){flash("Prediction not saved. Voting closes at the first ball.");loadPoll(mid,true)}
}

/* ================= storage ================= */
function setSync(c,t){syncState={c:"sync"+(c==="err"?" err":""),t};const el=$("#sync");if(el){el.className=syncState.c;el.textContent=t}}
const strip=o=>JSON.parse(JSON.stringify(o));
function saveMatch(m){
  m.upd=Date.now();M[m.id]=m;
  if(!fantasyLockWritten&&(m.inn||[]).some(i=>i.balls.length)){fantasyLockWritten=true;setDoc(doc(db,"meta","lock"),{at:Date.now()}).catch(()=>{fantasyLockWritten=false})}
  try{sessionStorage.setItem("mc-score",ui.scoreSel||"")}catch(e){}
  render();
  setDoc(doc(db,"matches",m.id),strip(m)).catch(e=>{setSync("err",e?.code==="permission-denied"?"Not saved: log in again":"Not saved");if(e?.code==="permission-denied"){canScore=false;render()}});
}
function delMatchDoc(id){deleteDoc(doc(db,"matches",id)).catch(()=>setSync("err","Delete failed"));deleteDoc(doc(db,"polls",id)).catch(()=>{})}

function boot(){
  if(!CFG.firebase||!CFG.firebase.apiKey||CFG.firebase.apiKey==="PASTE_HERE"){fatal="config";loaded={t:true,m:true};render();return}
  const app=initializeApp(CFG.firebase);
  try{db=initializeFirestore(app,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})})}catch(e){db=getFirestore(app)}
  auth=getAuth(app);
  onAuthStateChanged(auth,u=>{
    uid=u?.uid||null;canScore=!!u&&!!u.email&&u.email===CFG.scorerEmail;
    if(!u)signInAnonymously(auth).catch(()=>{});
    for(const k in polls)polls[k].at=0;
    if(!canScore&&(ui.tab==="score"||ui.tab==="setup"))ui.tab="live";
    render();
  });
  onSnapshot(doc(db,"tournament","main"),s=>{T=s.exists()?{...DEF,...s.data()}:null;loaded.t=true;scheduleRender()},e=>{fatal="read";scheduleRender()});
  onSnapshot(collection(db,"matches"),{includeMetadataChanges:true},s=>{
    const next={};s.docs.forEach(d=>next[d.id]=d.data());M=next;loaded.m=true;
    if(canScore){if(s.metadata.hasPendingWrites)setSync("",navigator.onLine?"Saving…":"Offline · saved on this phone");else if(!s.metadata.fromCache)setSync("","Synced")}
    scheduleRender();
  },e=>{fatal="read";scheduleRender()});
}
const isTyping=()=>{const a=document.activeElement;return!!(a&&$("#app")?.contains(a)&&/INPUT|SELECT|TEXTAREA/.test(a.tagName))};
function scheduleRender(){if(isTyping()){renderDeferred=true;return}render()}
document.addEventListener("focusout",()=>setTimeout(()=>{if(renderDeferred&&!isTyping()){renderDeferred=false;render()}},60));
addEventListener("online",()=>canScore&&setSync("","Saving…"));
addEventListener("offline",()=>canScore&&setSync("","Offline · saved on this phone"));

/* ================= views ================= */
function headerHtml(){
  const t=[["live","Live"],["matches","Matches"],["table","Table"],["stats","Stats"],["fantasy","Fantasy"]];
  if(canScore){t.push(["score","Score"]);t.push(["setup","Setup"])}
  return`<div class="wrap"><div class="brand"><span class="mark" aria-hidden="true"></span><h1>${esc(T?.name||DEF.name)}</h1><span class="${syncState.c}" id="sync">${esc(canScore?syncState.t:"")}</span>${canScore?"":`<button class="btn sm ghost" data-act="tab" data-v="login">Scorer</button>`}</div>
  <nav class="tabs" aria-label="Sections">${t.map(([k,l])=>`<button data-act="tab" data-v="${k}" aria-current="${ui.tab===k}">${l}</button>`).join("")}</nav></div>${sponsorHtml()}`;
}
function sponsorHtml(){
  const sp=(CFG.sponsors||[]).filter(x=>x&&x.name);if(!sp.length)return"";
  return`<div class="sponsors"><div class="wrap"><span class="label">Presented by</span>${sp.map(x=>x.logo?`<img src="${esc(x.logo)}" alt="${esc(x.name)}">`:`<span class="spn">${esc(x.name)}</span>`).join("")}</div></div>`;
}
const stageLabel=m=>`${STAGES[m.stage]||""}${isLeague(m)?" · Match "+m.no:""}`;
function statusPill(m){
  return m.status==="live"?`<span class="pill live">Live</span>`:m.status==="break"?`<span class="pill live">Innings break</span>`:m.status==="super"?`<span class="pill live">Super Over</span>`
    :m.status==="done"?`<span class="pill done">Result</span>`:m.status==="setup"?`<span class="pill live">Toss done</span>`:`<span class="pill up">Upcoming</span>`;
}
function boardHtml(m){
  const meta=`<div class="meta">${statusPill(m)}<span>${esc(stageLabel(m))}</span><span>· ${mOvers(m)} overs</span></div>`;
  if(m.status==="scheduled")return`<div class="board">${meta}<div class="vs">${esc(tname(m.a))} <span>vs</span> ${esc(tname(m.b))}</div><div class="small" style="color:var(--board-muted)">Toss not done yet.</div></div>`;
  if(!m.inn.length){
    const done=m.status==="done";
    return`<div class="board">${meta}<div class="vs">${esc(tname(m.a))} <span>vs</span> ${esc(tname(m.b))}</div>${done?`<div class="result">${esc(m.result)}</div>`:`<div class="small" style="color:var(--board-muted)">${esc(tname(m.toss))} won the toss and chose to ${m.chose==="bat"?"bat":"bowl"}. Openers coming out.</div>`}</div>`;
  }
  const i=m.inn.length-1,inn=m.inn[i],st=innStats(inn),tg=targetOf(m),ov=ovFor(m,i);
  let chase="";
  if(m.status==="done"||m.status==="super")chase=`<div class="result">${esc(m.result)}</div>`;
  else if(m.status==="break")chase=`<div class="chase">${esc(tname(inn.bowl))} need ${st.runs+1} to win off ${ovFor(m,1)} overs</div>`;
  else if(tg){const need=tg-st.runs,left=ov*6-st.legal;chase=`<div class="chase">${esc(tname(inn.bat))} need ${need} run${need===1?"":"s"} from ${left} ball${left===1?"":"s"}</div>`}
  const s1=m.inn.length>1?innStats(m.inn[0]):null;
  const rates=`<div class="rates"><span>Run rate <b>${rate(st.runs,st.legal)}</b></span>${tg&&m.status==="live"?`<span>Required <b>${rate(tg-st.runs,ov*6-st.legal)}</b></span><span>Target <b>${tg}</b>${m.tgt?" (revised)":""}</span>`:""}${s1?`<span>${esc(tname(m.inn[0].bat))} <b>${s1.runs}/${s1.wk}</b> (${ovs(s1.legal)})</span>`:""}</div>`;
  let crease="",overRow="",flags="";
  if(m.status==="live"){
    const bl=id=>{if(!id)return"";const b=st.bat[id]||{r:0,b:0,f:0,s:0};return`<span class="nm">${esc(pname(id))}${id===inn.cur.s?" *":""}</span><span class="fig"><b>${b.r}</b> (${b.b})${b.f||b.s?` · ${b.f}×4 ${b.s}×6`:""}</span>`};
    const bwId=inn.cur.bw||last(inn.balls)?.bw,bw=bwId?st.bowl[bwId]||{l:0,r:0,w:0}:null;
    crease=`<div class="crease">${bl(inn.cur.s)}${bl(inn.cur.ns)}${bw?`<span class="nm bowl">${esc(pname(bwId))} (bowling)</span><span class="fig"><b>${bw.w}-${bw.r}</b> (${ovs(bw.l)})</span>`:""}</div>`;
    const n=Math.floor(st.legal/6)+1,tag=n<=ov?overTag(ov,n):"";
    overRow=`<div class="over"><span class="label">Over ${n}</span>${tag?`<span class="pill sp">${tag}</span>`:""}${st.cur.map(chip).join("")}</div>`;
    if(isFreeHit(inn))flags+=`<span class="flag">Free hit</span>`;
    if(st.legal===Math.floor(ov/2)*6&&!st.cur.length&&st.legal>0)flags+=`<span class="flag">Halfway: batting end changes</span>`;
  }
  return`<div class="board">${meta}<div class="score-row"><div class="score-team">${esc(tname(inn.bat))}${i?" · 2nd innings":""}</div><div class="score-big">${st.runs}<small>/${st.wk}</small></div><div class="score-ov">${ovs(st.legal)} <span>/ ${ov} ov</span></div></div>${chase}${rates}${crease}${overRow}${flags}</div>`;
}
function feedText(b){
  const who=`${esc(pname(b.bw))} to ${esc(pname(b.s))}`;let d;
  if(b.t==="run")d=b.r===0?"no run":b.r===4?"<b>FOUR</b>":b.r===6?"<b>SIX</b>":b.r+" run"+(b.r>1?"s":"");
  else if(b.t==="wd")d="wide"+(b.r?`, ${b.r} run${b.r>1?"s":""} taken`:"");
  else if(b.t==="nb")d="no ball"+(b.r?`, ${b.r===4?"<b>FOUR</b>":b.r===6?"<b>SIX</b>":b.r+" run"+(b.r>1?"s":"")} off the bat`:"");
  else d=`${b.r} ${b.t==="bye"?"bye":"leg bye"}${b.r>1?"s":""}`;
  if(b.w)d=`<b>OUT!</b> ${esc(pname(b.w.out))} ${esc(dismissal(b))}`+(b.r?` (${b.r} run${b.r>1?"s":""} completed)`:"");
  return`${who}, ${d}${b.fh?" · free hit":""}`;
}
function feedHtml(m){
  const rows=[];m.inn.forEach(inn=>innStats(inn).log.forEach(e=>rows.push(e)));
  const recent=rows.slice(-15).reverse();if(!recent.length)return"";
  return`<div><div class="label">Ball by ball</div><div class="feed">${recent.map(e=>`<div class="row"><span class="ov">${e.lab}</span>${chip(e.b)}<span class="txt">${feedText(e.b)}</span></div>`).join("")}</div></div>`;
}
function cardHtml(m,i,open){
  const inn=m.inn[i],st=innStats(inn),live=m.status==="live"&&!inn.closed;
  const bat=st.batOrder.map(id=>{const b=st.bat[id],at=live&&(id===inn.cur.s||id===inn.cur.ns);
    return`<tr><td class="n">${esc(pname(id))}<span class="how">${b.out?esc(b.out):at?"batting":"not out"}</span></td><td><b>${b.r}</b></td><td>${b.b}</td><td>${b.f}</td><td>${b.s}</td><td>${b.b?(b.r*100/b.b).toFixed(0):"–"}</td></tr>`}).join("");
  const yet=xiPlayers(m,inn.bat).filter(p=>!st.bat[p.id]).map(p=>esc(p.name));
  const exT=st.ex.wd+st.ex.nb+st.ex.b+st.ex.lb;
  const bowl=st.bowlOrder.map(id=>{const b=st.bowl[id];return`<tr><td class="n">${esc(pname(id))}</td><td>${ovs(b.l)}</td><td>${b.r}</td><td><b>${b.w}</b></td><td>${rate(b.r,b.l)}</td><td>${b.wd}/${b.nb}</td></tr>`}).join("");
  return`<details class="card"${open?" open":""}><summary><span>${esc(tname(inn.bat))} · ${i===0?"1st":"2nd"} innings</span><span class="sc">${st.runs}/${st.wk} <span class="muted small">(${ovs(st.legal)})</span></span></summary><div class="in">
  <div class="tbl"><table><thead><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead><tbody>${bat||`<tr><td colspan="6" class="muted">No balls bowled yet</td></tr>`}
  <tr><td>Extras <span class="how">wd ${st.ex.wd}, nb ${st.ex.nb}, b ${st.ex.b}${st.ex.lb?", lb "+st.ex.lb:""}</span></td><td>${exT}</td><td colspan="4"></td></tr>
  <tr class="tot"><td>Total</td><td>${st.runs}/${st.wk}</td><td colspan="4" class="muted">${ovs(st.legal)} ov · RR ${rate(st.runs,st.legal)}</td></tr></tbody></table></div>
  ${yet.length?`<div class="kv"><b>Yet to bat:</b> ${yet.join(", ")}</div>`:""}
  ${st.fow.length?`<div class="kv"><b>Fall of wickets:</b> ${st.fow.map(f=>`${f.r}-${f.n} (${esc(pname(f.id))}, ${f.ov})`).join(", ")}</div>`:""}
  <div class="tbl"><table><thead><tr><th>Bowler</th><th>O</th><th>R</th><th>W</th><th>Econ</th><th>Wd/Nb</th></tr></thead><tbody>${bowl||`<tr><td colspan="6" class="muted">—</td></tr>`}</tbody></table></div>
  </div></details>`;
}
function matchDetail(m){
  return`${boardHtml(m)}${pollHtml(m)}${feedHtml(m)}
  ${m.inn.length?`<div class="label">Scorecard</div>`+m.inn.map((_,i)=>cardHtml(m,i,i===m.inn.length-1)).join(""):""}
  ${m.super?`<div class="kv"><b>Super Over:</b> ${esc(m.super)}</div>`:""}`;
}
const byNo=(a,b)=>(a.no||0)-(b.no||0);
function liveView(){
  if(!T)return`<section><div class="empty"><strong>Scores start on 29 November</strong>${canScore?"Open Setup to add the ten teams and their squads.":"Live scores, scorecards, the points table and player stats appear here once the tournament begins."}</div></section>`;
  const list=Object.values(M);
  const live=list.filter(m=>LIVE.includes(m.status)).sort((a,b)=>(b.upd||0)-(a.upd||0));
  const m=(ui.sel&&M[ui.sel])||live[0];
  if(m){
    const others=live.filter(x=>x.id!==m.id);
    return`<section>${ui.sel&&!live.includes(m)&&live.length?`<button class="btn sm" data-act="unsel">Back to the live match</button>`:""}${matchDetail(m)}
    ${others.length?`<div class="row-btns">${others.map(o=>`<button class="btn sm" data-act="view" data-id="${o.id}">Also live: ${esc(tname(o.a))} v ${esc(tname(o.b))}</button>`).join("")}</div>`:""}</section>`;
  }
  const next=list.filter(x=>x.status==="scheduled").sort(byNo)[0];
  const lastDone=list.filter(x=>x.status==="done").sort((a,b)=>(b.upd||0)-(a.upd||0))[0];
  if(!next&&!lastDone)return`<section><div class="empty"><strong>No match in progress</strong>${canScore?"Open Score to start a match.":"The next match will show here live, ball by ball."}</div></section>`;
  return`<section>${next?`<div class="label">Next match</div>${boardHtml(next)}${pollHtml(next)}`:""}${lastDone?`<div class="label">Latest result</div>${boardHtml(lastDone)}<button class="btn sm" data-act="view" data-id="${lastDone.id}">Full scorecard</button>`:""}</section>`;
}
function matchRow(m){
  const sc=id=>{const i=m.inn.findIndex(x=>x.bat===id);if(i<0)return"";const s=innStats(m.inn[i]);return`${s.runs}/${s.wk} (${ovs(s.legal)})`};
  const first=m.inn[0]?.bat||m.a,second=first===m.a?m.b:m.a;
  return`<div class="mrow"><button class="mlink" data-act="view" data-id="${m.id}"><div class="top"><span class="label">${esc(stageLabel(m))}</span>${statusPill(m)}</div><div class="t"><span>${esc(tname(first))}</span><span>${sc(first)}</span></div><div class="t"><span>${esc(tname(second))}</span><span>${sc(second)}</span></div>${m.result?`<div class="res">${esc(m.result)}</div>`:""}</button>${m.status==="scheduled"?pollHtml(m):""}</div>`;
}
function matchesView(){
  if(!T)return liveView();
  const list=Object.values(M).sort(byNo);
  if(!list.length)return`<section><div class="empty"><strong>Fixtures not out yet</strong>League fixtures appear here once the teams are set.</div></section>`;
  const ko=list.filter(m=>!isLeague(m)),lg=list.filter(isLeague),live=list.filter(m=>LIVE.includes(m.status));
  const block=(title,arr)=>arr.length?`<h2>${title}</h2><div class="mlist">${arr.map(matchRow).join("")}</div>`:"";
  return`<section>${block("Live now",live)}${block("Knockouts",ko.filter(m=>!live.includes(m)))}${block("Upcoming",lg.filter(m=>m.status==="scheduled"))}${block("Results",lg.filter(m=>m.status==="done").reverse())}</section>`;
}
function groupTable(g){
  const rows=pointsTable(g);if(!rows.length)return"";
  return`<h2>Group ${g}</h2><div class="tbl"><table><thead><tr><th>Team</th><th>P</th><th>W</th><th>L</th><th>T</th><th>NR</th><th>Pts</th><th>NRR</th></tr></thead><tbody>${rows.map((r,i)=>`<tr${i<3&&r.p?' class="q"':""}><td class="n"><b>${esc(tname(r.id))}</b>${r.p&&i===0?'<span class="tag">SF</span>':r.p&&i<3?'<span class="tag">QF</span>':""}</td><td>${r.p}</td><td>${r.w}</td><td>${r.l}</td><td>${r.t}</td><td>${r.nr}</td><td><b>${r.pts}</b></td><td>${(r.nrr>=0?"+":"")+r.nrr.toFixed(3)}</td></tr>`).join("")}</tbody></table></div>`;
}
function tableView(){
  if(!T)return liveView();
  return`<section>${groupTable("A")}${groupTable("B")}<p class="kv">Win ${T.ptsWin} pts · tie or no result ${T.ptsTie} pt each. Group toppers go straight to the semi-finals; 2nd and 3rd play the quarter-finals (A2 v B3, B2 v A3). Teams level on points are split by net run rate, where an all-out side counts its full overs.</p></section>`;
}
function statsView(){
  if(!T)return liveView();
  const{bat,bowl}=tourStats();
  const chips=[["runs","Most runs"],["wkts","Most wickets"],["sixes","Most sixes"]].map(([k,l])=>`<button class="opt" data-act="stat" data-v="${k}" aria-pressed="${ui.stat===k}">${l}</button>`).join("");
  const nm=id=>`<td class="n"><b>${esc(pname(id))}</b><span class="how">${esc(tname(pteam(id)))}</span></td>`;
  let body="";
  if(ui.stat==="wkts"){
    const rows=Object.entries(bowl).filter(([,x])=>x.l>0).sort((a,b)=>b[1].w-a[1].w||(a[1].r*6/a[1].l)-(b[1].r*6/b[1].l)).slice(0,20);
    body=rows.length?`<table><thead><tr><th>Bowler</th><th>W</th><th>O</th><th>R</th><th>Econ</th><th>Best</th></tr></thead><tbody>${rows.map(([id,x])=>`<tr>${nm(id)}<td><b>${x.w}</b></td><td>${ovs(x.l)}</td><td>${x.r}</td><td>${rate(x.r,x.l)}</td><td>${x.bw}/${x.br}</td></tr>`).join("")}</tbody></table>`:"";
  }else{
    const key=ui.stat==="sixes"?"s":"r";
    const rows=Object.entries(bat).filter(([,x])=>x.b>0||x.r>0).sort((a,b)=>b[1][key]-a[1][key]||b[1].r-a[1].r||a[1].b-b[1].b).slice(0,20);
    body=rows.length?`<table><thead><tr><th>Batter</th>${key==="s"?"<th>6s</th><th>R</th>":"<th>R</th><th>6s</th>"}<th>Inn</th><th>HS</th><th>SR</th><th>4s</th></tr></thead><tbody>${rows.map(([id,x])=>`<tr>${nm(id)}${key==="s"?`<td><b>${x.s}</b></td><td>${x.r}</td>`:`<td><b>${x.r}</b></td><td>${x.s}</td>`}<td>${x.inns}</td><td>${x.hs}${x.hsNo?"*":""}</td><td>${x.b?(x.r*100/x.b).toFixed(0):"–"}</td><td>${x.f}</td></tr>`).join("")}</tbody></table>`:"";
  }
  return`<section><h2>Player stats</h2><div class="opts">${chips}</div>${body?`<div class="tbl">${body}</div>`:`<div class="empty"><strong>No stats yet</strong>Leaders appear after the first ball is bowled.</div>`}<p class="kv">Across all matches including knockouts. Updates live.</p></section>`;
}
function loginView(){
  if(canScore){ui.tab="score";return scoreView()}
  return`<section><div class="panel"><h2>Scorer login</h2><p class="kv">Enter the scorer PIN given by the organisers.</p>
  <form id="login-form" class="row-btns" style="align-items:stretch"><input id="pin" type="password" inputmode="numeric" autocomplete="current-password" placeholder="Scorer PIN" style="flex:1;min-width:140px"><button class="btn pri" type="submit"${ui.busyLogin?" disabled":""}>${ui.busyLogin?"Checking…":"Log in"}</button></form>
  ${ui.loginErr?`<div class="msg" style="color:var(--out)">${esc(ui.loginErr)}</div>`:""}</div></section>`;
}

/* ================= scorer ================= */
function confirmHtml(){return pendingConfirm?`<div class="confirm"><div>${esc(pendingConfirm.msg)}</div><div class="row-btns"><button class="btn warn" data-act="confirmYes">${esc(pendingConfirm.yes)}</button><button class="btn" data-act="confirmNo">Cancel</button></div></div>`:""}
function ask(msg,yes,fn){pendingConfirm={msg,yes,fn};render()}
function selectHtml(id,items,label,sel){
  return`<div class="field"><label class="label" for="${id}">${label}</label><select id="${id}">${items.map(p=>`<option value="${p.id}"${p.disabled?" disabled":""}${p.id===sel?" selected":""}>${esc(p.name)}${p.why?" — "+esc(p.why):""}</option>`).join("")}</select></div>`;
}
function scoreView(){
  if(!T)return`<section><div class="empty"><strong>Set up the tournament first</strong>Add the teams, groups and squads in Setup.</div><button class="btn pri" data-act="tab" data-v="setup">Open Setup</button></section>`;
  const list=Object.values(M).sort(byNo);
  const active=list.filter(m=>LIVE.includes(m.status));
  const next=list.filter(m=>m.status==="scheduled").slice(0,6);
  const sel=M[ui.scoreSel];
  let body;
  if(ui.scoreSel==="new")body=newMatchHtml();
  else if(sel)body=padHtml(sel);
  else body=`<div class="empty"><strong>Pick a match to score</strong>Upcoming fixtures are listed above. Knockout matches are added with New match.</div>`;
  const b=m=>`<button class="btn sm${ui.scoreSel===m.id?" pri":""}" data-act="ssel" data-id="${m.id}">${isLeague(m)?"M"+m.no:esc(m.stage)}: ${esc(tname(m.a))} v ${esc(tname(m.b))}</button>`;
  return`<section>${confirmHtml()}
  ${active.length?`<div class="label">In progress</div><div class="row-btns">${active.map(b).join("")}</div>`:""}
  ${next.length?`<div class="label">Next up</div><div class="row-btns">${next.map(b).join("")}</div>`:""}
  <div class="row-btns"><button class="btn sm${ui.scoreSel==="new"?" pri":""}" data-act="newMatch">+ New match</button>${sel&&sel.status==="done"?b(sel):""}</div>
  ${body}</section>`;
}
function suggest(stage){
  const a=pointsTable("A"),b=pointsTable("B");
  if(stage==="QF1")return[a[1]?.id,b[2]?.id];
  if(stage==="QF2")return[b[1]?.id,a[2]?.id];
  if(stage==="SF1")return[a[0]?.id,null];
  if(stage==="SF2")return[b[0]?.id,null];
  return[null,null];
}
function newMatchHtml(){
  const teams=T.teams;if(teams.length<2)return`<div class="empty"><strong>Need two teams</strong>Add teams in Setup.</div>`;
  const nm=ui.nm||(ui.nm={stage:"QF1",a:teams[0].id,b:teams[1].id});
  const opt=sel=>teams.map(t=>`<option value="${t.id}"${t.id===sel?" selected":""}>${esc(t.name)} (Grp ${t.group})</option>`).join("");
  return`<div class="panel"><h2>New match</h2>
  <div class="field"><label class="label" for="nm-stage">Stage</label><select id="nm-stage" data-nm="stage">${Object.entries(STAGES).map(([k,l])=>`<option value="${k}"${nm.stage===k?" selected":""}>${l}</option>`).join("")}</select></div>
  <div class="grid2"><div class="field"><label class="label" for="nm-a">Team 1</label><select id="nm-a" data-nm="a">${opt(nm.a)}</select></div>
  <div class="field"><label class="label" for="nm-b">Team 2</label><select id="nm-b" data-nm="b">${opt(nm.b)}</select></div></div>
  ${nm.stage.startsWith("QF")?`<p class="kv">Teams are filled in from the current group tables. Change them if needed.</p>`:""}
  ${nm.a===nm.b?`<div class="msg" style="color:var(--out)">Pick two different teams.</div>`:""}
  <button class="btn pri" data-act="createMatch"${nm.a===nm.b?" disabled":""}>Add match</button></div>`;
}
function tossHtml(m){
  const tz=ui.toss&&ui.toss.id===m.id?ui.toss:(ui.toss={id:m.id,toss:m.a,chose:"bat",xi:{[m.a]:xiOf(m,m.a),[m.b]:xiOf(m,m.b)},overs:mOvers(m)});
  const xiBox=team=>{const sq=teamOf(team)?.players||[],chosen=new Set(tz.xi[team]),n=tz.xi[team].length;
    return`<div class="label">${esc(tname(team))} playing XI · ${n} picked</div><div class="xi">${sq.map(p=>`<label><input type="checkbox" data-xi="${team}:${p.id}"${chosen.has(p.id)?" checked":""}>${esc(p.name)}</label>`).join("")}</div>`};
  const bad=[tz.xi[m.a].length,tz.xi[m.b].length].some(n=>n<T.minXi||n>T.xi);
  return`<div class="panel"><h2>Toss and playing XI</h2>
  <div class="grid2"><div class="field"><label class="label" for="tz-toss">Toss won by</label><select id="tz-toss" data-tz="toss"><option value="${m.a}"${tz.toss===m.a?" selected":""}>${esc(tname(m.a))}</option><option value="${m.b}"${tz.toss===m.b?" selected":""}>${esc(tname(m.b))}</option></select></div>
  <div class="field"><label class="label" for="tz-chose">Chose to</label><select id="tz-chose" data-tz="chose"><option value="bat"${tz.chose==="bat"?" selected":""}>Bat</option><option value="bowl"${tz.chose==="bowl"?" selected":""}>Bowl</option></select></div>
  <div class="field"><label class="label" for="tz-overs">Overs per side</label><select id="tz-overs" data-tz="overs">${[12,10,8,6].map(o=>`<option value="${o}"${+tz.overs===o?" selected":""}>${o}</option>`).join("")}</select></div></div>
  ${xiBox(m.a)}${xiBox(m.b)}
  ${bad?`<div class="msg" style="color:var(--out)">Each side needs ${T.minXi} to ${T.xi} players at the toss. Fewer than ${T.minXi} is a walkover (see Match settings below).</div>`:""}
  <button class="btn pri" data-act="tossDone"${bad?" disabled":""}>Save toss</button></div>`;
}
function openersHtml(m){
  const second=m.inn.length===1;
  const bat=second?m.inn[0].bowl:batFirst(m),bowl=bat===m.a?m.b:m.a;
  const bp=xiPlayers(m,bat),wp=xiPlayers(m,bowl);
  const chaseT=second?(m.tgt||innStats(m.inn[0]).runs+1):0;
  return`<div class="panel"><h2>${second?"Second innings":"Openers"}</h2>
  <p class="kv"><b>${esc(tname(bat))}</b> bat${second?`, chasing ${chaseT}`:""}. <b>${esc(tname(bowl))}</b> bowl.</p>
  <div class="grid2">${selectHtml("op-s",bp,"Striker",bp[0]?.id)}${selectHtml("op-ns",bp,"Non-striker",bp[1]?.id)}</div>
  ${selectHtml("op-bw",wp,"Bowler for over 1 (powerplay)")}
  <button class="btn pri" data-act="startInn" data-bat="${bat}" data-bowl="${bowl}">Start innings</button></div>`;
}
function otherResultHtml(m){
  return`<details class="card"><summary><span>Match settings</span><span class="muted small">overs, revised target, no result, walkover</span></summary><div class="in">
  <div class="grid2"><div class="field"><label class="label" for="ms-overs">Overs per side</label><select id="ms-overs">${[12,10,8,6].map(o=>`<option${mOvers(m)===o?" selected":""}>${o}</option>`).join("")}</select></div>
  ${m.inn.length>1||m.status==="break"?`<div class="field"><label class="label" for="ms-ov2">2nd innings overs</label><select id="ms-ov2"><option value="">Same</option>${[12,11,10,9,8,7,6,5,4,3].map(o=>`<option${m.ov2===o?" selected":""}>${o}</option>`).join("")}</select></div>
  <div class="field"><label class="label" for="ms-tgt">Revised target</label><input id="ms-tgt" type="number" inputmode="numeric" min="1" value="${m.tgt||""}" placeholder="Auto"></div>`:""}</div>
  <button class="btn sm" data-act="saveSettings">Apply</button>
  <div class="label">End the match another way</div>
  <div class="row-btns"><button class="btn sm" data-act="noResult">No result (1 pt each)</button><button class="btn sm" data-act="walkover" data-w="${m.a}">Walkover to ${esc(tname(m.a))}</button><button class="btn sm" data-act="walkover" data-w="${m.b}">Walkover to ${esc(tname(m.b))}</button></div>
  <button class="btn sm warn" data-act="delMatch">Delete this match</button></div></details>`;
}
function padHtml(m){
  const head=`<div class="row-btns" style="justify-content:space-between;align-items:center"><span class="label">${esc(stageLabel(m))}</span><button class="btn sm" data-act="view" data-id="${m.id}">Audience view</button></div>`;
  if(m.status==="scheduled")return head+boardHtml(m)+tossHtml(m)+otherResultHtml(m);
  if(m.status==="setup"||m.status==="break")return head+boardHtml(m)+openersHtml(m)+(m.status==="break"?`<button class="btn" data-act="undo">Undo last ball of 1st innings</button>`:`<button class="btn" data-act="redoToss">Redo toss</button>`)+otherResultHtml(m);
  if(m.status==="super")return head+boardHtml(m)+`<div class="panel"><h2>Super Over result</h2><p class="kv">Each side nominates 3 batters and 1 bowler. The team batting second bats first.</p>
    <div class="field"><label class="label" for="so-score">Super Over scores (shown to everyone)</label><input id="so-score" placeholder="e.g. ${esc(tname(m.inn[1].bat))} 11/1, ${esc(tname(m.inn[0].bat))} 9/2"></div>
    <div class="row-btns"><button class="btn pri" data-act="superWin" data-w="${m.a}">${esc(tname(m.a))} won</button><button class="btn pri" data-act="superWin" data-w="${m.b}">${esc(tname(m.b))} won</button></div><button class="btn" data-act="undo">Undo last ball</button></div>`;
  if(m.status==="done")return head+boardHtml(m)+`<button class="btn" data-act="undo">Undo and reopen</button>`;
  const i=m.inn.length-1,inn=m.inn[i],c=inn.cur,avail=availBatters(m,inn);
  let need="";
  if(c.s==null||(c.ns==null&&avail.length)){
    const slot=c.s==null?"s":"ns";
    need=`<div class="panel"><h2>Next batter</h2>${selectHtml("nb-sel",avail,slot==="s"?"New batter (on strike)":"New batter (non-striker)")}<button class="btn pri" data-act="pickBat" data-slot="${slot}">Send in</button><button class="btn" data-act="undo">Undo last ball</button></div>`;
  }else if(c.bw==null){
    const st=innStats(inn),n=Math.floor(st.legal/6)+1,tag=overTag(ovFor(m,i),n),mx=matrix(ovFor(m,i));
    const opts=bowlerOptions(m,i),firstOk=opts.find(o=>!o.disabled&&!o.why)||opts.find(o=>!o.disabled);
    need=`<div class="panel"><h2>Bowler for over ${n}${tag?" · "+tag:""}</h2>${selectHtml("bw-sel",opts,"Bowler",firstOk?.id)}<p class="kv">For ${ovFor(m,i)} overs: no bowler above ${mx.max} overs, and only ${mx.atMax} may bowl ${mx.max}. Each powerplay and Mascon over needs a different bowler. Breaks are flagged, not blocked.</p><button class="btn pri" data-act="pickBowl">Start over</button><button class="btn" data-act="undo">Undo last ball</button></div>`;
  }
  if(need)return head+boardHtml(m)+need+otherResultHtml(m);
  return head+boardHtml(m)+sheetHtml(m)+`<div class="pad">
  ${[0,1,2,3].map(r=>`<button class="k" data-act="run" data-r="${r}">${r}</button>`).join("")}
  <button class="k r4" data-act="run" data-r="4">4</button><button class="k r6" data-act="run" data-r="6">6</button>
  <button class="k ex" data-act="sheet" data-k="wd">Wide</button><button class="k ex" data-act="sheet" data-k="nb">No ball</button>
  <button class="k ex" data-act="sheet" data-k="bye">Bye</button>${T.noLegBye?`<button class="k tool" data-act="run" data-r="5">5</button>`:`<button class="k ex" data-act="sheet" data-k="lb">Leg bye</button>`}
  <button class="k wk" data-act="sheet" data-k="w">OUT</button>
  <button class="k tool" data-act="undo">Undo</button><button class="k tool" data-act="swap"${c.ns?"":" disabled"}>Swap strike</button>
  <button class="k tool" data-act="changeBowler">Change bowler</button><button class="k tool" data-act="endInn">End innings</button></div>`+otherResultHtml(m);
}
function sheetHtml(m){
  const s=ui.sheet;if(!s)return"";
  const inn=last(m.inn),c=inn.cur,fh=isFreeHit(inn);
  const close=`<button class="btn sm" data-act="closeSheet">Cancel</button>`;
  if(s.k==="wd")return`<div class="sheet"><div class="label">Wide · runs taken besides the wide</div><div class="opts">${[0,1,2,3,4].map(r=>`<button class="opt" data-act="ext" data-r="${r}">${r===0?"Wide only":"+"+r}</button>`).join("")}</div>${close}</div>`;
  if(s.k==="nb")return`<div class="sheet"><div class="label">No ball · runs off the bat (next ball is a free hit)</div><div class="opts">${[0,1,2,3,4,6].map(r=>`<button class="opt" data-act="ext" data-r="${r}">${r===0?"No ball only":"+"+r}</button>`).join("")}</div>${close}</div>`;
  if(s.k==="bye"||s.k==="lb")return`<div class="sheet"><div class="label">${s.k==="bye"?"Byes":"Leg byes"}</div><div class="opts">${[1,2,3,4].map(r=>`<button class="opt" data-act="ext" data-r="${r}">${r}</button>`).join("")}</div>${close}</div>`;
  let kinds=KINDS.filter(k=>!(T.noLbw&&k[0]==="lbw"));if(fh)kinds=kinds.filter(k=>k[0]==="ro");
  const fielders=xiPlayers(m,inn.bowl);
  let more="";
  if(s.kind){
    if(["c","ro","st"].includes(s.kind))more+=`<div class="field"><label class="label" for="wk-f">${s.kind==="c"?"Caught by":s.kind==="st"?"Stumped by":"Fielder (optional)"}</label><select id="wk-f"><option value="">—</option>${fielders.map(p=>`<option value="${p.id}"${s.f===p.id?" selected":""}>${esc(p.name)}</option>`).join("")}</select></div>`;
    if(s.kind==="ro"){
      more+=`<div class="label">Who is out</div><div class="opts"><button class="opt" data-act="wo" data-v="s" aria-pressed="${s.out==="s"}">${esc(pname(c.s))} (striker)</button>${c.ns?`<button class="opt" data-act="wo" data-v="ns" aria-pressed="${s.out==="ns"}">${esc(pname(c.ns))}</button>`:""}</div>
      <div class="label">Runs completed</div><div class="opts">${[0,1,2,3].map(r=>`<button class="opt" data-act="wr" data-v="${r}" aria-pressed="${s.runs===r}">${r}</button>`).join("")}</div>`;
    }
    if(s.kind==="ro"||s.kind==="st"){
      const types=s.kind==="ro"?[["run","Legal ball"],["wd","Wide"],["nb","No ball"]]:[["run","Legal ball"],["wd","Wide"]];
      more+=`<div class="label">Delivery</div><div class="opts">${types.map(([v,l])=>`<button class="opt" data-act="wt" data-v="${v}" aria-pressed="${s.wt===v}">${l}</button>`).join("")}</div>`;
    }
    more+=`<button class="btn pri" data-act="wkConfirm">Confirm wicket</button>`;
  }
  return`<div class="sheet"><div class="label">How out${fh?" · free hit: run out only":""}</div><div class="opts">${kinds.map(([k,l])=>`<button class="opt" data-act="wk" data-v="${k}" aria-pressed="${s.kind===k}">${l}</button>`).join("")}</div>${more}${close}</div>`;
}

/* ================= setup ================= */
function poolPlayer(name){const p=POOL.find(x=>x.name.toLowerCase()===name.toLowerCase());return p?{id:uidGen("p"),name:p.name,reg:p.reg,role:p.role}:{id:uidGen("p"),name}}
function blankTeams(){
  if(PRESET.length)return PRESET.map(t=>({id:uidGen("t"),name:t.name,group:t.group,players:[poolPlayer(t.icon)]}));
  const t=[];for(const g of["A","B"])for(let i=1;i<=5;i++)t.push({id:uidGen("t"),name:"",group:g,players:Array.from({length:DEF.squad},()=>({id:uidGen("p"),name:""}))});return t}
function poolPanel(d){
  if(!POOL.length)return"";
  const q=(ui.poolQ||"").trim().toLowerCase();
  const owner={};d.teams.forEach(t=>t.players.forEach(p=>{if(p.reg)owner[p.reg]=t.id;else if(p.name){const m=POOL.find(x=>x.name.toLowerCase()===p.name.trim().toLowerCase());if(m&&!owner[m.reg])owner[m.reg]=t.id}}));
  const count=t=>t.players.filter(p=>p.name.trim()).length;
  const list=POOL.filter(p=>!q||p.name.toLowerCase().includes(q)||String(p.reg)===q);
  const show=ui.poolAll?list:list.filter(p=>!owner[p.reg]);
  const opts=tid=>`<option value="">— unsold —</option>`+d.teams.filter(t=>t.name.trim()).map(t=>`<option value="${t.id}"${t.id===tid?" selected":""}>${esc(t.name)} (${count(t)})</option>`).join("");
  const sold=Object.keys(owner).length;
  return`<div class="panel"><h2>Auction pool</h2><p class="kv">${sold} of ${POOL.length} players assigned. Pick a team next to each player as they're sold, then <b>Save teams</b> at the bottom. Nothing is shared until you save.</p>
  <div class="row-btns"><input id="pool-q" placeholder="Search name or reg no." value="${esc(ui.poolQ||"")}" data-poolq="1" style="flex:1;min-width:160px"><label class="check"><input type="checkbox" id="pool-all" data-poolall="1"${ui.poolAll?" checked":""}> Show sold too</label></div>
  <div class="pool">${show.map(p=>`<div class="prow pr"><span class="pn"><b>${esc(p.name)}</b> <span class="muted small">#${p.reg} · ${p.role}${p.avail!=="All"?" · "+esc(p.avail)+" only":""}</span></span><select data-pool="${p.reg}" aria-label="Team for ${esc(p.name)}">${opts(owner[p.reg])}</select></div>`).join("")||`<div class="kv">No players match.</div>`}</div></div>`;
}
function setupView(){
  const d=ui.draft||(ui.draft=T?clone(T):{...clone(DEF),teams:blankTeams()});
  const used=new Set(Object.values(M).flatMap(m=>[m.a,m.b]));
  const league=Object.values(M).filter(isLeague);
  const team=(t,idx)=>{const n=t.players.filter(p=>p.name.trim()).length;
    return`<details class="team"><summary><span>${esc(t.name||"Team "+(idx+1))}</span><span class="muted small">Group ${t.group} · ${n} players</span></summary><div class="in">
    <div class="prow"><input id="tn-${t.id}" value="${esc(t.name)}" placeholder="Team name" data-tname="${t.id}" aria-label="Team name"><select id="tg-${t.id}" data-tgroup="${t.id}" aria-label="Group"><option${t.group==="A"?" selected":""}>A</option><option${t.group==="B"?" selected":""}>B</option></select></div>
    ${t.players.map((p,i)=>`<div class="prow"><input id="pn-${p.id}" value="${esc(p.name)}" placeholder="Player ${i+1}${i===0?" (icon)":i===1?" (marquee)":""}" data-pname="${t.id}:${p.id}" aria-label="Player ${i+1}"><button class="btn sm" data-act="delPlayer" data-id="${t.id}:${p.id}" aria-label="Remove player">✕</button></div>`).join("")}
    <div class="row-btns"><button class="btn sm" data-act="addPlayer" data-id="${t.id}">+ Add player</button><button class="btn sm warn" data-act="delTeam" data-id="${t.id}"${used.has(t.id)?" disabled":""}>Remove team</button></div></div></details>`};
  return`<section>${confirmHtml()}
  <div class="panel"><h2>Tournament</h2>
  <div class="field"><label class="label" for="st-name">Name</label><input id="st-name" value="${esc(d.name)}" data-bind="name"></div>
  <div class="grid2">
   <div class="field"><label class="label" for="st-wideRuns">Runs for a wide</label><input id="st-wideRuns" type="number" min="0" max="2" value="${d.wideRuns}" data-bind="wideRuns"></div>
   <div class="field"><label class="label" for="st-nbRuns">Runs for a no ball</label><input id="st-nbRuns" type="number" min="0" max="2" value="${d.nbRuns}" data-bind="nbRuns"></div></div>
  <p class="kv">From the rules sheet: 12 overs a side, 11 play from a 13-player squad (minimum 9 at the toss), free hit on every no ball, no LBW, no leg byes, win 2 pts, tie or no result 1 pt each, Super Over for knockout ties.</p></div>
  ${poolPanel(d)}
  <details class="card"><summary><span>Import teams and squads from text</span><span class="muted small">paste a list</span></summary><div class="in">
  <p class="kv">Paste one block per team: a line starting <b>Team</b>, then <b>Icon</b>, then player names one per line. Group is set by the order (first five = A). Players added to a team already in the list are merged by name.</p>
  <textarea id="imp-text" rows="8" placeholder="Team : Mobius Mavericks&#10;Icon : Sayyam Gadiya&#10;Player two&#10;Player three&#10;&#10;Team : Paramount Pioneers&#10;Icon : Deepak Dugar"></textarea>
  <button class="btn" data-act="importTeams">Import into form</button><div id="imp-msg"></div></div></details>
  <div class="panel"><h2>Teams and squads</h2><p class="kv">Five teams per group. Use the group dropdown to move a team.</p>
  ${["A","B"].map(g=>`<h3>Group ${g}</h3>`+d.teams.map((t,i)=>t.group===g?team(t,i):"").join("")).join("")}
  <button class="btn sm" data-act="addTeam">+ Add team</button></div>
  <div id="setup-msg"></div>
  <div class="row-btns"><button class="btn pri" data-act="saveSetup">Save teams</button>${T&&!league.length?`<button class="btn" data-act="fixtures">Create league fixtures</button>`:""}</div>
  <div class="panel"><h2>Scorer PIN</h2><p class="kv">Anyone with the PIN can score. Change it after the tournament or if it leaks; other phones are logged out within an hour.</p>
  <div class="grid2"><div class="field"><label class="label" for="pin-cur">Current PIN</label><input id="pin-cur" type="password" inputmode="numeric" autocomplete="current-password"></div>
  <div class="field"><label class="label" for="pin-new">New PIN (6+ digits)</label><input id="pin-new" type="password" inputmode="numeric" autocomplete="new-password"></div></div>
  <div class="row-btns"><button class="btn" data-act="changePin">Change PIN</button><button class="btn" data-act="logout">Log out of scoring</button></div></div>
  <div class="row-btns">${T?`<button class="btn warn" data-act="reset">Delete tournament and all matches</button>`:""}<button class="btn" data-act="loadDemo">Load demo tournament</button></div>
  <p class="kv">The demo is a full simulated tournament (league to final, 40 fantasy entries) for trying every screen. Delete it before entering the real squads.</p>
  </section>`;
}
function roundRobin(ids){
  const a=[...ids];if(a.length%2)a.push(null);const n=a.length,rounds=[];
  for(let r=0;r<n-1;r++){const games=[];for(let i=0;i<n/2;i++){const x=a[i],y=a[n-1-i];if(x&&y)games.push(r%2?[y,x]:[x,y])}rounds.push(games);a.splice(1,0,a.pop())}
  return rounds;
}

/* ================= render ================= */
function render(){
  $("#hdr").innerHTML=headerHtml();
  const app=$("#app");
  if(fatal==="config"){app.innerHTML=`<section><div class="empty"><strong>Almost there</strong>Paste your Firebase settings into config.js, then upload the folder again.</div></section>`;return}
  if(fatal==="read"&&!loaded.m){app.innerHTML=`<section><div class="empty"><strong>Can't reach the scoreboard</strong>Check your connection and reload the page.</div></section>`;return}
  if(!loaded.t||!loaded.m){app.innerHTML=`<section><div class="empty"><strong>Loading scores…</strong>Connecting to the scoreboard.</div></section>`;return}
  if(!canScore&&(ui.tab==="score"||ui.tab==="setup"))ui.tab="live";
  const v={matches:matchesView,table:tableView,stats:statsView,fantasy:fantasyView,score:scoreView,setup:setupView,login:loginView}[ui.tab]||liveView;
  app.innerHTML=v();
}

/* ================= actions ================= */
function curMatch(){return M[ui.scoreSel]?clone(M[ui.scoreSel]):null}
function addBall(p){
  const m=curMatch();if(!m)return;const inn=last(m.inn);if(!inn||inn.closed)return;
  const b={...p,s:inn.cur.s,ns:inn.cur.ns,bw:inn.cur.bw};
  if(isFreeHit(inn))b.fh=true;
  inn.balls.push(b);
  let{s,ns,bw}=inn.cur;
  if(ns&&b.r%2===1)[s,ns]=[ns,s];
  if(b.w){if(s===b.w.out)s=null;else if(ns===b.w.out)ns=null}
  const legal=inn.balls.filter(isLegal).length;
  if(isLegal(b)&&legal%6===0){[s,ns]=[ns,s];bw=null}
  inn.cur={s,ns,bw};
  checkEnd(m);
  ui.sheet=null;saveMatch(m);
}
function undo(){
  const m=curMatch();if(!m)return;const inn=last(m.inn);
  if(m.how==="super"){m.status="super";m.result="Scores level · Super Over to decide";m.winner=null;delete m.how;delete m.super;return saveMatch(m)}
  if(m.how==="nr"||m.how==="wo"){m.result="";m.winner=null;delete m.how;
    m.status=!inn?(m.toss?"setup":"scheduled"):(inn.closed&&m.inn.length===1?"break":"live");if(inn&&m.inn.length===2)inn.closed=false;return saveMatch(m)}
  if(!inn)return;
  m.result="";m.winner=null;delete m.how;delete m.super;
  if(inn.closed&&inn.manual){inn.closed=false;delete inn.manual;m.status="live";return saveMatch(m)}
  if(!inn.closed&&inn.balls.length===0){m.inn.pop();m.status=m.inn.length?"break":"setup";const p=last(m.inn);if(p&&p.manual){p.closed=false;delete p.manual;m.status="live"}return saveMatch(m)}
  if(!inn.balls.length)return;
  const b=inn.balls.pop();inn.cur={s:b.s,ns:b.ns,bw:b.bw};inn.closed=false;m.status="live";ui.sheet=null;saveMatch(m);
}
function endWith(m,winner,result,how){m.winner=winner;m.result=result;m.how=how;m.status="done";saveMatch(m)}
const acts={
  tab:el=>{ui.tab=el.dataset.v;ui.sheet=null;pendingConfirm=null;ui.loginErr="";if(ui.tab==="setup")ui.draft=null;if(ui.tab==="live")ui.sel=null;
    try{history.replaceState(null,"",["live","matches","table","stats","fantasy"].includes(ui.tab)?"#"+ui.tab:location.pathname+location.search)}catch(e){}render();scrollTo(0,0)},
  view:el=>{ui.sel=el.dataset.id;ui.tab="live";render();scrollTo(0,0)},
  unsel:()=>{ui.sel=null;render()},
  stat:el=>{ui.stat=el.dataset.v;render()},
  fNew:()=>{FT.draft={name:"",p:[]};FT.q="";FT.err="";render()},
  fEdit:()=>{FT.draft={name:FT.mine.name,p:[...FT.mine.p]};FT.q="";FT.err="";render()},
  fCancel:()=>{FT.draft=null;render()},
  fTog:el=>{const d=FT.draft;const i=d.p.indexOf(el.dataset.id);if(i>=0)d.p.splice(i,1);else if(d.p.length<13)d.p.push(el.dataset.id);render()},
  fSave:()=>saveFantasy(),
  fForget:()=>{FT.myId=null;FT.mine=null;try{localStorage.removeItem("mc-fid")}catch(e){}render()},
  vote:el=>vote(el.dataset.m,el.dataset.t),
  ssel:el=>{ui.scoreSel=el.dataset.id;ui.sheet=null;ui.toss=null;pendingConfirm=null;try{sessionStorage.setItem("mc-score",ui.scoreSel)}catch(e){}render()},
  newMatch:()=>{ui.scoreSel="new";const[a,b]=suggest("QF1");ui.nm={stage:"QF1",a:a||T.teams[0].id,b:b||T.teams[1].id};render()},
  createMatch:()=>{const nm=ui.nm;if(!nm||nm.a===nm.b)return;
    const no=Math.max(0,...Object.values(M).map(m=>m.no||0))+1;
    const m={id:uidGen("m"),no,stage:nm.stage,a:nm.a,b:nm.b,status:"scheduled",inn:[],result:"",winner:null,overs:T.overs};
    ui.scoreSel=m.id;ui.toss=null;saveMatch(m)},
  tossDone:()=>{const m=curMatch(),tz=ui.toss;m.toss=tz.toss;m.chose=tz.chose;m.xi=clone(tz.xi);m.overs=+tz.overs;m.status="setup";saveMatch(m)},
  redoToss:()=>{const m=curMatch();m.status="scheduled";ui.toss=null;saveMatch(m)},
  startInn:el=>{const m=curMatch();const s=$("#op-s").value,ns=$("#op-ns").value,bw=$("#op-bw").value;
    if(!s||!ns||!bw||s===ns){flash("Pick two different openers and a bowler.");return}
    m.inn.push({bat:el.dataset.bat,bowl:el.dataset.bowl,open:[s,ns],cur:{s,ns,bw},balls:[],closed:false});m.status="live";saveMatch(m)},
  pickBat:el=>{const m=curMatch();const v=$("#nb-sel")?.value;if(!v)return;last(m.inn).cur[el.dataset.slot]=v;saveMatch(m)},
  pickBowl:()=>{const m=curMatch();const v=$("#bw-sel")?.value;if(!v)return;last(m.inn).cur.bw=v;saveMatch(m)},
  changeBowler:()=>{const m=curMatch(),inn=last(m.inn);if(innStats(inn).cur.length){flash("The bowler can change only at the start of an over. Undo the balls first if this was a mistake.");return}inn.cur.bw=null;saveMatch(m)},
  run:el=>addBall({t:"run",r:+el.dataset.r}),
  sheet:el=>{ui.sheet={k:el.dataset.k,kind:null,wt:"run",out:"s",runs:0,f:""};render()},
  closeSheet:()=>{ui.sheet=null;render()},
  ext:el=>addBall({t:ui.sheet.k,r:+el.dataset.r}),
  wk:el=>{ui.sheet.kind=el.dataset.v;if(el.dataset.v!=="ro"&&el.dataset.v!=="st")ui.sheet.wt="run";render()},
  wo:el=>{ui.sheet.out=el.dataset.v;render()},
  wr:el=>{ui.sheet.runs=+el.dataset.v;render()},
  wt:el=>{ui.sheet.wt=el.dataset.v;render()},
  wkConfirm:()=>{const s=ui.sheet,m=M[ui.scoreSel],c=last(m.inn).cur;
    const w={k:s.kind,out:s.kind==="ro"&&s.out==="ns"?c.ns:c.s};const f=$("#wk-f")?.value;if(f)w.f=f;
    addBall({t:s.wt,r:s.kind==="ro"?s.runs:0,w})},
  undo:()=>undo(),
  swap:()=>{const m=curMatch(),c=last(m.inn).cur;if(!c.ns)return;[c.s,c.ns]=[c.ns,c.s];saveMatch(m)},
  endInn:()=>ask("End this innings now? Use this only if play was cut short. Undo reopens it.","End innings",()=>{const m=curMatch();last(m.inn).manual=true;closeInn(m);saveMatch(m)}),
  saveSettings:()=>{const m=curMatch();m.overs=+$("#ms-overs").value;const o2=$("#ms-ov2"),tg=$("#ms-tgt");
    if(o2)m.ov2=o2.value?+o2.value:null;if(tg)m.tgt=tg.value?Math.max(1,parseInt(tg.value,10)):null;
    if(m.status==="live"&&m.inn.length)checkEnd(m);saveMatch(m);flash("Match settings applied.",true)},
  noResult:()=>ask("Record this match as no result? Both teams get 1 point and it does not count toward net run rate.","No result",()=>endWith(curMatch(),"nr","No result · 1 point each","nr")),
  walkover:el=>{const w=el.dataset.w;ask(`Award a walkover to ${tname(w)}?`,"Award walkover",()=>endWith(curMatch(),w,`${tname(w)} won by walkover`,"wo"))},
  superWin:el=>{const m=curMatch(),w=el.dataset.w;m.super=($("#so-score")?.value||"").trim();endWith(m,w,`${tname(w)} won the Super Over`,"super")},
  delMatch:()=>ask(`Delete ${stageLabel(M[ui.scoreSel]||{})}? Its scores are removed for everyone.`,"Delete match",()=>{const id=ui.scoreSel;delete M[id];ui.scoreSel=null;if(ui.sel===id)ui.sel=null;render();delMatchDoc(id);
    if(!fantasyLocked()){fantasyLockWritten=false;deleteDoc(doc(db,"meta","lock")).catch(()=>{})}}),
  confirmYes:()=>{const f=pendingConfirm?.fn;pendingConfirm=null;if(f)f();else render()},
  confirmNo:()=>{pendingConfirm=null;render()},
  importTeams:()=>{
    const txt=$("#imp-text").value;const blocks=[];let cur=null;
    const tidy=v=>v.replace(/^\s*[:\-–]\s*/,"").replace(/\s+/g," ").trim();
    const cap=v=>v.toLowerCase().replace(/(^|\s)\S/g,c=>c.toUpperCase());
    for(const raw of txt.split(/\r?\n/)){const line=raw.trim();if(!line)continue;
      let m=line.match(/^team(?:\s*name)?\.?\s*[:\-–]\s*(.+)$/i);
      if(m){cur={name:m[1].trim().toUpperCase(),players:[]};blocks.push(cur);continue}
      if(!cur)continue;
      m=line.match(/^icon(?:\s*name)?\.?\s*[:\-–]\s*(.+)$/i);
      if(m){cur.players.unshift(cap(m[1].trim()));continue}
      m=line.match(/^(?:marquee|player\s*\d*)\s*[:\-–]\s*(.+)$/i);
      cur.players.push(cap(tidy(m?m[1]:line)));}
    if(!blocks.length){flashAt("imp-msg","No teams found. Each team needs a line starting with Team.");return}
    const d=ui.draft;let added=0,merged=0;
    blocks.forEach((b,i)=>{let t=d.teams.find(x=>x.name.trim().toUpperCase()===b.name);
      if(!t){t=d.teams.find(x=>!x.name.trim()&&!x.players.some(p=>p.name.trim()));
        if(t){t.name=b.name}else{t={id:uidGen("t"),name:b.name,group:"A",players:[]};d.teams.push(t)}
        t.group=d.teams.filter(x=>x.name.trim()).indexOf(t)<5?"A":"B";added++}else merged++;
      const have=new Set(t.players.map(p=>p.name.trim().toLowerCase()));
      b.players.forEach(n=>{if(have.has(n.toLowerCase()))return;const np=poolPlayer(n);const slot=t.players.find(p=>!p.name.trim());if(slot)Object.assign(slot,{name:np.name,reg:np.reg,role:np.role});else t.players.push(np);have.add(n.toLowerCase())});
    });
    render();flashAt("imp-msg",`${added} team${added===1?"":"s"} added, ${merged} updated. Check the groups, then Save teams.`,true)},
  addTeam:()=>{ui.draft.teams.push({id:uidGen("t"),name:"",group:"B",players:Array.from({length:DEF.squad},()=>({id:uidGen("p"),name:""}))});render()},
  delTeam:el=>{ui.draft.teams=ui.draft.teams.filter(t=>t.id!==el.dataset.id);render()},
  addPlayer:el=>{ui.draft.teams.find(t=>t.id===el.dataset.id).players.push({id:uidGen("p"),name:""});render()},
  delPlayer:el=>{const[tid,pid]=el.dataset.id.split(":");const t=ui.draft.teams.find(t=>t.id===tid);t.players=t.players.filter(p=>p.id!==pid);render()},
  saveSetup:()=>{const d=clone(ui.draft);d.name=(d.name||"").trim()||DEF.name;
    d.wideRuns=Math.max(0,parseInt(d.wideRuns,10)||0);d.nbRuns=Math.max(0,parseInt(d.nbRuns,10)||0);
    d.teams=d.teams.map(t=>({id:t.id,name:(t.name||"").trim(),group:t.group,players:t.players.map(p=>{const o={id:p.id,name:(p.name||"").trim()};if(p.reg)o.reg=p.reg;if(p.role)o.role=p.role;return o}).filter(p=>p.name)})).filter(t=>t.name||t.players.length);
    const short=d.teams.find(t=>t.players.length<DEF.minXi);
    const bad=d.teams.length<2?"Add at least two teams with names.":d.teams.find(t=>!t.name)?"Every team needs a name.":short?`${short.name} needs at least ${DEF.minXi} players.`:"";
    if(bad){flash(bad);return}
    T=d;ui.draft=clone(d);
    setDoc(doc(db,"tournament","main"),strip(d)).then(()=>flash("Saved. Everyone sees these teams now.",true)).catch(e=>flash(e?.code==="permission-denied"?"Not saved: log in as scorer again.":"Not saved. Check your connection."));
    render();flash("Saving…",true)},
  fixtures:()=>{const rr={A:roundRobin(T.teams.filter(t=>t.group==="A").map(t=>t.id)),B:roundRobin(T.teams.filter(t=>t.group==="B").map(t=>t.id))};
    let no=Math.max(0,...Object.values(M).map(m=>m.no||0));const rounds=Math.max(rr.A.length,rr.B.length);const batch=writeBatch(db);
    for(let r=0;r<rounds;r++)for(const g of["A","B"])for(const[a,b]of rr[g][r]||[]){const m={id:uidGen("m"),no:++no,stage:g,a,b,status:"scheduled",inn:[],result:"",winner:null,overs:T.overs,upd:Date.now()};M[m.id]=m;batch.set(doc(db,"matches",m.id),m)}
    batch.commit().catch(()=>flash("Fixtures not saved. Check your connection."));render();flash(`${no} league matches created. Find them under Score and Matches.`,true)},
  changePin:async()=>{const cur=$("#pin-cur").value,nw=$("#pin-new").value;
    if(nw.length<6){flash("The new PIN needs at least 6 digits.");return}
    try{await reauthenticateWithCredential(auth.currentUser,EmailAuthProvider.credential(CFG.scorerEmail,cur));await updatePassword(auth.currentUser,nw);flash("PIN changed. Share the new PIN with your scorers.",true)}
    catch(e){flash(e?.code==="auth/wrong-password"||e?.code==="auth/invalid-credential"?"Current PIN is wrong.":"PIN not changed. Try again.")}},
  logout:()=>{signOut(auth);ui.tab="live";render()},
  reset:()=>ask("Delete the tournament, all teams, every match, all predictions and all fantasy teams? This cannot be undone.","Delete everything",async()=>{
    try{const batch=writeBatch(db);Object.keys(M).forEach(id=>{batch.delete(doc(db,"matches",id));batch.delete(doc(db,"polls",id))});batch.delete(doc(db,"tournament","main"));batch.delete(doc(db,"meta","lock"));
      const fs=await getDocs(collection(db,"fantasy"));let b2=batch,n=0;const extra=[];
      fs.docs.forEach(d=>{if(n++>=400){b2=writeBatch(db);extra.push(b2);n=1}b2.delete(d.ref)});
      await batch.commit();for(const b of extra)await b.commit();
      fantasyLockWritten=false;M={};T=null;ui.draft=null;ui.scoreSel=null;ui.sel=null;FT.all=null;FT.mine=null;render();flash("Everything deleted.",true)}
    catch(e){flash("Not fully deleted. Check your connection and try again.")}}),
  loadDemo:()=>ask("Load the demo tournament? This replaces everything currently saved (teams, matches, predictions, fantasy teams) with simulated data.","Load demo",async()=>{
    flash("Loading demo…",true);
    try{const r=await fetch("demo.json",{cache:"no-store"});if(!r.ok)throw new Error("fetch");const d=await r.json();
      // wipe first
      const wipe=writeBatch(db);Object.keys(M).forEach(id=>{wipe.delete(doc(db,"matches",id));wipe.delete(doc(db,"polls",id))});wipe.delete(doc(db,"meta","lock"));
      const fs=await getDocs(collection(db,"fantasy"));fs.docs.forEach(x=>wipe.delete(x.ref));await wipe.commit();
      const b=writeBatch(db);b.set(doc(db,"tournament","main"),d.tournament);
      Object.values(d.matches).forEach(m=>b.set(doc(db,"matches",m.id),{...m,upd:Date.now()}));
      (d.fantasy||[]).forEach(f=>b.set(doc(db,"fantasy",f.id),{name:f.name,p:f.p,uid:f.uid,at:Date.now(),demo:true}));
      b.set(doc(db,"meta","lock"),{at:Date.now(),demo:true});
      await b.commit();fantasyLockWritten=true;FT.all=null;ui.draft=null;ui.scoreSel=null;ui.sel=null;ui.tab="live";render();flash("Demo loaded.",true)}
    catch(e){flash(e?.code==="permission-denied"?"Demo not loaded: paste the latest firestore.rules into Firebase first.":"Demo not loaded. Check your connection.")}}),
};
function flashAt(id,msg,good){const el=$("#"+id);if(el)el.innerHTML=`<div class="msg" style="color:var(${good?"--good":"--out"})">${esc(msg)}</div>`}
function flash(msg,good){
  let el=ui.tab==="setup"?$("#setup-msg"):null;
  if(!el){el=document.createElement("div");$("#app section")?.prepend(el)}
  el.innerHTML=`<div class="msg" style="color:var(${good?"--good":"--out"})">${esc(msg)}</div>`;
}
document.addEventListener("click",e=>{const el=e.target.closest("[data-act]");if(!el||el.disabled)return;const f=acts[el.dataset.act];if(f){e.preventDefault();f(el)}});
document.addEventListener("submit",async e=>{
  if(e.target.id!=="login-form")return;e.preventDefault();
  const pin=$("#pin").value.trim();if(!pin)return;
  ui.busyLogin=true;ui.loginErr="";render();
  try{await signInWithEmailAndPassword(auth,CFG.scorerEmail,pin);ui.tab="score"}
  catch(err){ui.loginErr=err?.code==="auth/too-many-requests"?"Too many tries. Wait a few minutes and try again.":err?.code==="auth/network-request-failed"?"No connection. Try again when you have signal.":"Wrong PIN."}
  ui.busyLogin=false;render();
});
document.addEventListener("input",e=>{
  const t=e.target;
  if(t.dataset.fname&&FT.draft){FT.draft.name=t.value;return}
  if(t.dataset.poolq){ui.poolQ=t.value;const sc=scrollY;render();const q=$("#pool-q");if(q){q.focus();q.setSelectionRange(q.value.length,q.value.length)}scrollTo(0,sc);return}
  if(t.dataset.fq){FT.q=t.value;renderDeferred=false;const sc=scrollY;render();const q=$("#f-q");if(q){q.focus();q.setSelectionRange(q.value.length,q.value.length)}scrollTo(0,sc);return}
  const d=ui.draft;if(!d)return;
  if(t.dataset.bind)d[t.dataset.bind]=t.value;
  else if(t.dataset.tname)d.teams.find(x=>x.id===t.dataset.tname).name=t.value;
  else if(t.dataset.pname){const[tid,pid]=t.dataset.pname.split(":");d.teams.find(x=>x.id===tid).players.find(p=>p.id===pid).name=t.value}
});
document.addEventListener("change",e=>{
  const t=e.target;
  if(t.dataset.pool&&ui.draft){const reg=+t.dataset.pool,d=ui.draft,P=POOL.find(x=>x.reg===reg);
    d.teams.forEach(x=>{x.players=x.players.filter(p=>!(p.reg===reg||(!p.reg&&p.name.trim().toLowerCase()===P.name.toLowerCase())))});
    if(t.value){const tm=d.teams.find(x=>x.id===t.value);const slot=tm.players.find(p=>!p.name.trim());const np={id:slot?slot.id:uidGen("p"),name:P.name,reg:P.reg,role:P.role};if(slot)Object.assign(slot,np);else tm.players.push(np)}
    const sc=scrollY;render();scrollTo(0,sc);return}
  if(t.dataset.poolall){ui.poolAll=t.checked;render();return}
  if(t.dataset.tgroup&&ui.draft){ui.draft.teams.find(x=>x.id===t.dataset.tgroup).group=t.value;t.blur();render()}
  if(t.dataset.nm&&ui.nm){ui.nm[t.dataset.nm]=t.value;if(t.dataset.nm==="stage"){const[a,b]=suggest(t.value);if(a)ui.nm.a=a;if(b)ui.nm.b=b}t.blur();render()}
  if(t.dataset.tz&&ui.toss){ui.toss[t.dataset.tz]=t.value;t.blur();render()}
  if(t.dataset.xi&&ui.toss){const[team,pid]=t.dataset.xi.split(":");const arr=ui.toss.xi[team];
    if(t.checked){if(!arr.includes(pid))arr.push(pid)}else ui.toss.xi[team]=arr.filter(x=>x!==pid);t.blur();render()}
  if(t.id==="wk-f"&&ui.sheet)ui.sheet.f=t.value;
  if(t.dataset.fpick&&FT.draft){const d=FT.draft,id=t.dataset.fpick;const i=d.p.indexOf(id);if(t.checked&&i<0&&d.p.length<13)d.p.push(id);else if(!t.checked&&i>=0)d.p.splice(i,1);const sc=scrollY;render();scrollTo(0,sc)}
});

render();
try{boot()}catch(e){fatal="read";loaded={t:true,m:true};render()}

/* exported for tests */
window.__mc={fantasyPoints,innStats,finalize,pointsTable,tourStats,matrix,specials,bowlerOptions,roundRobin,set:(t,m)=>{T=t;M=m}};
