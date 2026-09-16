import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitLabIdentityAdapter, type GitLabOidcVerifier } from '../src/providers/gitlab/index.ts';
import type { ProviderNetworkBroker, ProviderNetworkRequest, ProviderNetworkResponse } from '../src/providers/types.ts';

class Network implements ProviderNetworkBroker {
  requests: Array<{issuer:string; request:ProviderNetworkRequest}>=[];
  replies: ProviderNetworkResponse[]=[];
  async request(_providerId:string,issuer:string,request:ProviderNetworkRequest){ this.requests.push({issuer,request}); const r=this.replies.shift(); if(!r) throw new Error('offline'); return r; }
}
class Oidc implements GitLabOidcVerifier {
  calls:any[]=[]; fail:Error|null=null;
  async verify(input:any){ this.calls.push(input); if(this.fail) throw this.fail; return {issuer:input.expectedIssuer,subject:'123',displayName:'OIDC User'}; }
}
const input=(issuer='https://gitlab.example/gitlab')=>({providerId:'corp',issuer,purpose:'login' as const,publicConfig:{clientId:'client_12345678',privateNetworkApproved:false,testedVersion:'19.3'},callbackUrl:'https://polyth.example/cb',state:'a'.repeat(64),nonce:'b'.repeat(64),pkceChallenge:'c'.repeat(43)});

test('self-managed issuer path is preserved through authorize and token endpoints',async()=>{
 const oidc=new Oidc(), adapter=createGitLabIdentityAdapter(oidc);
 const started=await adapter.begin(input()); const u=new URL(started.authorizationUrl);
 assert.equal(u.pathname,'/gitlab/oauth/authorize'); assert.equal(u.searchParams.get('scope'),'openid profile'); assert.equal(u.searchParams.get('code_challenge_method'),'S256'); assert.equal(u.searchParams.get('nonce'),'b'.repeat(64));
 const n=new Network(); n.replies.push({status:200,headers:{},body:JSON.stringify({access_token:'x'.repeat(32),id_token:'y'.repeat(64),token_type:'Bearer',scope:'openid profile'})});
 await adapter.exchange({...input(),code:'code',pkceVerifier:'v'.repeat(64),clientSecret:'secret'},n);
 assert.equal(n.requests[0]!.request.url,'https://gitlab.example/gitlab/oauth/token'); assert.equal(n.requests[0]!.issuer,'https://gitlab.example/gitlab');
});
test('verified OIDC subject must match userinfo and same sub on two issuers stays distinct',async()=>{
 for(const host of ['one.example','two.example']) {
  const issuer=`https://${host}`, oidc=new Oidc(), adapter=createGitLabIdentityAdapter(oidc), n=new Network();
  n.replies.push({status:200,headers:{},body:JSON.stringify({sub:'123',name:'Same Human',email:'same@example.com',email_verified:true})});
  const identity=await adapter.resolveIdentity({issuer,accessToken:'x'.repeat(32),idToken:'y'.repeat(64),nonce:'b'.repeat(64),clientId:'client_12345678',privateNetworkApproved:false},n);
  assert.equal(identity.issuer,issuer); assert.equal(identity.subject,'123'); assert.equal(oidc.calls[0].discoveryUrl,`${issuer}/.well-known/openid-configuration`);
 }
});
test('issuer and userinfo mismatches fail closed',async()=>{
 const oidc=new Oidc(), adapter=createGitLabIdentityAdapter(oidc);
 oidc.verify=async input=>({issuer:`${input.expectedIssuer}/wrong`,subject:'123',displayName:'OIDC User'});
 const wrongIssuer=new Network();
 await assert.rejects(adapter.resolveIdentity({issuer:'https://gitlab.example',accessToken:'x'.repeat(32),idToken:'y'.repeat(64),nonce:'b'.repeat(64),clientId:'client_12345678',privateNetworkApproved:false},wrongIssuer),e=>(e as {code?:string}).code==='invalid-identity');
 oidc.verify=async input=>({issuer:input.expectedIssuer,subject:'123',displayName:'OIDC User'});
 const n=new Network(); n.replies.push({status:200,headers:{},body:JSON.stringify({sub:'999'})});
 await assert.rejects(adapter.resolveIdentity({issuer:'https://gitlab.example',accessToken:'x'.repeat(32),idToken:'y'.repeat(64),nonce:'b'.repeat(64),clientId:'client_12345678',privateNetworkApproved:false},n),e=>(e as {code?:string}).code==='invalid-identity');
});
test('malformed JWKS or ID-token validation never falls back to userinfo-only identity',async()=>{
 const oidc=new Oidc(); oidc.fail=Object.assign(new Error('bad jwks'),{code:'invalid-jwks'});
 const adapter=createGitLabIdentityAdapter(oidc), n=new Network();
 n.replies.push({status:200,headers:{},body:JSON.stringify({sub:'123'})});
 await assert.rejects(adapter.resolveIdentity({issuer:'https://gitlab.example',accessToken:'x'.repeat(32),idToken:'y'.repeat(64),nonce:'b'.repeat(64),clientId:'client_12345678',privateNetworkApproved:false},n),e=>(e as {code?:string}).code==='invalid-jwks');
 assert.equal(n.requests.length,0);
});
test('private literal issuers need explicit administrator approval and broker remains authority',async()=>{
 const oidc=new Oidc(), adapter=createGitLabIdentityAdapter(oidc);
 assert.throws(()=>adapter.begin(input('https://10.0.0.8/gitlab')),e=>(e as {code?:string}).code==='private-network-approval-required');
 const approved={...input('https://10.0.0.8/gitlab'),publicConfig:{...input().publicConfig,privateNetworkApproved:true}};
 assert.match((await adapter.begin(approved)).authorizationUrl,/10\.0\.0\.8/);
});
test('API/repository scopes are separate from identity and are rejected if inherited',async()=>{
 const oidc=new Oidc(), adapter=createGitLabIdentityAdapter(oidc), n=new Network();
 n.replies.push({status:200,headers:{},body:JSON.stringify({access_token:'x'.repeat(32),id_token:'y'.repeat(64),token_type:'bearer',scope:'openid profile api'})});
 await assert.rejects(adapter.exchange({...input('https://gitlab.example'),code:'code',pkceVerifier:'v'.repeat(64),clientSecret:'secret'},n),e=>(e as {code?:string}).code==='provider-scope-escalation');
});
test('tested support evidence is explicit and currently records GitLab 19.3 fixtures',async()=>{
 const oidc=new Oidc(), adapter=createGitLabIdentityAdapter(oidc);
 assert.throws(()=>adapter.begin({...input('https://gitlab.com'),publicConfig:{clientId:'client_12345678'}}));
 const started=await adapter.begin({...input('https://gitlab.com'),publicConfig:{clientId:'client_12345678',testedVersion:'19.3'}});
 assert.match(started.authorizationUrl,/gitlab\.com/);
});
