import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { bitbucketIdentityAdapter } from '../src/providers/bitbucket/index.ts';
import type { ProviderNetworkBroker, ProviderNetworkRequest, ProviderNetworkResponse } from '../src/providers/types.ts';
class Network implements ProviderNetworkBroker { requests:ProviderNetworkRequest[]=[]; replies:ProviderNetworkResponse[]=[]; async request(_id:string,_issuer:string,r:ProviderNetworkRequest){this.requests.push(r);const x=this.replies.shift();if(!x)throw new Error('offline');return x;} }
const cfg={clientId:'consumer_12345678',registeredCallbackUrl:'https://polyth.example/auth/bitbucket/callback',declaredScopes:['account']};
const begin={providerId:'bitbucket',issuer:'https://bitbucket.org',purpose:'login' as const,publicConfig:cfg,callbackUrl:cfg.registeredCallbackUrl,state:'a'.repeat(64),nonce:'b'.repeat(64),pkceChallenge:'c'.repeat(43)};

test('authorization code uses exact consumer requirements without guessed PKCE/device fallback',async()=>{
 const result=await bitbucketIdentityAdapter.begin(begin), url=new URL(result.authorizationUrl);
 assert.equal(url.href.startsWith('https://bitbucket.org/site/oauth2/authorize?'),true); assert.equal(url.searchParams.get('client_id'),cfg.clientId); assert.equal(url.searchParams.get('response_type'),'code'); assert.equal(url.searchParams.get('state'),begin.state);
 assert.equal(url.searchParams.has('scope'),false); assert.equal(url.searchParams.has('code_challenge'),false); assert.equal(bitbucketIdentityAdapter.capabilities.device,false);
});
test('token exchange uses consumer key+secret Basic auth and no repository scope request',async()=>{
 const n=new Network(); n.replies.push({status:200,headers:{},body:JSON.stringify({access_token:'x'.repeat(32),token_type:'bearer',scopes:'account'})});
 await bitbucketIdentityAdapter.exchange({...begin,code:'temporary',pkceVerifier:'v'.repeat(64),clientSecret:'consumer-secret'},n);
 const req=n.requests[0]!, params=new URLSearchParams(req.body); assert.equal(req.url,'https://bitbucket.org/site/oauth2/access_token');
 assert.equal(req.headers!.authorization,`Basic ${Buffer.from(`${cfg.clientId}:consumer-secret`).toString('base64')}`); assert.equal(params.get('grant_type'),'authorization_code'); assert.equal(params.get('code'),'temporary'); assert.equal(params.has('scope'),false);
});
test('current-user UUID is stable subject, not display name',async()=>{
 for(const name of ['Old Name','Renamed User']) { const n=new Network(); n.replies.push({status:200,headers:{},body:JSON.stringify({type:'user',uuid:'{c788b2da-b7a2-404c-9e26-d3f077557007}',display_name:name})}); const id=await bitbucketIdentityAdapter.resolveIdentity({accessToken:'x'.repeat(32)},n); assert.equal(id.subject,'c788b2da-b7a2-404c-9e26-d3f077557007'); assert.equal(id.displayName,name); assert.equal(n.requests[0]!.url,'https://api.bitbucket.org/2.0/user'); }
});
test('wrong callback or consumer permissions fail before external exchange',async()=>{
 assert.throws(()=>bitbucketIdentityAdapter.begin({...begin,callbackUrl:'https://evil.example/cb'}),e=>(e as {code?:string}).code==='callback-mismatch');
 assert.throws(()=>bitbucketIdentityAdapter.begin({...begin,publicConfig:{...cfg,declaredScopes:['account','repository']}}),e=>(e as {code?:string}).code==='provider-scope-escalation');
 const n=new Network(); await assert.rejects(bitbucketIdentityAdapter.exchange({...begin,code:'x',pkceVerifier:'v'.repeat(64),clientSecret:null},n)); assert.equal(n.requests.length,0);
});
test('missing or non-user account profile cannot authenticate',async()=>{
 for(const body of [{type:'user',display_name:'No UUID'},{type:'workspace',uuid:'{c788b2da-b7a2-404c-9e26-d3f077557007}',display_name:'Wrong Type'},{type:'user',uuid:'not-a-uuid',display_name:'Bad'}]) { const n=new Network(); n.replies.push({status:200,headers:{},body:JSON.stringify(body)}); await assert.rejects(bitbucketIdentityAdapter.resolveIdentity({accessToken:'x'.repeat(32)},n),e=>(e as {code?:string}).code==='invalid-provider-response'); }
});
test('returned code-hosting scopes are rejected instead of reused for login',async()=>{
 const n=new Network(); n.replies.push({status:200,headers:{},body:JSON.stringify({access_token:'x'.repeat(32),token_type:'bearer',scopes:'account repository'})});
 await assert.rejects(bitbucketIdentityAdapter.exchange({...begin,code:'x',pkceVerifier:'v'.repeat(64),clientSecret:'secret'},n),e=>(e as {code?:string}).code==='provider-scope-escalation');
});
test('Bitbucket Cloud issuer is exact; Data Center is not silently treated as supported',()=>{
 assert.equal(bitbucketIdentityAdapter.canonicalizeIssuer('https://bitbucket.org/'),'https://bitbucket.org');
 assert.throws(()=>bitbucketIdentityAdapter.canonicalizeIssuer('https://bitbucket.example.com'));
 assert.equal(bitbucketIdentityAdapter.capabilities.discovery,false); assert.equal(bitbucketIdentityAdapter.capabilities.device,false);
});
