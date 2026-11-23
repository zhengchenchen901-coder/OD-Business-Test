import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync, lstatSync} from 'node:fs';
import path from 'node:path';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export function atomicJson(file, value) {
  mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2)+'\n', {mode:0o600, flag:'wx'});
  renameSync(temp, file);
}
export function invariant(value, code) { if (!value) throw new Error(code); }
export function ownedFile(root, relative) {
  invariant(typeof relative === 'string' && !path.isAbsolute(relative), 'asset-path-relative-required');
  const base = realpathSync(root), file = path.resolve(base, relative);
  invariant(file.startsWith(base+path.sep), 'asset-path-outside-owner');
  let current = base;
  for (const part of path.relative(base, file).split(path.sep)) {
    current = path.join(current, part);
    invariant(!lstatSync(current).isSymbolicLink(), 'asset-symlink-refused');
  }
  invariant(lstatSync(file).isFile(), 'asset-file-required');
  return file;
}
export function loadCatalog(file) {
  const bytes = readFileSync(file), catalog = JSON.parse(bytes);
  invariant(Array.isArray(catalog.units) && catalog.units.length > 0, 'catalog-empty');
  const ids = new Set();
  for (const unit of catalog.units) {
    invariant(typeof unit.id === 'string' && /^[A-Z]+-\d+$/.test(unit.id) && !ids.has(unit.id), 'catalog-unit-id-invalid');
    ids.add(unit.id);
  }
  return {hash:sha(bytes), units:catalog.units};
}
export function loadConfig(file) {
  const c = readJson(file), dir = path.dirname(path.resolve(file));
  invariant(c.schemaVersion === 1 && c.environmentId === 'test-server', 'config-deployed-target-required');
  invariant(c.testflow && path.isAbsolute(c.testflow.command) && Array.isArray(c.testflow.args), 'config-testflow-command-invalid');
  invariant(c.testflow.args.every(a => typeof a === 'string') && path.isAbsolute(c.testflow.workspaceFile), 'config-testflow-path-required');
  invariant(c.projects && c.bindings && Array.isArray(c.bindings), 'config-projects-bindings-required');
  invariant(Number.isInteger(c.pollMs??1000)&&(c.pollMs??1000)>=100&&(c.pollMs??1000)<=30000,'poll-interval-invalid');
  invariant(Number.isInteger(c.maxWaitMs??300000)&&(c.maxWaitMs??300000)>=1000&&(c.maxWaitMs??300000)<=3600000,'wait-budget-invalid');
  return {...c, catalogFile:path.resolve(dir,c.catalogFile), stateRoot:path.resolve(dir,c.stateRoot), configFile:path.resolve(file)};
}
export function plan(config, catalog, selected) {
  const ids = selected?.length ? selected : catalog.units.map(u=>u.id);
  invariant(new Set(ids).size === ids.length, 'selection-duplicate');
  const units = new Map(catalog.units.map(u=>[u.id,u]));
  const nodes = [], gaps = [];
  const workspaceBytes=readFileSync(config.testflow.workspaceFile), workspace=JSON.parse(workspaceBytes);
  const target=workspace.environmentTargets?.find(t=>t.id==='test-server');
  if(!target)gaps.push({code:'remote-environment-missing'});
  for (const id of ids) {
    invariant(units.has(id), 'selection-unknown-unit');
    const bindings = config.bindings.filter(b=>b.unitId===id);
    if (!bindings.length) gaps.push({unitId:id, code:'case-binding-missing'});
    for (const b of bindings) {
      invariant(/^[A-Za-z0-9_-]{1,80}$/.test(b.caseId), 'case-id-invalid');
      invariant(['login-and-read','blackbox-mutation'].includes(b.authorization), 'authorization-unsupported');
      const project = config.projects[b.owner];
      invariant(project && path.isAbsolute(project.root), 'case-owner-invalid');
      if (!/^[a-f0-9]{40}$/.test(project.deployedSha || '')) gaps.push({unitId:id,caseId:b.caseId,code:'deployed-source-sha-missing'});
      if(!target?.versions?.some(v=>v.id===project.versionId&&v.expected===project.deployedSha))gaps.push({unitId:id,caseId:b.caseId,code:'source-deployment-contract-unmatched'});
      const file = ownedFile(project.root,b.assetsFile), bytes=readFileSync(file), hash=sha(bytes), asset=JSON.parse(bytes);
      invariant(hash===b.assetsHash, 'asset-hash-drift');
      invariant(asset.environmentId==='test-server' && asset.executor==='remote-http-v1', 'asset-executor-unsupported');
      invariant(asset.cases?.length===1 && asset.cases[0].id===b.caseId, 'one-case-per-node-required');
      invariant(!nodes.some(n=>n.id===b.caseId), 'case-id-duplicate');
      nodes.push({id:b.caseId,unitId:id,owner:b.owner,projectId:project.testflowProjectId,sourceSha:project.deployedSha,assetHash:hash,assetsFile:file,authorization:b.authorization,reviewedApprovalHash:b.reviewedApprovalHash??null,needs:b.needs??[],status:'planned'});
    }
  }
  const map=new Map(nodes.map(n=>[n.id,n])), seen=new Set(), active=new Set();
  function visit(id) {
    invariant(map.has(id),'dependency-not-selected'); if(seen.has(id))return;
    invariant(!active.has(id),'dependency-cycle');active.add(id);
    for(const d of map.get(id).needs)visit(d);
    active.delete(id);seen.add(id);
  }
  for(const n of nodes)visit(n.id);
  return {schemaVersion:1,id:randomUUID(),createdAt:new Date().toISOString(),catalogHash:catalog.hash,workspaceHash:sha(workspaceBytes),selectedUnits:ids,nodes:nodes.sort((a,b)=>[...seen].indexOf(a.id)-[...seen].indexOf(b.id)),gaps,status:gaps.length?'blocked':'planned',runnerLocation:'local',serviceEnvironment:'test-server',coverage:'unknown'};
}

export function verifyEvidence(e, node) {
  if(e.status==='failed')return 'failed';
  if(e.status!=='passed' || !Array.isArray(e.records) || e.records.length!==1)return 'unknown';
  const r=e.records[0];
  if(r.caseId!==node.id || r.jobId!==node.jobId || r.runId!==node.runId || r.bindingHash!==node.bindingHash || r.snapshotId!==node.snapshotId || r.environmentId!=='test-server')return 'unknown';
  if(r.channel!=='remote-http' || r.deployment!=='observed' || r.failure || r.status!=='passed' || !Array.isArray(r.checks) || !r.checks.length)return 'unknown';
  if(r.checks.some(c=>c.passed!==true))return 'failed';
  return 'passed';
}
