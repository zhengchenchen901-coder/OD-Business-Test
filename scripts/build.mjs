import {readdirSync, mkdirSync, copyFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
for (const file of readdirSync('src').filter(f => f.endsWith('.js'))) {
  const check = spawnSync(process.execPath, ['--check', `src/${file}`], {stdio:'inherit'});
  if (check.status !== 0) process.exit(1);
  mkdirSync('dist', {recursive:true});
  copyFileSync(`src/${file}`, `dist/${file}`);
}
console.log('构建完成');
