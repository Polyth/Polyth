import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openControlPlane, readLegacyJson } from "../src/index.ts";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(),"polyth-control-"));
  const control = openControlPlane({directory});
  t.after(() => {control.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,control};
}
test("control authority has strict schema, private paths and a stable sentinel", t => {
  const {directory,control} = fixture(t);
  assert.equal(statSync(control.file).mode & 0o777,0o600);
  assert.equal(statSync(join(directory,"control-plane")).mode & 0o777,0o700);
  assert.equal(control.get<{foreign_keys:number}>("PRAGMA foreign_keys")?.foreign_keys,1);
  const id=control.installation().id;control.close();
  const reopened=openControlPlane({directory});t.after(()=>reopened.close());
  assert.equal(reopened.installation().id,id);
  assert.equal(reopened.installation().state,"uninitialized");
});
test("domain state, audit, outbox and epoch roll back together", t => {
  const {control:c}=fixture(t);const before=c.installation();
  assert.throws(()=>c.transaction(()=>{
    c.bumpEpoch();c.audit("system:test","fixture.changed");
    c.run("INSERT INTO principals(id,kind,status) VALUES('usr_test','user','active')");
    throw new Error("fault");
  }),/fault/);
  assert.deepEqual(c.installation(),before);
  assert.equal(c.get("SELECT 1 FROM principals"),undefined);
  assert.equal(c.get("SELECT 1 FROM audit_events"),undefined);
  assert.equal(c.get("SELECT 1 FROM outbox"),undefined);
  c.transaction(()=>{c.bumpEpoch();c.audit("system:test","fixture.committed");});
  assert.equal(c.all("SELECT * FROM outbox").length,1);
});
test("nested transactions use savepoints, not a second authority", t => {
  const {control:c}=fixture(t);
  c.transaction(()=>{
    c.audit("system:test","outer");
    assert.throws(()=>c.transaction(()=>{c.audit("system:test","inner");throw new Error("fault");}),/fault/);
    c.audit("system:test","after");
  });
  assert.deepEqual(c.all<{action:string}>("SELECT action FROM audit_events ORDER BY seq").map(r=>r.action),["outer","after"]);
});
test("writes outside a transaction and asynchronous transactions are rejected", t => {
  const {control:c}=fixture(t);
  assert.throws(()=>c.run("DELETE FROM outbox"),{code:"invalid-input"});
  let invoked=false;
  assert.throws(()=>c.transaction(async()=>{invoked=true;}),{code:"invalid-input"});
  assert.equal(invoked,false);
  assert.throws(()=>c.transaction(()=>{c.audit("system:test","never");return Promise.resolve();}),{code:"invalid-input"});
  assert.equal(c.get("SELECT 1 FROM audit_events"),undefined);
});
test("foreign keys reject an orphan membership atomically", t => {
  const {control:c}=fixture(t);
  assert.throws(()=>c.transaction(()=>c.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('missing','missing','owner',0)")));
  assert.deepEqual(c.all("PRAGMA foreign_key_check"),[]);
});
for(const damage of ["missing-db","sentinel-mismatch","checksum","malformed-db"] as const) test(`recovery-required instead of reset after ${damage}`,t=>{
  const {directory,control:c}=fixture(t);const file=c.file;c.close();
  if(damage==="missing-db")unlinkSync(file);
  if(damage==="sentinel-mismatch")writeFileSync(join(directory,"control-plane","installation.json"),JSON.stringify({version:1,id:"00000000-0000-0000-0000-000000000000"}));
  if(damage==="malformed-db")writeFileSync(file,"not a database");
  if(damage==="checksum"){
    const raw=new DatabaseSync(file);raw.exec("UPDATE schema_migrations SET checksum='bad'");raw.close();
  }
  assert.throws(()=>openControlPlane({directory}),{code:"recovery-required"});
});
test("malformed legacy JSON is not confused with an absent file", t=>{
  const {directory}=fixture(t);const file=join(directory,"legacy.json");
  assert.equal(readLegacyJson(file),null);writeFileSync(file,"{");
  assert.throws(()=>readLegacyJson(file),{code:"recovery-required"});
  assert.equal(readFileSync(file,"utf8"),"{");
});
