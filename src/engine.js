import {readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,sha,invariant,verifyEvidence} from './core.js';

export class Engine {
  constructor(config,tf){this.config=config;this.tf=tf;this.owner=randomUUID();this.busy=false;}
  save(c){atomicJson(path.join(this.config.stateRoot,'campaigns',`${c.id}.json`),c);}
  async execute(c) {
    invariant(!this.busy,'coordinator-busy');invariant(c.status==='planned','campaign-not-dispatchable');
    invariant(sha(readFileSync(this.config.testflow.workspaceFile))===c.workspaceHash,'workspace-config-drift');
    this.busy=true;
    mkdirSync(this.config.stateRoot,{recursive:true,mode:0o700});
    const lock=path.join(this.config.stateRoot,'dispatch.lock');
    try {writeFileSync(lock,this.owner,{flag:'wx',mode:0o600});} catch {this.busy=false;throw Error('coordinator-lease-exists');}
    c.owner=this.owner;c.status='running';this.save(c);
    const flowIds=[];
    try {
      const diagnostic=await this.tf.call('remote_doctor',{environmentId:'test-server'});
      if(!['needs-prepare','ready'].includes(diagnostic.status)){c.status='blocked';c.gaps.push({code:diagnostic.code??'remote-environment-not-ready'});return c;}
      const task=await this.tf.call('task',{action:'start',taskName:`business-${c.id}`});
      invariant(task.flowId,'task-flow-id-required');c.flowId=task.flowId;flowIds.push(task.flowId);this.save(c);
      for(const node of c.nodes) {
        if(node.needs.some(id=>c.nodes.find(n=>n.id===id)?.status!=='passed')){node.status='blocked';continue;}
        try {
          // 派发前重新核验项目忽略资产；按内容寻址暂存到TestFlow私有资产区。
          const bytes=readFileSync(node.assetsFile);invariant(sha(bytes)===node.assetHash,'asset-hash-drift');
          const dir=path.join(path.dirname(this.config.testflow.workspaceFile),'.testflow','project-assets','od-business-test',node.assetHash);
          mkdirSync(dir,{recursive:true,mode:0o700});const staged=path.join(dir,'asset.json');
          if(existsSync(staged))invariant(sha(readFileSync(staged))===node.assetHash,'staged-asset-drift');
          else writeFileSync(staged,bytes,{mode:0o600,flag:'wx'});
          const frozen=await this.tf.call('freeze',{flowId:c.flowId,projectId:node.projectId,selection:{mode:'range',base:node.sourceSha,target:node.sourceSha}});
          invariant(frozen.snapshotId,'snapshot-id-required');node.snapshotId=frozen.snapshotId;
          const prepared=await this.tf.call('prepare_remote',{projectId:node.projectId,snapshotId:node.snapshotId,assetsFile:staged,assetsHash:node.assetHash,environmentId:'test-server'});
          if(prepared.flowId&&!flowIds.includes(prepared.flowId))flowIds.push(prepared.flowId);
          invariant(prepared.status==='ready' && prepared.deployment==='observed' && prepared.executor==='remote-http-v1','remote-prepare-not-verified');
          invariant(prepared.runId && prepared.bindingHash,'prepared-binding-required');
          node.runId=prepared.runId;node.bindingHash=prepared.bindingHash;
          node.requiredApprovalHash=prepared.approvalBindingHash??null;
          if(node.authorization==='blackbox-mutation')invariant(node.reviewedApprovalHash && node.reviewedApprovalHash===prepared.approvalBindingHash,'write-approval-binding-required');
          node.status='dispatching';this.save(c);
          // execute不会自动重试；请求响应丢失时保留dispatching，恢复仅核查。
          const started=await this.tf.call('execute_remote',{runId:node.runId,authorization:node.authorization,...(node.authorization==='blackbox-mutation'?{approvalBindingHash:node.reviewedApprovalHash}:{})});
          invariant(started.jobId,'dispatch-job-id-unknown');if(started.flowId&&!flowIds.includes(started.flowId))flowIds.push(started.flowId);node.jobId=started.jobId;node.status='running';this.save(c);
          const deadline=Date.now()+(this.config.maxWaitMs??300000);
          while(true) {
            const state=await this.tf.call('status',{jobId:node.jobId});
            if(['passed','failed','blocked','cancelled'].includes(state.status))break;
            if(!['queued','running'].includes(state.status)||Date.now()>deadline){node.status='outcome-unknown';break;}
            await new Promise(r=>setTimeout(r,this.config.pollMs??1000));
          }
          if(node.status!=='outcome-unknown')node.status=verifyEvidence(await this.tf.call('evidence',{jobId:node.jobId}),node);
        } catch(error) {
          node.status=['dispatching','running'].includes(node.status)?'outcome-unknown':'blocked';
          node.gap=/^[a-z0-9:-]{1,160}$/.test(error.message)?error.message:'adapter-error-details-withheld';
        }
        this.save(c);
        if(['outcome-unknown','unknown'].includes(node.status))break;
      }
      c.status=c.nodes.some(n=>['outcome-unknown','unknown'].includes(n.status))?'outcome-unknown':c.nodes.some(n=>n.status==='failed')?'failed':c.nodes.length&&c.nodes.every(n=>n.status==='passed')?'passed':'blocked';
      if(c.status!=='outcome-unknown') {
        const finished=await this.tf.call('task',{action:'finish',flowIds,result:c.status==='passed'?'passed':c.status==='failed'?'failed':'cancelled',summary:`business campaign ${c.id}: ${c.status}; source coverage unknown`});
        c.cleanup=finished.completion?.cleanup??'pending';
        for(let i=0;c.cleanup!=='completed'&&i<3;i++) {
          const t=await this.tf.call('task',{action:'status',flowIds});c.cleanup=t.completion?.cleanup??'pending';
        }
      } else c.cleanup='retained-unfinished';
      return c;
    } catch(error) {
      c.status='outcome-unknown';c.cleanup='requires-original-owner-reconciliation';c.gaps.push({code:'testflow-lifecycle-unresolved'});return c;
    } finally {
      this.save(c);this.busy=false;unlinkSync(lock);
    }
  }
}
