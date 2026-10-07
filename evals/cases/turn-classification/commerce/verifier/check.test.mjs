import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { checkMetadata, requiredPolicy, requiredProfiles } from './check.mjs';
import { policy, profiles } from '../../../../fixtures/turn-classification/v1/source/.eval-setup/scenarios.mjs';
const fixture=new URL('../../../../fixtures/turn-classification/v1/source/project/',import.meta.url);
function metadata(mode='shared',startingModel='gpt-6.1-sol') {
  return {schemaVersion:1,status:'completed',id:'implementation',mode,
    source:{imageId:'sha256:test',source:{commit:'test'},digest:'test'},fixture:{version:'v1',fileCount:30,digest:'a'.repeat(64)},
    config:{...structuredClone(policy),startingModel,mode,dynamicThinking:true,sessionMode:'rpc'},
    counts:{classifierProviderRequests:mode==='disabled'?0:1},classifierRequests:mode==='disabled'?[]:[{}],
    classifications:mode==='disabled'?[]:[{questionIds:['entry:decision']}],usage:{combined:{costUsd:null}},
    timing:{inputToFirstOutputMs:1},phases:[
      {scope:'root',kind:'pi-prewalk:planning'},
      {scope:'root',kind:'inference',phase:'pi-prewalk:planning',provider:'openai-codex',model:'gpt-6.1-sol',thinking:'high'},
      {scope:'root',kind:'pi-prewalk:implementation'},
      {scope:'root',kind:'inference',phase:'pi-prewalk:implementation',provider:'openai-codex',model:'gpt-6-luna',thinking:'medium'},
    ]};
}
test('portable verifier requirements match the authoritative versioned fixture policy and profiles',()=>{
  assert.deepEqual(requiredPolicy,policy);assert.deepEqual(requiredProfiles,profiles);
});
test('shared and separated arms accept pinned phase inference profiles for both starting models',()=>{
  for(const mode of ['shared','separated']) for(const model of policy.models) {
    const result=metadata(mode,model);checkMetadata(result,'implementation');
    result.phases[1].thinking='xhigh';checkMetadata(result,'implementation');
  }
});
test('disabled controls need not enter Prewalk, but observed Prewalk inference still honors phase policies',()=>{
  for(const model of policy.models) {
    const result=metadata('disabled',model);checkMetadata(result,'implementation');
    result.phases=[{scope:'root',kind:'inference',phase:null,provider:policy.provider,model,thinking:'high'}];
    checkMetadata(result,'implementation');
  }
  const result=metadata('disabled');result.phases[1].thinking='low';
  assert.throws(()=>checkMetadata(result,'implementation'),/high-effort floor/);
});
for(const [name,index,patch,error] of [
  ['incapable planning model',1,{model:'gpt-6-luna'},/pinned capable model/],
  ['low-effort planning',1,{thinking:'low'},/high-effort floor/],
  ['medium-effort planning',1,{thinking:'medium'},/high-effort floor/],
  ['wrong implementation model',3,{model:'gpt-6.1-sol'},/configured low target/],
  ['wrong implementation effort',3,{thinking:'high'},/configured effort/],
  ['unauthorized inference provider',1,{provider:'openrouter'},/authenticated scope/],
  ['out-of-scope inference model',1,{model:'gpt-unknown'},/pinned scope/],
]) test(`metadata rejects ${name} despite correct phase labels`,()=>{
  for(const mode of ['shared','separated']) {
    const result=metadata(mode);Object.assign(result.phases[index],patch);
    assert.throws(()=>checkMetadata(result,'implementation'),error);
  }
});
test('phase labels, selection recommendations and altered target metadata cannot replace inference evidence',()=>{
  for(const mode of ['shared','separated']) {
    const result=metadata(mode);result.phases=result.phases.filter(row=>row.kind!=='inference');
    result.selections=[{kind:'model',model:'gpt-6.1-sol'},{kind:'thinking',thinking:'high'}];
    assert.throws(()=>checkMetadata(result,'implementation'),/Missing root inference/);
    const unassociated=metadata(mode);for(const row of unassociated.phases.filter(row=>row.kind==='inference')) row.phase=null;
    assert.throws(()=>checkMetadata(unassociated,'implementation'),/Missing root planning inference/);
    const altered=metadata(mode);altered.config.prewalk.targetThinking='high';altered.phases[3].thinking='high';
    assert.throws(()=>checkMetadata(altered,'implementation'),/fixture requirements/);
  }
});
async function check(root,id) {
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import {checkBusiness} from ${JSON.stringify(new URL('./check.mjs',import.meta.url).href)};await checkBusiness(${JSON.stringify(root)},${JSON.stringify(id)});`],{encoding:'utf8'});
  return result.status===0;
}
async function verifyCase(root,id,result) {
  await writeFile(join(root,'.eval-output/result.json'),JSON.stringify(result));
  const run=spawnSync(process.execPath,[new URL('./verify.mjs',import.meta.url).pathname,id],{
    encoding:'utf8',env:{...process.env,TURN_CLASSIFICATION_WORKSPACE:root},
  });
  return {run,diagnostic:JSON.parse(await readFile(join(root,'.eval-output/verifier-diagnostics.json'),'utf8'))};
}
test('business verifier rejects original defects and accepts correct changes, including adversarial boundaries',async () => {
  const root=await mkdtemp(join(tmpdir(),'turn-verifier-'));
  try {
    await cp(fixture,root,{recursive:true});
    assert.equal(await check(root,'routine'),false);assert.equal(await check(root,'recovery'),false);assert.equal(await check(root,'implementation'),false);
    await writeFile(join(root,'billing/tax.mjs'),'export const tax=(c,r)=>Math.floor(c*r/10000+0.5);');
    assert.equal(await check(root,'routine'),true);
    await cp(fixture,root,{recursive:true});
    const fee=join(root,'shipping/fee.mjs');await writeFile(fee,(await readFile(fee,'utf8')).replace('subtotal > threshold','subtotal >= threshold'));
    assert.equal(await check(root,'recovery'),true);
    await writeFile(join(root,'billing/tax.mjs'),'export const tax=(c,r)=>Math.floor(c*r/10000+0.5);');
    await writeFile(join(root,'orders/quote.mjs'),`import {catalog} from '../inventory/catalog.mjs';import {available} from '../inventory/available.mjs';import {discount} from '../billing/discount.mjs';import {tax} from '../billing/tax.mjs';import {fee} from '../shipping/fee.mjs';export function quote({sku,quantity,country,vip}) { if (!Object.hasOwn(catalog,sku)||!Number.isInteger(quantity)||quantity<1||quantity>available(sku)) throw Error();const subtotal=catalog[sku].price*quantity;const d=discount(subtotal,vip);const t=tax(subtotal-d,1000);const shipping=fee(country,subtotal-d);return {subtotal,discount:d,tax:t,shipping,total:subtotal-d+t+shipping};}`);
    assert.equal(await check(root,'implementation'),true);
    checkMetadata(metadata(),'implementation');
    for(const [index,patch,error] of [
      [1,{model:'gpt-6-luna'},/pinned capable model/],
      [1,{thinking:'low'},/high-effort floor/],
      [3,{model:'gpt-6.1-sol'},/configured low target/],
      [3,{thinking:'high'},/configured effort/],
    ]) {
      const result=metadata();Object.assign(result.phases[index],patch);
      assert.equal(await check(root,'implementation'),true);
      assert.throws(()=>checkMetadata(result,'implementation'),error);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});
test('discovery requires all independent workflow facts',async () => {
  const root=await mkdtemp(join(tmpdir(),'turn-verifier-'));
  try {await cp(fixture,root,{recursive:true});const answer={tax105:10,vipDiscount1000:100,availableA:9,shippingUS:500,currency:'USD',eventName:'order-created'};
    await writeFile(join(root,'findings.json'),JSON.stringify(answer));assert.equal(await check(root,'discovery'),true);
    await writeFile(join(root,'findings.json'),JSON.stringify({...answer,availableA:12}));assert.equal(await check(root,'discovery'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('verifier writes precise sanitized metadata and business failures with an unchanged reward contract',async()=>{
  const root=await mkdtemp(join(tmpdir(),'turn-verify-'));
  try {
    await cp(fixture,join(root,'project'),{recursive:true});
    await mkdir(join(root,'.eval-output'),{recursive:true});
    const result=metadata('shared');result.id='implementation';result.phases[1].thinking='low';
    await writeFile(join(root,'.eval-output/result.json'),JSON.stringify(result));
    const run=spawnSync(process.execPath,[new URL('./verify.mjs',import.meta.url).pathname,'implementation'],{
      encoding:'utf8',env:{...process.env,TURN_CLASSIFICATION_WORKSPACE:root},
    });
    assert.equal(run.status,1);
    const diagnostic=JSON.parse(await readFile(join(root,'.eval-output/verifier-diagnostics.json'),'utf8'));
    assert.equal(diagnostic.status,'failed');
    assert.ok(diagnostic.failures.some(failure=>failure.category==='metadata'
      &&failure.assertion==='Planning inference is below the high-effort floor'
      &&failure.expected.includes('high')&&failure.actual==='low'));
    assert.ok(diagnostic.failures.some(failure=>failure.category==='business'
      &&failure.assertion==='business: tax rounding mismatch'
      &&failure.expected===1&&failure.actual===0));
    assert.deepEqual(JSON.parse(await readFile(join(root,'.harness-evals-reward.json'),'utf8')),{reward:0});
    assert.ok(!JSON.stringify(diagnostic).includes(root));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('verifier identities distinguish missing inference, quote, discovery and protected-file failures without leaking input',async()=>{
  const root=await mkdtemp(join(tmpdir(),'turn-verify-'));
  try {
    await cp(fixture,join(root,'project'),{recursive:true});await mkdir(join(root,'.eval-output'),{recursive:true});
    const missing=metadata();missing.phases=[];
    let result=await verifyCase(root,'implementation',missing);
    assert.equal(result.run.status,1);
    assert.ok(result.diagnostic.failures.some(failure=>failure.check==='inference.root.present'
      &&failure.category==='metadata'&&failure.expected===true&&failure.actual===false));

    const implementation=join(root,'project/orders/quote.mjs');
    await writeFile(join(root,'project/billing/tax.mjs'),'export const tax=(c,r)=>Math.floor(c*r/10000+0.5);');
    await writeFile(implementation,'export function quote(){return {subtotal:0,discount:0,tax:0,shipping:0,total:0};}');
    result=await verifyCase(root,'implementation',metadata());
    const quote=result.diagnostic.failures.find(failure=>failure.check==='business.order-quote');
    assert.equal(result.run.status,1);assert.equal(quote.category,'business');
    assert.equal(quote.expected.total,616);assert.equal(quote.actual.total,0);

    const discovery=metadata('disabled');discovery.id='discovery';discovery.phases=[
      {scope:'root',kind:'inference',phase:null,provider:'openai-codex',model:'gpt-6.1-sol',thinking:'high'},
    ];discovery.classifierRequests=[];discovery.classifications=[];
    await rm(join(root,'project'),{recursive:true,force:true});await cp(fixture,join(root,'project'),{recursive:true});
    await writeFile(join(root,'project/findings.json'),JSON.stringify({tax105:999,token:'Bearer secret /Users/private'}));
    result=await verifyCase(root,'discovery',discovery);
    const findings=result.diagnostic.failures.find(failure=>failure.check==='business.discovery-findings');
    assert.equal(result.run.status,1);assert.ok(findings?.actual,JSON.stringify(result.diagnostic));assert.equal(findings.actual.tax105,999);
    assert.ok(!JSON.stringify(result.diagnostic).includes('Bearer secret'));
    assert.ok(!JSON.stringify(result.diagnostic).includes('/Users/private'));
    assert.ok(!JSON.stringify(result.diagnostic).includes('token'));

    await writeFile(join(root,'project/inventory/catalog.mjs'),`${await readFile(join(root,'project/inventory/catalog.mjs'),'utf8')}\n// unexpected`);
    result=await verifyCase(root,'implementation',metadata());
    const file=result.diagnostic.failures.find(failure=>failure.check==='business.protected-file');
    assert.equal(result.run.status,1);assert.equal(file.expected,'unchanged');assert.equal(file.actual,'changed');
    assert.ok(!JSON.stringify(result.diagnostic).includes(root));
  } finally {await rm(root,{recursive:true,force:true});}
});
test('verifier distinguishes missing and invalid input while preserving pass/fail rewards',async()=>{
  const root=await mkdtemp(join(tmpdir(),'turn-verify-'));
  try {
    await cp(fixture,join(root,'project'),{recursive:true});await mkdir(join(root,'.eval-output'),{recursive:true});
    let run=spawnSync(process.execPath,[new URL('./verify.mjs',import.meta.url).pathname,'routine'],{encoding:'utf8',env:{...process.env,TURN_CLASSIFICATION_WORKSPACE:root}});
    let diagnostic=JSON.parse(await readFile(join(root,'.eval-output/verifier-diagnostics.json'),'utf8'));
    assert.equal(run.status,1);assert.deepEqual(diagnostic.failures,[{check:'result.artifact.present',category:'missing-artifact',assertion:'result.json is missing'}]);
    assert.deepEqual(JSON.parse(await readFile(join(root,'.harness-evals-reward.json'),'utf8')),{reward:0});

    await writeFile(join(root,'.eval-output/result.json'),'{ invalid json');
    run=spawnSync(process.execPath,[new URL('./verify.mjs',import.meta.url).pathname,'routine'],{encoding:'utf8',env:{...process.env,TURN_CLASSIFICATION_WORKSPACE:root}});
    diagnostic=JSON.parse(await readFile(join(root,'.eval-output/verifier-diagnostics.json'),'utf8'));
    assert.equal(run.status,1);assert.equal(diagnostic.failures[0].check,'result.artifact.valid');
    assert.equal(diagnostic.failures[0].category,'invalid-input');

    await writeFile(join(root,'project/billing/tax.mjs'),'export const tax=(c,r)=>Math.floor(c*r/10000+0.5);');
    const result=metadata();result.id='routine';
    run=(await verifyCase(root,'routine',result)).run;
    diagnostic=JSON.parse(await readFile(join(root,'.eval-output/verifier-diagnostics.json'),'utf8'));
    assert.equal(run.status,0);assert.deepEqual(diagnostic,{schemaVersion:1,status:'passed',failures:[]});
    assert.deepEqual(JSON.parse(await readFile(join(root,'.harness-evals-reward.json'),'utf8')),{reward:1});
  }finally{await rm(root,{recursive:true,force:true});}
});
