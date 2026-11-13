// Temporary Windows platform probe for the native Windows daemon work. Delete before merge.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'fwp-'));
const children = {
  socket: `const s=new (require('net').Socket)({fd:3,readable:true,writable:true});s.on('error',e=>{console.error('socket error',e.code,e.message);process.exit(5)});s.write('ready');s.once('data',b=>{s.end();process.exit(b[0]===1?0:3)});setTimeout(()=>{console.error('child timeout');process.exit(4)},8000)`,
  socketReadOnly: `const s=new (require('net').Socket)({fd:3,readable:true,writable:true});s.on('error',e=>{console.error('socket error',e.code,e.message);process.exit(5)});s.once('data',b=>{console.error('got',b[0]);process.exit(b[0]===1?0:3)});setTimeout(()=>{console.error('child timeout');process.exit(4)},8000)`,
  fsWrite: `const fs=require('fs');try{fs.writeSync(3,'ready')}catch(e){console.error('write error',e.code,e.message);process.exit(5)}const b=Buffer.alloc(1);try{fs.readSync(3,b,0,1,null)}catch(e){console.error('read error',e.code,e.message);process.exit(6)}process.exit(b[0]===1?0:3)`,
  guess: `const {guessHandleType}=require('util');console.error('type', process.binding?undefined:undefined);try{console.error('guess',require('net').Socket&&require('tty').isatty(3), typeof require('fs').fstatSync(3).size)}catch(e){console.error('fstat',e.code)};process.exit(0)`,
};
for (const [name, code] of Object.entries(children)) writeFileSync(join(root, `${name}.cjs`), code);

async function attempt(child, detached, kind) {
  const proc = spawn(process.execPath, [join(root, `${child}.cjs`)], { detached, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', kind] });
  let stderr = ''; proc.stderr.on('data', d => { stderr += d; });
  const channel = proc.stdio[3];
  channel.on('error', e => { stderr += `parent channel error ${e.code}`; });
  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => resolve('parent timeout'), 10000);
    channel.once('data', d => { channel.write(Buffer.from([1])); stderr += `parent got ${JSON.stringify(d.toString())}; `; });
    if (child === 'socketReadOnly') channel.write(Buffer.from([1]));
    proc.once('exit', code => { clearTimeout(timer); resolve(`exit ${code}`); });
  });
  if (outcome === 'parent timeout') proc.kill();
  return { outcome, stderr: stderr.trim() };
}

const results = {};
for (const child of ['socket', 'socketReadOnly', 'fsWrite', 'guess'])
  for (const detached of [true, false])
    for (const kind of ['pipe', 'overlapped'])
      results[`${child}/${detached ? 'detached' : 'attached'}/${kind}`] = await attempt(child, detached, kind);
rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
