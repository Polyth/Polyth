import test from 'node:test';
import assert from 'node:assert/strict';
import { githubDeviceFlowConfigured, githubIdentityAdapter } from '../src/providers/github/index.ts';
import type { ProviderNetworkBroker, ProviderNetworkRequest, ProviderNetworkResponse } from '../src/providers/types.ts';

class Network implements ProviderNetworkBroker {
  requests: ProviderNetworkRequest[]=[];
  replies: ProviderNetworkResponse[]=[];
  async request(_providerId:string,_issuer:string,request:ProviderNetworkRequest){ this.requests.push(request); const r=this.replies.shift(); if(!r) throw new Error('offline'); return r; }
}
const base={
  providerId:'github-login',issuer:'https://github.com',purpose:'login' as const,
  publicConfig:{clientId:'Iv1_testclient123'},callbackUrl:'https://polyth.example/auth/github/callback',
  state:'a'.repeat(64),nonce:'b'.repeat(64),pkceChallenge:'c'.repeat(43),
};

test('web flow uses PKCE/state/account picker and requests no repository scope',async()=>{
  const result=await githubIdentityAdapter.begin(base);
  const url=new URL(result.authorizationUrl);
  assert.equal(url.origin,'https://github.com'); assert.equal(url.pathname,'/login/oauth/authorize');
  assert.equal(url.searchParams.get('state'),base.state); assert.equal(url.searchParams.get('code_challenge'),base.pkceChallenge);
  assert.equal(url.searchParams.get('code_challenge_method'),'S256'); assert.equal(url.searchParams.get('prompt'),'select_account');
  assert.equal(url.searchParams.has('scope'),false); assert.equal(result.authorizationUrl.includes('repo'),false);
});
test('exchange sends exact redirect + PKCE verifier and never omits confidential client secret',async()=>{
  const network=new Network(); network.replies.push({status:200,headers:{},body:JSON.stringify({access_token:'gho_'+'x'.repeat(32),token_type:'bearer',scope:''})});
  const token=await githubIdentityAdapter.exchange({...base,code:'temporary-code',pkceVerifier:'v'.repeat(64),clientSecret:'secret-value'},network);
  assert.equal(token.scope.length,0); const req=network.requests[0]!; const body=new URLSearchParams(req.body);
  assert.equal(req.url,'https://github.com/login/oauth/access_token'); assert.equal(body.get('redirect_uri'),base.callbackUrl); assert.equal(body.get('code_verifier'),'v'.repeat(64));
  assert.equal(body.get('client_secret'),'secret-value'); assert.equal(body.has('scope'),false);
  await assert.rejects(githubIdentityAdapter.exchange({...base,code:'x',pkceVerifier:'v'.repeat(64),clientSecret:null},network));
});
test('inherited code-hosting scopes are rejected rather than silently reused',async()=>{
  const network=new Network(); network.replies.push({status:200,headers:{},body:JSON.stringify({access_token:'gho_'+'x'.repeat(32),token_type:'bearer',scope:'repo,gist'})});
  await assert.rejects(githubIdentityAdapter.exchange({...base,code:'x',pkceVerifier:'v'.repeat(64),clientSecret:'secret'},network),e=>(e as {code?:string}).code==='provider-scope-escalation');
});
test('authenticated user numeric id is stable across rename and email absence',async()=>{
  for(const login of ['old-name','new-name']) {
    const network=new Network(); network.replies.push({status:200,headers:{},body:JSON.stringify({id:123456,login,name:null,email:null})});
    const identity=await githubIdentityAdapter.resolveIdentity({accessToken:'gho_'+'x'.repeat(32),scope:[]},network);
    assert.equal(identity.subject,'123456'); assert.equal(identity.displayName,login); assert.equal(identity.email,undefined);
    assert.equal(network.requests[0]!.url,'https://api.github.com/user');
  }
});
test('provider errors and unavailable GitHub produce safe errors without response contents',async()=>{
  const network=new Network(); network.replies.push({status:200,headers:{},body:JSON.stringify({error:'access_denied',error_description:'VERY SECRET'})});
  await assert.rejects(githubIdentityAdapter.exchange({...base,code:'x',pkceVerifier:'v'.repeat(64),clientSecret:'secret'},network),e=>{
    assert.equal((e as {code?:string}).code,'invalid-credentials'); assert.equal(String((e as Error).message).includes('VERY SECRET'),false); return true;
  });
  const offline=new Network(); await assert.rejects(githubIdentityAdapter.resolveIdentity({accessToken:'gho_'+'x'.repeat(32),scope:[]},offline),e=>(e as {code?:string}).code==='provider-unavailable');
});
test('GitHub.com issuer is exact and device flow is explicit configuration only',()=>{
  assert.equal(githubIdentityAdapter.canonicalizeIssuer('https://github.com/'),'https://github.com');
  assert.throws(()=>githubIdentityAdapter.canonicalizeIssuer('https://github.example.com'));
  assert.equal(githubDeviceFlowConfigured({clientId:'Iv1_testclient123'}),false);
  assert.equal(githubDeviceFlowConfigured({clientId:'Iv1_testclient123',deviceFlow:true}),true);
  assert.equal(githubIdentityAdapter.capabilities.device,false);
});
