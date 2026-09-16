import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, installed } from './fixtures.ts';
import { canonicalHttpsIssuer, createProviderFramework } from '../src/providers/index.ts';
import { createIdentityLinks } from '../src/links.ts';
import type { IdentityProviderAdapter, ProviderNetworkBroker, ProviderSecretBroker } from '../src/providers/index.ts';

class Secrets implements ProviderSecretBroker { m=new Map<string,string>(); async put(_p:string,v:string){const r=`s${this.m.size}`;this.m.set(r,v);return r;} async get(r:string){return this.m.get(r)!;} async delete(r:string){this.m.delete(r);} }
const network:ProviderNetworkBroker={async request(){return {status:200,headers:{},body:'{}'};}};
const adapter:IdentityProviderAdapter<{sub:string}>={kind:'fake',capabilities:{web:true},canonicalizeIssuer:canonicalHttpsIssuer,
 begin(i){return {authorizationUrl:`https://idp.example/auth?state=${i.state}`};},async exchange(i){return {sub:i.code};},async resolveIdentity(x){return {issuer:'https://idp.example',subject:x.sub};}};
async function prepared(t:test.TestContext){
 const f=fixture(t), {owner}=await installed(f);
 const providers=createProviderFramework(f.control,{adapters:[adapter],secrets:new Secrets(),network,now:()=>f.now()});
 let p=await providers.configure({id:'work',kind:'fake',issuer:'https://idp.example'}); p=providers.setEnabled('work',p.revision,true);
 const links=createIdentityLinks(f.control,f.identity.sessions,providers,f.identity.passkeys.methodCount);
 return {f,owner,providers,links};
}

test('link requires a reauthenticated current session and same session at callback',async t=>{
 const {f,owner,links}=await prepared(t);
 const tx=await links.begin(owner.token,{providerId:'work',browserBinding:'b'.repeat(64),callbackUrl:'https://polyth.example/cb',returnTo:'/settings'});
 const second=await f.identity.credentials.login({login:'Max',password:'owner test passphrase'});
 await assert.rejects(links.complete(second.token,{providerId:'work',state:tx.state,browserBinding:'b'.repeat(64),code:'subject'}),e=>(e as {code?:string}).code==='invalid-provider-transaction');
 const done=await links.complete(owner.token,{providerId:'work',state:tx.state,browserBinding:'b'.repeat(64),code:'subject'});
 assert.equal(done.links.length,1); assert.equal(done.links[0]!.subject,'subject');
});
test('already linked subject cannot be merged into another account by email or callback',async t=>{
 const {f,owner,providers}=await prepared(t);
 providers.link(owner.userId,'work',{issuer:'https://idp.example',subject:'42',email:'same@example.com'});
 const second=await f.identity.accounts.createLocal(owner.token,{login:'other',name:'Other',password:'another strong passphrase'});
 assert.throws(()=>providers.link(second.id,'work',{issuer:'https://idp.example',subject:'42',email:'different@example.com'}),e=>(e as {code?:string}).code==='conflict');
 assert.equal(providers.resolveLinkedUser('work',{issuer:'https://idp.example',subject:'42'}),owner.userId);
});
test('unlink keeps user id/resources and invalidates other sessions',async t=>{
 const {f,owner,providers,links}=await prepared(t);
 providers.link(owner.userId,'work',{issuer:'https://idp.example',subject:'42'});
 const second=await f.identity.credentials.login({login:'Max',password:'owner test passphrase'});
 const link=links.list(owner.token)[0]!;
 links.unlink(owner.token,link.id,link.revision);
 assert.equal(f.control.get<{n:number}>('SELECT count(*) AS n FROM login_identities WHERE user_id=?',owner.userId)!.n,0);
 assert.ok(f.control.get('SELECT 1 FROM users WHERE id=?',owner.userId));
 assert.equal(f.identity.sessions.resolve(owner.token),null); assert.equal(f.identity.sessions.resolve(second.token),null);
 assert.ok(f.control.get('SELECT 1 FROM password_credentials WHERE user_id=?',owner.userId));
});
test('last external sign-in method cannot be removed',async t=>{
 const {f,owner,providers,links}=await prepared(t);
 providers.link(owner.userId,'work',{issuer:'https://idp.example',subject:'42'});
 f.control.transaction(()=>f.control.run('DELETE FROM password_credentials WHERE user_id=?',owner.userId));
 const link=links.list(owner.token)[0]!;
 assert.throws(()=>links.unlink(owner.token,link.id,link.revision),e=>(e as {code?:string}).code==='last-auth-method');
 assert.equal(links.list(owner.token).length,1);
});
