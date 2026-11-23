import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,existsSync,writeFileSync,mkdirSync,unlinkSync,readdirSync} from 'node:fs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {loadConfig,loadCatalog,plan,readJson,invariant} from './core.js';
import {TestFlow} from './testflow.js';
import {Engine} from './engine.js';

function summary(c){return {id:c.id,status:c.status,runnerLocation:c.runnerLocation,serviceEnvironment:c.serviceEnvironment,selectedUnits:c.selectedUnits.length,counts:c.nodes.reduce((r,n)=>(r[n.status]=(r[n.status]??0)+1,r),{}),nodes:c.nodes.map(n=>({unitId:n.unitId,caseId:n.id,status:n.status,jobId:n.jobId??null,runId:n.runId??null,requiredApprovalHash:n.requiredApprovalHash??null,gap:n.gap??null})),gaps:c.gaps,coverage:'unknown',cleanup:c.cleanup??'not-started'};}
function campaign(config,id){invariant(/^[a-f0-9-]{36}$/.test(id),'campaign-id-invalid');return readJson(path.join(config.stateRoot,'campaigns',`${id}.json`));}
async function serve(config){
  const tf=await TestFlow.connect(config.testflow),engine=new Engine(config,tf);
  mkdirSync(config.stateRoot,{recursive:true,mode:0o700});
  const hostFile=path.join(config.stateRoot,'host.json');
  invariant(!existsSync(hostFile),'existing-host-requires-reconciliation');
  const token=randomUUID()+randomUUID();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
    try{
      const auth=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${token}`);
      invariant(auth.length===expected.length&&timingSafeEqual(auth,expected),'host-auth-rejected');
      invariant(req.method==='POST','host-post-required');
      let body='';for await(const part of req){body+=part;invariant(Buffer.byteLength(body)<65536,'host-request-too-large');}
      const input=JSON.parse(body),c=campaign(config,input.id);
      if(req.url==='/run'){
        invariant(!engine.busy,'coordinator-busy');
        for(const f of readdirSync(path.join(config.stateRoot,'campaigns'))){const other=readJson(path.join(config.stateRoot,'campaigns',f));invariant(!['running','outcome-unknown'].includes(other.status),'unfinished-campaign-requires-observation');}
        const fresh=plan(config,loadCatalog(config.catalogFile),c.selectedUnits);
        invariant(fresh.catalogHash===c.catalogHash&&fresh.workspaceHash===c.workspaceHash&&!fresh.gaps.length&&JSON.stringify(fresh.nodes)===JSON.stringify(c.nodes),'plan-input-drift');
        invariant(c.status==='planned'&&!c.gaps.length,'campaign-not-dispatchable');
        void engine.execute(c).catch(()=>{c.status='outcome-unknown';c.gaps.push({code:'dispatch-outcome-unknown'});engine.save(c);});
        res.statusCode=202;res.end(JSON.stringify(summary(c)));return;
      }
      invariant(req.url==='/observe','host-route-unsupported');
      invariant(!engine.busy,'coordinator-busy');
      for(const n of c.nodes.filter(n=>n.jobId&&['running','unknown','outcome-unknown'].includes(n.status))){
        const {verifyEvidence}=await import('./core.js');
        n.status=verifyEvidence(await tf.call('evidence',{jobId:n.jobId}),n);
      }
      // 新owner仅观察；不代替原MCP身份结束任务或重放未知派发。
      c.observationOnly=true;engine.save(c);res.end(JSON.stringify(summary(c)));
    }catch(error){res.statusCode=409;res.end(JSON.stringify({error:/^[a-z0-9:-]{1,160}$/.test(error.message)?error.message:'operation-failed-details-withheld'}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  writeFileSync(hostFile,JSON.stringify({port:server.address().port,token,pid:process.pid}),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:'serving',pid:process.pid,host:'127.0.0.1',scope:'single-controller; keep this process alive for task ownership'}));
  async function stop(){
    if(engine.busy){console.error('任务仍在运行，先观察并等待阶段结束');return;}
    server.close();if(readJson(hostFile).token===token)unlinkSync(hostFile);await tf.close();
  }
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
export async function main(args){
  const command=args[0]??'help',pos=args.indexOf('--config');
  if(command==='help'){console.log('catalog | plan [--units ID,ID] | doctor | serve | run ID | observe ID | status ID | report ID --config <本机配置>');return;}
  invariant(pos>0&&args[pos+1],'config-required');const config=loadConfig(args[pos+1]);
  if(command==='catalog'){const c=loadCatalog(config.catalogFile);console.log(JSON.stringify({count:c.units.length,hash:c.hash,units:c.units.map(u=>({id:u.id,title:u.title,domain:u.domain}))},null,2));return;}
  if(command==='plan'){
    const i=args.indexOf('--units'),selection=i>0?args[i+1]?.split(','):undefined;
    const c=plan(config,loadCatalog(config.catalogFile),selection);new Engine(config,null).save(c);console.log(JSON.stringify(summary(c),null,2));return;
  }
  if(command==='doctor'){
    const tf=await TestFlow.connect(config.testflow);
    try{const d=await tf.call('doctor',{identityDetail:true}),r=await tf.call('remote_doctor',{environmentId:'test-server'});console.log(JSON.stringify({kind:'diagnostic-only',runtimeIdentity:{codeHash:d.runtimeIdentity?.codeHash,buildId:d.runtimeIdentity?.buildId},pluginStatus:d.status,remoteStatus:r.status,remoteCode:r.code??null,businessActions:0},null,2));}finally{await tf.close();}return;
  }
  if(command==='serve'){await serve(config);return;}
  const id=args[1];
  if(['status','report'].includes(command)){console.log(JSON.stringify(summary(campaign(config,id)),null,2));return;}
  invariant(['run','observe'].includes(command),'command-unsupported');
  const host=readJson(path.join(config.stateRoot,'host.json'));
  const response=await fetch(`http://127.0.0.1:${host.port}/${command}`,{method:'POST',headers:{authorization:`Bearer ${host.token}`,'content-type':'application/json'},body:JSON.stringify({id}),signal:AbortSignal.timeout(30000)});
  const data=await response.json();console.log(JSON.stringify(data,null,2));if(!response.ok)process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({error:/^[a-z0-9:-]{1,160}$/.test(error.message)?error.message:'command-failed-details-withheld'}));process.exitCode=1;});
