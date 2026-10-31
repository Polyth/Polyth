import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChangeRequestWatchEvent, ChangeRequestWatchLine} from '../../src/widgets/index.tsx';
import * as ui from '../../../../apps/web/src/components/ui/index.ts';
import '../../../../apps/web/src/styles.css';
import '../../widgets/styles.css';
import {Icon} from '../../../../apps/web/src/icons.tsx';
// A provider owns the watch's words; this fixture carries its own.
const labels:Record<string,string>={'prwatch.failed':'{count} failed','prwatch.running':'{count} running','prwatch.allPassed':'All checks passed','prwatch.noChecks':'Waiting for checks and reviews','prwatch.stop':'Stop','prwatch.stopLabel':'Stop watching {ref}','prwatch.lineLabel':'Watching {ref}: {state}','prwatch.held':'{count} held back','prwatch.heldTitle':'Held: {count}','prwatch.explain':'Explain','prwatch.wakes':'Woke the agent {count} of {max} times','prwatch.startedTitle':'Watching {ref}','prwatch.startedBody':'the agent wakes when a check fails or a reviewer comments','prwatch.wokeTitle':'{ref} woke the agent','prwatch.wokeFailed':'{names} failed','prwatch.wokeComments':'new comments: {count}','prwatch.failedChecks':'Failed checks','prwatch.newComments':'New comments','prwatch.open':'Open {ref}','prwatch.ended.merged':'{ref} merged — stopped watching','prwatch.stopFailed':'Could not stop: {reason}','prwatch.onCommit':'on {sha}'};
const t=(key:string,values?:Record<string,string|number>)=>(labels[key]??key).replace(/\{(\w+)\}/g,(m,name:string)=>values?.[name]===undefined?m:String(values[name]));
const host:any={ui:{components:ui,icons:Icon,locale:{get:()=>'en',translate:t}},sessions:{subscribeEvents:()=>()=>{}},errors:{show:(message:string)=>{document.body.dataset.error=message;}},navigation:{openWorkspacePane:(id:string)=>{document.body.dataset.opened=id;return true;}}};
const presentation={provider:'github',apiBase:'/api/github',abbreviation:'PR',numberPrefix:'#',surfaceId:'github',icon:()=>Icon.pullRequest?.()??null,t};
const ev=(id:string,data:Record<string,unknown>)=>({id,sessionId:'chat',seq:1,time:0,type:'github/pr-watch',data} as any);
function App(){return <div style={{display:'grid',gap:16,padding:12}}>
  <div className="timeline-fixture" style={{display:'grid',gap:8}}>
    <ChangeRequestWatchEvent presentation={presentation} event={ev('e1',{phase:'started',number:128,url:'https://github.com/o/r/pull/128'})}/>
    <ChangeRequestWatchEvent presentation={presentation} event={ev('e2',{phase:'woke',number:128,url:'https://github.com/o/r/pull/128',sha:'1a2b3c4',failedChecks:[{name:'test (ubuntu-latest)',url:'https://github.com/o/r/actions/runs/1/job/2'}],comments:[{author:'alice',kind:'inline',path:'src/auth/redirect-handler-with-a-long-name.ts',line:42,url:'javascript:alert(1)'}],commentCount:1,wake:1,maxWakes:8})}/>
    <ChangeRequestWatchEvent presentation={presentation} event={ev('e3',{phase:'ended',number:128,reason:'merged'})}/>
    <ChangeRequestWatchEvent presentation={presentation} event={ev('e4',{phase:'woke',number:0})}/>
  </div>
  <div className="conversation-composer-dock"><ChangeRequestWatchLine host={host} presentation={presentation} projectId="p1" sessionId="chat"/></div>
</div>}
createRoot(document.getElementById('root')!).render(<App/>);
