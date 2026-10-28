// Publishes firestore.rules via the Firebase Rules REST API using a service-account key.
import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";
const project = "ahore-mascon-cup-2026";
const src = fs.readFileSync("firestore.rules", "utf8");
let key = process.env.KEY || "";
if (!key.trim().startsWith("{")) key = "{" + key;
const credentials = JSON.parse(key);
const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/firebase", "https://www.googleapis.com/auth/cloud-platform"] });
const client = await auth.getClient();
const base = `https://firebaserules.googleapis.com/v1/projects/${project}`;
const call = async (method, url, body) => {
  const r = await client.request({ method, url, data: body }).catch(e => { throw new Error(`${method} ${url} -> ${e.response?.status} ${JSON.stringify(e.response?.data?.error?.message || e.message)}`) });
  return r.data;
};
// 1. test compile
const test = await call("POST", `${base}:test`, { source: { files: [{ name: "firestore.rules", content: src }] } });
if (test.issues?.some(i => i.severity === "ERROR")) { console.error(JSON.stringify(test.issues, null, 2)); process.exit(1); }
// 2. create ruleset
const rs = await call("POST", `${base}/rulesets`, { source: { files: [{ name: "firestore.rules", content: src }] } });
console.log("ruleset", rs.name);
// 3. point the Firestore release at it
const rel = await call("PATCH", `${base}/releases/cloud.firestore`, { release: { name: `projects/${project}/releases/cloud.firestore`, rulesetName: rs.name } });
console.log("released", rel.name, "->", rel.rulesetName);
