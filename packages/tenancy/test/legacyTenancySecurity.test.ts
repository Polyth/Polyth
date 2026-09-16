import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTenancyStore, type CreateSpaceInput } from "../src/store.ts";
import { inventoryLegacyMigration } from "../src/legacyMigration.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-tenancy-integrity-")), file = join(root, "tenancy.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file };
}
function initialized(t: test.TestContext) {
  const f = fixture(t), store = createTenancyStore({file:f.file});
  const owner = store.createUser("Owner"), admin = store.createUser("Admin"), other = store.createUser("Other");
  const space = store.createSpace({name:"Private", ownerId:owner.id});
  store.addMember(owner.id, space.id, admin.id, "admin");
  return {...f,store,owner,admin,other,space};
}
const bytes = (file:string) => readFileSync(file, "utf8");
const read = (file:string) => JSON.parse(bytes(file));
const write = (file:string,value:unknown) => writeFileSync(file,JSON.stringify(value));

for (const damage of ["json", "future-version", "unknown-authority-field", "unknown-role", "timestamp", "duplicate-user",
  "duplicate-membership", "orphan-membership", "no-owner", "unsafe-slug", "missing-field"] as const) {
  test(`legacy authority rejects ${damage} without resetting or overwriting bytes`,t=>{
    const f=initialized(t), data=read(f.file);
    if(damage==="future-version")data.version=100;
    if(damage==="unknown-authority-field")data.trustedAdmin="CANARY_SECRET";
    if(damage==="unknown-role")data.memberships[0].role="superowner";
    if(damage==="timestamp")data.users[0].createdAt=-1;
    if(damage==="duplicate-user")data.users.push(data.users[0]);
    if(damage==="duplicate-membership")data.memberships.push(data.memberships[0]);
    if(damage==="orphan-membership")data.memberships[0].userId="missing_user";
    if(damage==="no-owner")data.memberships[0].role="viewer";
    if(damage==="unsafe-slug")data.spaces[0].slug="../outside";
    if(damage==="missing-field")delete data.users[0].createdAt;
    if(damage==="json")writeFileSync(f.file,"CANARY_SECRET");else write(f.file,data);
    const before=bytes(f.file);
    assert.throws(()=>createTenancyStore({file:f.file}),{code:"recovery-required"});
    assert.equal(bytes(f.file),before);
  });
}

test("only an absent regular authority is a fresh registry; symlinks and directories are not",t=>{
  const f=fixture(t), missing=createTenancyStore({file:f.file});
  assert.equal(missing.users().length,0);assert.equal(existsSync(f.file),false);
  const external=join(f.root,"other.json");write(external,{version:1,users:[],spaces:[],memberships:[],selections:{}});
  symlinkSync(external,f.file);
  assert.throws(()=>createTenancyStore({file:f.file}),{code:"recovery-required"});
  rmSync(f.file);mkdirSync(f.file);
  assert.throws(()=>createTenancyStore({file:f.file}),{code:"recovery-required"});
});

test("all malformed registry rows are reported at safe numeric locations and never used as owner evidence",t=>{
  const f=initialized(t),data=read(f.file);
  data.users[1].createdAt=-1;data.users[2].name="CANARY\u0000SECRET";
  write(f.file,data);
  write(join(f.root,"auth.json"),{version:2,passwordHash:null,
    credentials:[{userId:"usr_owner",passwordHash:`scrypt$${"a".repeat(32)}$${"b".repeat(64)}`}],sessions:[]});
  write(join(f.root,"projects.json"),[{id:"p",path:join(f.root,"repo")}]);
  const report=inventoryLegacyMigration({dataDir:f.root});
  assert.equal(report.safeToStage,false);
  const registryIssues=report.issues.filter(row=>row.code==="invalid-tenancy-shape");
  assert.ok(registryIssues.some(row=>row.resourceId==="users[1]"));
  assert.ok(registryIssues.some(row=>row.resourceId==="users[2]"));
  assert.equal(JSON.stringify(report).includes("CANARY"),false);
  assert.equal(report.plannedAdoptions.some(row=>row.kind==="project"),false);
});

test("the last owner cannot be downgraded through addMember",t=>{
  const f=initialized(t),before=bytes(f.file);
  assert.throws(()=>f.store.addMember(f.owner.id,f.space.id,f.owner.id,"member"),{code:"invalid-input"});
  assert.equal(f.store.roleOf(f.owner.id,f.space.id),"owner");
  assert.equal(bytes(f.file),before);
});

test("admins cannot promote themselves or downgrade/remove an owner, even when another owner exists",t=>{
  const f=initialized(t);
  f.store.addMember(f.owner.id,f.space.id,f.other.id,"owner");
  for(const operation of [
    ()=>f.store.addMember(f.admin.id,f.space.id,f.admin.id,"owner"),
    ()=>f.store.addMember(f.admin.id,f.space.id,f.owner.id,"member"),
    ()=>f.store.removeMember(f.admin.id,f.space.id,f.owner.id),
  ])assert.throws(operation,{code:"forbidden"});
  assert.equal(f.store.roleOf(f.owner.id,f.space.id),"owner");
  assert.equal(f.store.roleOf(f.admin.id,f.space.id),"admin");
  f.store.addMember(f.owner.id,f.space.id,f.owner.id,"member");
  assert.equal(f.store.roleOf(f.other.id,f.space.id),"owner");
  assert.equal(createTenancyStore({file:f.file}).roleOf(f.owner.id,f.space.id),"member");
});

test("failed multi-field validation leaves both memory and disk unchanged and usable",t=>{
  const f=initialized(t),before=bytes(f.file);
  assert.throws(()=>f.store.renameSpace(f.owner.id,f.space.id,{name:"Changed",color:"not-hex"}),{code:"invalid-input"});
  assert.equal(f.store.requireMembership(f.owner.id,f.space.id).space.name,"Private");
  assert.equal(bytes(f.file),before);
  f.store.renameSpace(f.owner.id,f.space.id,{name:"Valid"});
  assert.equal(createTenancyStore({file:f.file}).allSpaces()[0]!.name,"Valid");
});

test("a returned membership cannot mutate persistent storage identity or grant authority",t=>{
  const f=initialized(t),before=bytes(f.file),found=f.store.requireMembership(f.owner.id,f.space.id);
  found.space.slug="replacement";found.space.name="Changed";found.role="viewer";
  assert.equal(f.store.requireMembership(f.owner.id,f.space.id).space.slug,f.space.slug);
  assert.equal(f.store.requireMembership(f.owner.id,f.space.id).role,"owner");
  assert.equal(bytes(f.file),before);
});

test("failed persistence invalidates the store instead of serving an in-memory grant",t=>{
  const f=initialized(t),before=bytes(f.file);
  rmSync(f.file);mkdirSync(f.file);
  assert.throws(()=>f.store.addMember(f.owner.id,f.space.id,f.other.id,"owner"),{code:"recovery-required"});
  assert.throws(()=>f.store.roleOf(f.other.id,f.space.id),{code:"recovery-required"});
  assert.throws(()=>f.store.allSpaces(),{code:"recovery-required"});
  rmSync(f.file,{recursive:true});writeFileSync(f.file,before);
  const reopened=createTenancyStore({file:f.file});
  assert.equal(reopened.roleOf(f.other.id,f.space.id),undefined);
  assert.equal(bytes(f.file),before);
});

test("stale legacy writer cannot erase a later persisted membership",t=>{
  const f=initialized(t),stale=createTenancyStore({file:f.file});
  f.store.addMember(f.owner.id,f.space.id,f.other.id,"viewer");
  const before=bytes(f.file);
  assert.throws(()=>stale.renameSpace(f.owner.id,f.space.id,{name:"Stale"}),{code:"recovery-required"});
  assert.throws(()=>stale.snapshot(),{code:"recovery-required"});
  assert.equal(bytes(f.file),before);
  assert.equal(createTenancyStore({file:f.file}).roleOf(f.other.id,f.space.id),"viewer");
});

test("runtime ID, slug and decoration validation always leaves a reloadable registry",t=>{
  const f=initialized(t);
  assert.throws(()=>f.store.createUser("Unsafe","../user"),{code:"invalid-input"});
  assert.throws(()=>f.store.createSpace({ownerId:f.owner.id,name:"Number",slug:123} as unknown as CreateSpaceInput),{code:"invalid-input"});
  assert.throws(()=>f.store.createSpace({ownerId:f.owner.id,name:"Blank icon",icon:"  "}),{code:"invalid-input"});
  const first=f.store.createSpace({ownerId:f.owner.id,name:"Long",slug:"a".repeat(40)});
  const second=f.store.createSpace({ownerId:f.owner.id,name:"Another",slug:"a".repeat(40)});
  assert.ok(second.slug.length<=40);assert.notEqual(first.slug,second.slug);
  assert.equal(createTenancyStore({file:f.file}).allSpaces().length,3);
});

test("device selection uses own keys without prototype mutation and remains reloadable",t=>{
  const f=initialized(t);
  f.store.select("__proto__",f.owner.id,f.space.id);
  assert.equal(f.store.selection("__proto__",f.owner.id),f.space.id);
  assert.equal(Object.hasOwn(read(f.file).selections,"__proto__"),true);
  assert.equal(createTenancyStore({file:f.file}).selection("__proto__",f.owner.id),f.space.id);
  assert.equal(({} as {polluted?:unknown}).polluted,undefined);
});
