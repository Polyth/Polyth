import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openControlPlane } from '@polyth/control-plane';
import { canonicalHttpsIssuer, createProviderFramework } from '../src/providers/index.ts';
import type { IdentityProviderAdapter, ProviderNetworkBroker, ProviderSecretBroker } from '../src/providers/index.ts';

class Secrets implements ProviderSecretBroker {
  values = new Map<string,string>();
  async put(_purpose:string, value:string) { const ref=`sec_${this.values.size+1}`; this.values.set(ref,value); return ref; }
  async get(ref:string) { const v=this.values.get(ref); if(v===undefined) throw new Error('missing'); return v; }
  async delete(ref:string) { this.values.delete(ref); }
}
class Network implements ProviderNetworkBroker {
  calls=0;
  async request() { this.calls++; return {status:200,headers:{},body:'{}'}; }
}
function fixture(t:test.TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'polyth-provider-'));
  const control=openControlPlane({directory:dir});
  t.after(()=>{control.close();rmSync(dir,{recursive:true,force:true});});
  control.transaction(()=>{
    control.run("INSERT INTO principals(id,kind,status) VALUES('usr_a','user','active'),('usr_b','user','active')");
    control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES('usr_a','A',0,0),('usr_b','B',0,0)");
    control.run("INSERT INTO instance_roles(user_id,role) VALUES('usr_a','owner')");
    control.run("UPDATE installation SET state='ready' WHERE singleton=1");
  });
  let now=1000, exchanges=0;
  const adapter:IdentityProviderAdapter<{subject:string}>={
    kind:'fake', capabilities:{web:true}, canonicalizeIssuer:canonicalHttpsIssuer,
    begin(input){ return {authorizationUrl:`https://login.example/authorize?state=${input.state}&challenge=${input.pkceChallenge}`}; },
    async exchange(input){ exchanges++; return {subject:input.code}; },
    async resolveIdentity(result){ return {issuer:'https://issuer.example',subject:result.subject,displayName:'External'}; },
  };
  const secrets=new Secrets(), network=new Network();
  const framework=createProviderFramework(control,{adapters:[adapter],secrets,network,now:()=>now,transactionMs:60_000});
  return {control,secrets,network,framework,advance:(ms:number)=>now+=ms,exchanges:()=>exchanges};
}
async function configured(f:ReturnType<typeof fixture>, id='work') {
  let p=await f.framework.configure({id,kind:'fake',issuer:'https://issuer.example/',publicConfig:{clientId:'public'},clientSecret:'shh'});
  p=f.framework.setEnabled(id,p.revision,true); return p;
}

test('issuer canonicalization rejects downgrade and URL ambiguity',()=>{
  assert.equal(canonicalHttpsIssuer('https://EXAMPLE.com/oidc/'),'https://example.com/oidc');
  for(const bad of ['http://example.com','https://u:p@example.com','https://example.com/?issuer=x','not a url']) assert.throws(()=>canonicalHttpsIssuer(bad));
});
test('configuration stores only broker references and rejects secret-shaped public config',async t=>{
  const f=fixture(t); const p=await f.framework.configure({id:'work',kind:'fake',issuer:'https://issuer.example',publicConfig:{clientId:'x'},clientSecret:'super-secret'});
  assert.equal(p.enabled,false); assert.equal(f.control.get<{client_secret_ref:string}>('SELECT client_secret_ref FROM identity_providers WHERE id=?','work')!.client_secret_ref,'sec_1');
  assert.equal(JSON.stringify(f.control.all('SELECT * FROM identity_providers')).includes('super-secret'),false);
  await assert.rejects(f.framework.configure({id:'bad',kind:'fake',issuer:'https://issuer.example',publicConfig:{accessToken:'oops'}}));
});
test('browser transaction hashes capabilities at rest and completes exactly once',async t=>{
  const f=fixture(t); await configured(f);
  const tx=await f.framework.begin({providerId:'work',purpose:'login',browserBinding:'b'.repeat(64),callbackUrl:'https://polyth.example/auth/callback',returnTo:'/chat'});
  const stored=f.control.get<{state_hash:string;secret_ref:string}>('SELECT state_hash,secret_ref FROM provider_transactions WHERE id=?',tx.id)!;
  assert.notEqual(stored.state_hash,tx.state); assert.equal(JSON.stringify(f.control.all('SELECT * FROM provider_transactions')).includes(tx.state),false);
  const done=await f.framework.complete({providerId:'work',purpose:'login',state:tx.state,browserBinding:'b'.repeat(64),code:'stable-subject'});
  assert.equal(done.identity.subject,'stable-subject'); assert.equal(done.returnTo,'/chat'); assert.equal(f.exchanges(),1);
  await assert.rejects(f.framework.complete({providerId:'work',purpose:'login',state:tx.state,browserBinding:'b'.repeat(64),code:'stable-subject'}),e=>(e as {code?:string}).code==='replayed');
  assert.equal(f.exchanges(),1); assert.equal(f.secrets.values.has(stored.secret_ref),false);
});
test('purpose/browser/provider mixups are rejected before token exchange',async t=>{
  const f=fixture(t); await configured(f); await configured(f,'other');
  const tx=await f.framework.begin({providerId:'work',purpose:'link',browserBinding:'b'.repeat(64),callbackUrl:'https://polyth.example/auth/callback',returnTo:'/settings'});
  for(const input of [
    {providerId:'work',purpose:'login' as const,browserBinding:'b'.repeat(64)},
    {providerId:'work',purpose:'link' as const,browserBinding:'c'.repeat(64)},
    {providerId:'other',purpose:'link' as const,browserBinding:'b'.repeat(64)},
  ]) await assert.rejects(f.framework.complete({...input,state:tx.state,code:'sub'}));
  assert.equal(f.exchanges(),0);
});
test('expiry and cancellation are deterministic and never call adapter',async t=>{
  const f=fixture(t); await configured(f);
  const expired=await f.framework.begin({providerId:'work',purpose:'login',browserBinding:'b'.repeat(64),callbackUrl:'https://polyth.example/cb',returnTo:'/'});
  f.advance(60_000); await assert.rejects(f.framework.complete({providerId:'work',purpose:'login',state:expired.state,browserBinding:'b'.repeat(64),code:'sub'}),e=>(e as {code?:string}).code==='expired');
  const live=await f.framework.begin({providerId:'work',purpose:'login',browserBinding:'b'.repeat(64),callbackUrl:'https://polyth.example/cb',returnTo:'/'});
  assert.equal(await f.framework.cancel({state:live.state,browserBinding:'b'.repeat(64)}),true);
  assert.equal(await f.framework.cancel({state:live.state,browserBinding:'b'.repeat(64)}),true);
  await assert.rejects(f.framework.complete({providerId:'work',purpose:'login',state:live.state,browserBinding:'b'.repeat(64),code:'sub'}),e=>(e as {code?:string}).code==='cancelled');
  assert.equal(f.exchanges(),0);
});
test('redirect target injection and unknown adapters are rejected',async t=>{
  const f=fixture(t); await assert.rejects(f.framework.configure({id:'x',kind:'missing',issuer:'https://issuer.example'}));
  await configured(f);
  await assert.rejects(f.framework.begin({providerId:'work',purpose:'login',browserBinding:'b'.repeat(64),callbackUrl:'https://polyth.example/cb',returnTo:'https://evil.example/'}));
  await assert.rejects(f.framework.begin({providerId:'work',purpose:'login',browserBinding:'b'.repeat(64),callbackUrl:'http://polyth.example/cb',returnTo:'/'}));
});
test('link uniqueness prevents takeover and never grants organization membership',async t=>{
  const f=fixture(t); await configured(f);
  const identity={issuer:'https://issuer.example',subject:'same'};
  f.framework.link('usr_a','work',identity);
  assert.equal(f.framework.resolveLinkedUser('work',identity),'usr_a');
  assert.throws(()=>f.framework.link('usr_b','work',identity),e=>(e as {code?:string}).code==='conflict');
  assert.equal(f.control.get('SELECT 1 FROM organization_memberships WHERE user_id=?','usr_a'),undefined);
});
test('an uncertain started exchange is fenced and never replayed',async t=>{
  const f=fixture(t); await configured(f);
  const tx=await f.framework.begin({providerId:'work',purpose:'login',browserBinding:'b'.repeat(64),callbackUrl:'https://polyth.example/cb',returnTo:'/'});
  f.control.transaction(()=>f.control.run('UPDATE provider_transactions SET exchange_started_at_ms=? WHERE id=?',1234,tx.id));
  await assert.rejects(f.framework.complete({providerId:'work',purpose:'login',state:tx.state,browserBinding:'b'.repeat(64),code:'sub'}),e=>(e as {code?:string}).code==='uncertain-exchange');
  assert.equal(f.exchanges(),0);
  assert.equal(await f.framework.cancel({state:tx.state,browserBinding:'b'.repeat(64)}),false);
});
test('same subject at a distinct canonical issuer is a distinct identity',async t=>{
  const f=fixture(t); await configured(f,'one');
  let two=await f.framework.configure({id:'two',kind:'fake',issuer:'https://other.example'});
  two=f.framework.setEnabled('two',two.revision,true);
  f.framework.link('usr_a','one',{issuer:'https://issuer.example',subject:'42'});
  f.framework.link('usr_b','two',{issuer:'https://other.example',subject:'42'});
  assert.equal(f.framework.resolveLinkedUser('two',{issuer:'https://other.example',subject:'42'}),'usr_b');
  assert.equal(two.enabled,true);
});
