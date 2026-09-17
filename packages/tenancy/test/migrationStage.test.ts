import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {spawn, type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {DatabaseSync} from "node:sqlite";
import {inventoryLegacyMigration} from "../src/legacyMigration.ts";
import {stageLegacyMigration, verifyMigrationStage} from "../src/migrationStage.ts";

const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-migration-stage-"));
  const dataDir = join(dir, "input"), stageDir = join(dir, "capsule");
  mkdirSync(dataDir, {mode:0o700});
  json(join(dataDir,"auth.json"), { version:2, passwordHash:null,
    credentials:[{userId:"usr_owner",passwordHash:`scrypt$${"a".repeat(32)}$${"b".repeat(64)}`}],sessions:[] });
  json(join(dataDir,"projects.json"), [{id:"p",path:join(dir,"project")}]);
  const file = join(dataDir, "sessions.db");
  const writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE projections(session_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  writer.prepare("INSERT INTO projections VALUES(?,?)").run("s",JSON.stringify({id:"s",projectId:"p",title:"WAL content"}));
  writer.exec("CREATE TABLE unknown_extension(k TEXT PRIMARY KEY, v BLOB); INSERT INTO unknown_extension VALUES('opaque',X'010203')");
  const release = () => { try { writer.close(); } catch { /* already closed */ } };
  t.after(() => { release(); rmSync(dir,{recursive:true,force:true}); });
  const options = () => ({dataDir,stageDir,expectedInventoryDigest:inventoryLegacyMigration({dataDir}).inventoryDigest});
  return {dir,dataDir,stageDir,file,writer,release,options};
}

test("snapshot contains committed WAL and unknown tables, with private files and no source data writes", t => {
  const f = fixture(t), before = inventoryLegacyMigration({dataDir:f.dataDir});
  const mainBefore = hash(f.file), walBefore = hash(`${f.file}-wal`);
  const result = stageLegacyMigration(f.options());
  assert.equal(result.status,"verified");
  assert.equal(result.artifacts.length,5);
  assert.equal(statSync(f.stageDir).mode & 0o777,0o700);
  assert.equal(statSync(join(f.stageDir,"sources")).mode & 0o777,0o700);
  for (const artifact of result.artifacts) if (artifact.status==="copied") {
    assert.equal(statSync(join(f.stageDir,artifact.file)).mode & 0o777,0o600);
    assert.equal(hash(join(f.stageDir,artifact.file)),artifact.sha256);
  }
  assert.equal(hash(f.file),mainBefore); assert.equal(hash(`${f.file}-wal`),walBefore);
  assert.equal(inventoryLegacyMigration({dataDir:f.dataDir}).inventoryDigest,before.inventoryDigest);
  const snapshot = new DatabaseSync(join(f.stageDir,"sources/sessions.db"),{readOnly:true});
  try {
    assert.equal(JSON.parse((snapshot.prepare("SELECT data FROM projections").get() as {data:string}).data).title,"WAL content");
    assert.deepEqual([...((snapshot.prepare("SELECT v FROM unknown_extension").get() as {v:Uint8Array}).v)],[1,2,3]);
    assert.equal((snapshot.prepare("PRAGMA journal_mode").get() as {journal_mode:string}).journal_mode,"delete");
  } finally { snapshot.close(); }
  assert.deepEqual(verifyMigrationStage(f.stageDir,result.manifestDigest),result);
});

test("completed stage is idempotent, preserves the same ID and does not invoke copy progress again", t => {
  const f = fixture(t), opts = f.options();
  const first = stageLegacyMigration(opts), journalHash = hash(join(f.stageDir,"migration.sqlite"));
  const second = stageLegacyMigration({...opts,onArtifact:()=>assert.fail("must reuse validated checkpoint")});
  assert.deepEqual(second,first); assert.equal(hash(join(f.stageDir,"migration.sqlite")),journalHash);
});

test("capsule validation does not depend on the original data root remaining available", t => {
  const f = fixture(t), result = stageLegacyMigration(f.options());
  f.release(); rmSync(f.dataDir,{recursive:true});
  assert.deepEqual(verifyMigrationStage(f.stageDir,result.manifestDigest),result);
});

test("stale dry-run and post-copy source drift cannot produce a verified checkpoint", t => {
  const f = fixture(t), opts = f.options(), file=join(f.dataDir,"auth.json"), original=readFileSync(file);
  writeFileSync(file,"{}");
  assert.throws(()=>stageLegacyMigration(opts),{code:"source-changed"});
  assert.equal(existsSync(f.stageDir),false);
  writeFileSync(file,original);
  assert.throws(()=>stageLegacyMigration({...opts,onArtifact:row=>{
    if(row.kind==="auth") writeFileSync(file,"{}");
  }}),{code:"source-changed"});
  writeFileSync(file,original);
  const journal = new DatabaseSync(join(f.stageDir,"migration.sqlite"));
  assert.equal((journal.prepare("SELECT status FROM stage").get() as {status:string}).status,"copying");
  assert.equal(journal.prepare("SELECT * FROM artifacts").all().length,0); journal.close();
  assert.equal(stageLegacyMigration(opts).status,"verified");
});

test("review-only topology and malformed authority stay quarantined even when backups are complete", t => {
  const f=fixture(t);
  json(join(f.dataDir,"projects.json"),[{id:"p",path:join(f.dir,"repo")},{id:"child",path:join(f.dir,"repo/subdir")}]);
  const inventory=inventoryLegacyMigration({dataDir:f.dataDir});
  assert.equal(inventory.safeToStage,true);
  const result=stageLegacyMigration(f.options());
  assert.equal(result.status,"quarantined");
  assert.equal(verifyMigrationStage(f.stageDir,result.manifestDigest).status,"quarantined");
  writeFileSync(join(f.dataDir,"auth.json"),"CANARY_SECRET_NOT_FOR_REPORTS");
  const other=stageLegacyMigration({...f.options(),stageDir:join(f.dir,"malformed")});
  assert.equal(other.status,"quarantined");
  assert.equal(other.artifacts.find(row=>row.kind==="auth")?.status,"copied");
  assert.equal(JSON.stringify(other).includes("CANARY"),false);
});

test("unsafe sources have explicit missing coverage and are not followed into a backup", t => {
  const f=fixture(t), external=join(f.dir,"secret");writeFileSync(external,"CANARY");
  rmSync(join(f.dataDir,"auth.json"));symlinkSync(external,join(f.dataDir,"auth.json"));
  const result=stageLegacyMigration(f.options());
  assert.equal(result.status,"quarantined");
  assert.equal(result.artifacts.find(row=>row.kind==="auth")?.status,"blocked");
  assert.equal(existsSync(join(f.stageDir,"sources/auth.json")),false);
  assert.equal(JSON.stringify(result).includes("CANARY"),false);
});

for(const attack of ["bytes","manifest","symlink","hardlink","permissions","unexpected-file"] as const) {
  test(`capsule verification rejects ${attack} without overwriting or repairing evidence`,t=>{
    const f=fixture(t), result=stageLegacyMigration(f.options()), file=join(f.stageDir,"sources/auth.json");
    if(attack==="bytes")writeFileSync(file,"changed");
    if(attack==="manifest") {
      const db=new DatabaseSync(join(f.stageDir,"migration.sqlite"));db.exec("UPDATE stage SET status='quarantined'");db.close();
    }
    if(attack==="symlink"||attack==="hardlink") {
      rmSync(file); if(attack==="symlink")symlinkSync(join(f.dataDir,"auth.json"),file);
      else linkSync(join(f.dataDir,"auth.json"),file);
    }
    if(attack==="permissions")chmodSync(file,0o644);
    if(attack==="unexpected-file")writeFileSync(join(f.stageDir,"sources/new.txt"),"unmanaged");
    assert.throws(()=>verifyMigrationStage(f.stageDir,result.manifestDigest));
    if(attack==="bytes")assert.equal(readFileSync(file,"utf8"),"changed");
  });
}

test("stage rejects source overlap, unmanaged existing directories and symbolic-link destinations", t=>{
  const f=fixture(t), opts=f.options();
  assert.throws(()=>stageLegacyMigration({...opts,stageDir:join(f.dataDir,"backup")}),{code:"stage-overlaps-source"});
  mkdirSync(f.stageDir,{mode:0o700});writeFileSync(join(f.stageDir,"keep.txt"),"keep");
  assert.throws(()=>stageLegacyMigration(opts),{code:"unexpected-stage-content"});
  assert.equal(readFileSync(join(f.stageDir,"keep.txt"),"utf8"),"keep");
  const target=join(f.dir,"link");symlinkSync(f.stageDir,target,"dir");
  assert.throws(()=>stageLegacyMigration({...opts,stageDir:target}),{code:"unsafe-stage-directory"});
});

function child(code:string): ChildProcess {
  return spawn(process.execPath,["--experimental-strip-types","--input-type=module","-e",code],
    {stdio:["ignore","pipe","pipe","ipc"]});
}
const moduleUrl = new URL("../src/migrationStage.ts",import.meta.url).href;

test("SIGKILL after snapshot creation leaves a resumable checkpoint, no stale PID lock and no duplicate records",{timeout:15000},async t=>{
  const f=fixture(t),opts=f.options();
  // Close the writer before cross-process snapshots; this fixture is genuinely offline.
  f.release();opts.expectedInventoryDigest=inventoryLegacyMigration({dataDir:f.dataDir}).inventoryDigest;
  const proc=child(`import {stageLegacyMigration} from ${JSON.stringify(moduleUrl)};
    stageLegacyMigration({...${JSON.stringify(opts)},onArtifact(row){if(row.kind==='sessions'){
      process.send({copied:true}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
    }}});`);
  t.after(()=>{if(proc.exitCode===null)proc.kill('SIGKILL');});
  const exited=once(proc,"exit");
  const [message]=await Promise.race([once(proc,"message"),exited.then(()=>{throw new Error("child exited before checkpoint");})]);
  assert.deepEqual(message,{copied:true});proc.kill("SIGKILL");
  const [,signal]=await exited;assert.equal(signal,"SIGKILL");
  const result=stageLegacyMigration(opts);assert.equal(result.status,"verified");
  assert.equal(result.artifacts.length,5);
  assert.deepEqual(stageLegacyMigration(opts),result);
  assert.deepEqual(readdirSync(join(f.stageDir,"sources")).sort(),["auth.json","projects.json","sessions.db"]);
});

test("independent processes serialize retry of one initialized stage",{timeout:15000},async t=>{
  const f=fixture(t);f.release();const opts=f.options();
  assert.throws(()=>stageLegacyMigration({...opts,onArtifact(){throw new Error("fixture fault");}}),{code:"stage-incomplete"});
  const code=`import {stageLegacyMigration} from ${JSON.stringify(moduleUrl)};
    const result=stageLegacyMigration(${JSON.stringify(opts)});process.send({id:result.id,digest:result.manifestDigest});`;
  const children=[child(code),child(code)];
  t.after(()=>children.forEach(p=>{if(p.exitCode===null)p.kill('SIGKILL');}));
  const outputs=await Promise.all(children.map(async p=>{
    let stderr="";p.stderr!.on("data",chunk=>stderr+=chunk);
    const exited=once(p,"exit"), message=once(p,"message");
    const [value]=await Promise.race([message,exited.then(()=>{throw new Error(stderr||"no result");})]);
    assert.equal((await exited)[0],0,stderr);return value;
  }));
  assert.deepEqual(outputs[0],outputs[1]);
});
