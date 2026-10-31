import React from 'react';
import {createRoot} from 'react-dom/client';
import {CodeHostingProviderContext, ChangeRequestView, CodeHostingView} from '../../src/widgets/index.tsx';
import * as ui from '../../../../apps/web/src/components/ui/index.ts';
import '../../../../apps/web/src/styles.css';
import '../../widgets/styles.css';
import {MarkdownDoc} from '../../../../apps/web/src/markdown.tsx';
import {Icon} from '../../../../apps/web/src/icons.tsx';
import {tr as hostTr} from '../../../../apps/web/src/i18n/index.ts';
// This fixture stands in for a forge provider package. The shared surface renders
// provider-supplied wording, so the fixture carries its own strings instead of
// reading a removable package's catalog; shell keys fall back to the framework
// catalog.
const fallback=hostTr as unknown as (key:string, values?:Record<string,string|number>)=>string;
const providerText=(key:string, values?:Record<string,string|number>):string=>{
  const labels:Record<string,string>={'pullrequestview.overview':'Overview','pullrequestview.filesTab':'Files','pullrequestview.checksTab':'Pipeline','pullrequestview.commentsTab':'Comments','pullrequestview.pullRequests':'Merge requests','githubview.all':'All','githubview.open':'Open','githubview.closed':'Closed','githubview.merged':'Merged','githubview.ready':'Ready','githubview.drafts':'Drafts','githubview.searchValue':'Search {value}'};
  const template=labels[key] ?? fallback(key,values);
  return template.replace(/\{(\w+)\}/g,(match,name:string)=>values?.[name]===undefined?match:String(values[name]));
};
const snap={activeProjectId:'p1',activeSessionId:null,settings:{conflictAgentTarget:'new-session',conflictAgentPrompt:''}};
const host:any={ui:{components:{...ui,MarkdownDoc},icons:Icon,locale:{get:()=> 'en',translate:hostTr},syntax:{highlight:(x:string)=>x,languageForPath:()=>''}},store:{subscribe:()=>()=>{},getSnapshot:()=>snap},errors:{friendly:(x:string,e:unknown)=>`${x}: ${String(e)}`},conversation:{openSession:async()=>{},insert:()=>{},startNewSession:()=>{}},navigation:{}};

const gitlab={id:'gitlab',apiBase:'/api/gitlab',presentation:{serviceName:'GitLab',command:'glab',issueLabel:'Issue',issuePlural:'Issues',changeLabel:'Merge request',changePlural:'Merge requests',changeNumberPrefix:'!',icon:()=>null},t:providerText};
const github={...gitlab,id:'github',apiBase:'/api/github',presentation:{...gitlab.presentation,serviceName:'GitHub',changeLabel:'Pull request',changePlural:'Pull requests',changeNumberPrefix:'#'},t:providerText};
function App(){const [p,setP]=React.useState(gitlab);const [list,setList]=React.useState(false);return <main style={{containerType:"inline-size",containerName:"feature-panel"}}><button onClick={()=>setP(p.id==='gitlab'?github:gitlab)}>switch provider</button><button onClick={()=>setList(!list)}>browse</button><CodeHostingProviderContext host={host} provider={p}>{list ? <CodeHostingView renderDetail={()=>null}/> : <ChangeRequestView number={7} onClose={()=>{}}/>}</CodeHostingProviderContext></main>};createRoot(document.getElementById('root')!).render(<App/>);
