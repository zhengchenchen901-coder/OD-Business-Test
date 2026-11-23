const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const cp=require('node:child_process');
const candidates=[process.env.OD_BUSINESS_NODE,process.execPath,path.join(os.homedir(),'.nvm/versions/node/v22.23.4/bin/node')].filter(Boolean);
const runtime=candidates.find(file=>{if(!fs.existsSync(file))return false;const r=cp.spawnSync(file,['-p','process.versions.node'],{encoding:'utf8'});return r.status===0&&/^22\.(1[89]|[2-9]\d)\./.test(r.stdout.trim());});
if(!runtime){console.error('需要Node 22.18以上的22.x运行时，可通过OD_BUSINESS_NODE指定');process.exit(1);}
const root=path.resolve(__dirname,'..');
const result=cp.spawnSync(runtime,[path.join(root,'src/cli.js'),...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
