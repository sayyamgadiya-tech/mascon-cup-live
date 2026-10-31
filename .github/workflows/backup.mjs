// Backup of the whole tournament database to the "backups" branch (never served on the public site).
// MODE=quick : teams, matches (every ball) and meta, adults + kids  (~50 reads)
// MODE=full  : quick + fantasy teams, prediction fans and polls     (a few hundred reads)
// Files: backups/YYYY-MM-DD/HHMM-<mode>.json (IST) and latest-<mode>.json. Skips writing when nothing changed.
import fs from "node:fs";
import crypto from "node:crypto";
import { GoogleAuth } from "google-auth-library";

const project = "ahore-mascon-cup-2026";
const MODE = process.env.MODE === "full" ? "full" : "quick";
const OUT = process.env.OUT || "out";
let key = process.env.KEY || "";
if (!key.trim().startsWith("{")) key = "{" + key;
const auth = new GoogleAuth({ credentials: JSON.parse(key), scopes: ["https://www.googleapis.com/auth/datastore"] });
const client = await auth.getClient();
const api = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

const base = ["tournament", "matches", "meta"], extra = ["fantasy", "fans", "polls", "cup"];
const cols = (MODE === "full" ? [...base, ...extra] : base).flatMap(c => [c, "k" + c]);

const data = {};
for (const col of cols) {
  const docs = {}; let tok = "";
  do {
    const r = (await client.request({ url: `${api}/${col}?pageSize=300${tok ? "&pageToken=" + tok : ""}` })).data;
    (r.documents || []).forEach(d => { docs[d.name.split("/").pop()] = d.fields || {}; });
    tok = r.nextPageToken || "";
  } while (tok);
  data[col] = docs;
}
const body = JSON.stringify(data);
const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
const latest = `${OUT}/latest-${MODE}.json`;
let prev = ""; try { prev = JSON.parse(fs.readFileSync(latest, "utf8")).hash; } catch (e) {}
const counts = Object.fromEntries(Object.entries(data).map(([c, d]) => [c, Object.keys(d).length]));
if (prev === hash) { console.log(`::notice title=Backup ${MODE}::No change since last backup ${JSON.stringify(counts)}`); process.exit(0); }

const ist = new Date(Date.now() + 5.5 * 3600e3).toISOString();
const day = ist.slice(0, 10), hm = ist.slice(11, 16).replace(":", "");
const file = { at: ist.slice(0, 16).replace("T", " ") + " IST", mode: MODE, hash, counts, data };
fs.mkdirSync(`${OUT}/backups/${day}`, { recursive: true });
fs.writeFileSync(`${OUT}/backups/${day}/${hm}-${MODE}.json`, JSON.stringify(file));
fs.writeFileSync(latest, JSON.stringify(file));
fs.writeFileSync(`${OUT}/.changed`, `backups/${day}/${hm}-${MODE}.json`);
console.log(`::notice title=Backup ${MODE} saved::backups/${day}/${hm}-${MODE}.json ${JSON.stringify(counts)}`);
