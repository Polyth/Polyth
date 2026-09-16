import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {tmpdir} from "node:os";

const script=fileURLToPath(new URL("../migrate-identity.ts",import.meta.url));
const run=(...args:string[])=>spawnSync(process.execPath,["--experimental-strip-types",script,...args],{encoding:"utf8",timeout:10000});
function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),"polyth-migration-cli-")),data=join(root,"input"),stage=join(root,"stage");
  mkdirSync(data,{mode:0o700});t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(data,"auth.json"),JSON.stringify({version:2,passwordHash:null,credentials:[],sessions:[]}));
  return {root,data,stage};
}
test("operator CLI completes inspect/stage/verify without starting a server or creating an authority",t=>{
  const f=fixture(t), inspected=run("inspect","--data-dir",f.data);
  assert.equal(inspected.status,0,inspected.stderr);
  const digest=JSON.parse(inspected.stdout).inventoryDigest;
  const staged=run("stage","--data-dir",f.data,"--stage-dir",f.stage,"--expect-inventory",digest,"--offline");
  assert.equal(staged.status,0,staged.stderr);
  const manifest=JSON.parse(staged.stdout);
  assert.equal(manifest.scope,"identity-migration-inputs");
  const verified=run("verify","--stage-dir",f.stage,"--expect-manifest",manifest.manifestDigest);
  assert.equal(verified.status,0,verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout),manifest);
  assert.equal(existsSync(join(f.data,"control-plane")),false);
  assert.equal(existsSync(join(f.stage,"control-plane")),false);
});
test("operator CLI requires an offline acknowledgement and a pinned inventory",t=>{
  const f=fixture(t),digest=JSON.parse(run("inspect","--data-dir",f.data).stdout).inventoryDigest;
  const noOffline=run("stage","--data-dir",f.data,"--stage-dir",f.stage,"--expect-inventory",digest);
  assert.equal(noOffline.status,1);assert.match(noOffline.stderr,/offline-required/);
  assert.equal(existsSync(f.stage),false);
  const noDigest=run("stage","--data-dir",f.data,"--stage-dir",f.stage,"--offline");
  assert.equal(noDigest.status,1);assert.equal(existsSync(f.stage),false);
});
test("operator CLI fails closed on quarantine, unsupported commands and secret-looking arguments",t=>{
  const f=fixture(t);
  writeFileSync(join(f.data,"auth.json"),"CANARY_CREDENTIAL_DO_NOT_ECHO");
  const inspected=run("inspect","--data-dir",f.data);
  assert.equal(inspected.status,2);assert.equal(inspected.stdout.includes("CANARY"),false);
  const digest=JSON.parse(inspected.stdout).inventoryDigest;
  const staged=run("stage","--data-dir",f.data,"--stage-dir",f.stage,"--expect-inventory",digest,"--offline");
  assert.equal(staged.status,2);assert.equal(JSON.parse(staged.stdout).status,"quarantined");
  const invalid=run("activate","--secret=CANARY");
  assert.equal(invalid.status,1);assert.equal(invalid.stderr.includes("CANARY"),false);
});
