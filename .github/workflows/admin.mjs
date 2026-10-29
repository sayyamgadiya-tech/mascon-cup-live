// Admin jobs run from GitHub Actions with the service-account key (bypasses app rules).
// ACTION=real-setup : wipe demo data (matches, polls, fantasy, fans, lock) and write
//                     the 10 franchises with icons + 20 league fixtures.
import fs from "node:fs";
import vm from "node:vm";
import { GoogleAuth } from "google-auth-library";

const project = "ahore-mascon-cup-2026";
const ACTION = process.env.ACTION || "";
let key = process.env.KEY || "";
if (!key.trim().startsWith("{")) key = "{" + key;
const auth = new GoogleAuth({ credentials: JSON.parse(key), scopes: ["https://www.googleapis.com/auth/datastore", "https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();
const root = `projects/${project}/databases/(default)/documents`;
const api = `https://firestore.googleapis.com/v1/${root}`;
const call = async (method, url, data) => (await client.request({ method, url, data }).catch(e => { throw new Error(`${method} ${url} -> ${e.response?.status} ${JSON.stringify(e.response?.data?.error?.message || e.message)}`) })).data;

const enc = v => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, enc(x)])) } };
};
const commit = async writes => { for (let i = 0; i < writes.length; i += 400) await call("POST", `${api}:commit`, { writes: writes.slice(i, i + 400) }); };
const listIds = async col => { const out = []; let tok = ""; do { const r = await call("GET", `${api}/${col}?pageSize=300&mask.fieldPaths=__name__${tok ? "&pageToken=" + tok : ""}`); (r.documents || []).forEach(d => out.push(d.name)); tok = r.nextPageToken || ""; } while (tok); return out; };

const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync("players.js", "utf8"), ctx);
const POOL = ctx.window.MASCON_POOL, PRESET = ctx.window.MASCON_TEAMS;
const uidGen = p => p + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7);
const poolPlayer = name => { const p = POOL.find(x => x.name.toLowerCase() === name.toLowerCase()); return p ? { id: uidGen("p"), name: p.name, reg: p.reg, role: p.role, age: p.age } : { id: uidGen("p"), name }; };
function roundRobin(ids) {
  const a = [...ids]; if (a.length % 2) a.push(null); const n = a.length, rounds = [];
  for (let r = 0; r < n - 1; r++) { const g = []; for (let i = 0; i < n / 2; i++) { const x = a[i], y = a[n - 1 - i]; if (x && y) g.push(r % 2 ? [y, x] : [x, y]); } rounds.push(g); a.splice(1, 0, a.pop()); }
  return rounds;
}

if (ACTION === "real-setup") {
  const del = [];
  for (const col of ["matches", "polls", "fantasy", "fans", "meta", "tournament"]) (await listIds(col)).forEach(n => del.push({ delete: n }));
  await commit(del); console.log("deleted", del.length, "documents");
  const DEF = { name: "Ahore Mascon Cup 2026", emergingAge: 21, overs: 12, xi: 11, minXi: 9, squad: 13, wideRuns: 1, nbRuns: 1, freeHit: true, noLbw: true, noLegBye: true, ptsWin: 2, ptsTie: 1, ptsNR: 1 };
  const teams = PRESET.map(t => ({ id: uidGen("t"), name: t.name, group: t.group, players: [poolPlayer(t.icon)] }));
  const w = [{ update: { name: `${root}/tournament/main`, fields: enc({ ...DEF, teams }).mapValue.fields } }];
  const rr = { A: roundRobin(teams.filter(t => t.group === "A").map(t => t.id)), B: roundRobin(teams.filter(t => t.group === "B").map(t => t.id)) };
  let no = 0;
  for (let r = 0; r < Math.max(rr.A.length, rr.B.length); r++) for (const g of ["A", "B"]) for (const [a, b] of rr[g][r] || []) {
    const id = uidGen("m");
    w.push({ update: { name: `${root}/matches/${id}`, fields: enc({ id, no: ++no, stage: g, a, b, status: "scheduled", inn: [], result: "", winner: null, overs: 12, upd: Date.now() }).mapValue.fields } });
  }
  await commit(w); console.log("created 10 teams and", no, "fixtures");
} else if (ACTION === "status") {
  const c = {}; for (const col of ["tournament", "matches", "polls", "fantasy", "fans", "meta"]) c[col] = (await listIds(col)).length;
  console.log("::notice title=Firestore counts::" + JSON.stringify(c));
} else if (ACTION === "go-live-check") {
  const note = (t, m) => console.log(`::notice title=${t}::${m}`);
  const DOMAIN = "sayyamgadiya-tech.github.io", SITE = `https://${DOMAIN}/mascon-cup-live/`;
  // 1. Authorized domains for Firebase Auth
  try {
    const cfgUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`;
    const cfg = await call("GET", cfgUrl);
    const doms = cfg.authorizedDomains || [];
    if (doms.includes(DOMAIN)) note("Auth domain", "already authorized: " + doms.join(", "));
    else { const r = await call("PATCH", cfgUrl + "?updateMask=authorizedDomains", { authorizedDomains: [...doms, DOMAIN] }); note("Auth domain", "ADDED. Now: " + (r.authorizedDomains || []).join(", ")); }
  } catch (e) { note("Auth domain FAILED", e.message.slice(0, 300)); }
  // 2. Live site serves the latest files
  for (const f of ["", "players.js", "config.js", "app.js"]) {
    try { const r = await fetch(SITE + f + "?t=" + Date.now()); const t = await r.text();
      note("Site " + (f || "index.html"), `${r.status} ${t.length} bytes${f === "players.js" ? " kidsSponsors=" + t.includes("MASCON_KIDS_SPONSORS") + " hundia=" + t.includes('"sponsor":"Smt Hulasi') : ""}${f === "app.js" ? " kids=" + t.includes("cup=kids") : ""}`);
    } catch (e) { note("Site " + f + " FAILED", e.message); }
  }
  // 3. Anonymous sign-in as a phone on the new site would do it (same API key, Referer = new site)
  try {
    const key = "AIzaSyBv8PYkcXsOSrNxsIkMVn-_EYo0Hrm0Yqg";
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`, { method: "POST", headers: { "content-type": "application/json", Referer: SITE, Origin: `https://${DOMAIN}` }, body: JSON.stringify({ returnSecureToken: true }) });
    const j = await r.json(); note("Fan sign-in from new site", r.status + " " + (j.idToken ? "OK" : JSON.stringify(j.error || j).slice(0, 200)));
    if (j.localId) await call("POST", `https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:delete`, { localId: j.localId }).catch(() => {});
  } catch (e) { note("Fan sign-in FAILED", e.message); }
} else { console.error("Unknown ACTION", ACTION); process.exit(1); }
