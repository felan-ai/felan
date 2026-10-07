import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario, drain } from './driver.mjs';
import { checkBusiness, checkMetadata } from '../../../../../cases/turn-classification/commerce/verifier/check.mjs';
const source={imageId:'sha256:test',source:{commit:'test'},digest:'test'};
function services(options = {}) {
  const seen={runtimes:[], classifierLookups:0,bind:[],prompts:[],contextMessages:[]}; let listener, thinking='high', observeContext;
  const session={isStreaming:false,get thinkingLevel(){return thinking;},model:{id:'gpt-6.1-sol'},
    setThinkingLevel(value){thinking=value;seen.manual=true;},
    async bindExtensions(options){seen.bind.push(options);},subscribe(fn){listener=fn;return()=>{};},dispose(){seen.disposed=true;},
    async prompt(text){seen.prompts.push(text);if(options.promptError)throw Error('Bearer private-token raw provider response');listener({type:'turn_start'});observeContext();if(options.toolError)listener({type:'message_end',message:{role:'toolResult',isError:true,toolName:'private-tool-name',content:[{type:'text',text:'raw tool error secret'}]}});listener({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'ok'}});
      listener({type:'message_end',message:{role:'assistant',stopReason:options.stopReason??'stop',content:[{type:'text',text:'secret transcript'}],usage:{input:4,output:2,cacheRead:1,cacheWrite:0}}});},
  };
  const core={HostAgentRuntime:class {constructor(cwd,options){Object.assign(this,options);seen.runtimes.push(options);}},
    SessionManager:{inMemory(){return {getSessionId:()=> 'root'};}},
    createPiClassifier(){seen.native=true;return {};},validateClassifierAnswers:(_q,a)=>a};
  const host={hasPendingWork:()=>false,getUsage:()=>({input:0,output:0,cacheRead:0,cacheWrite:0}),listLocalSubagents:()=>options.children??[]};
  const felan={builtinExtensionPackages:{codex:'@felan-ai/ext-codex',tasks:'@felan-ai/ext-tasks',prewalk:'@felan-ai/ext-prewalk',subagents:'@felan-ai/ext-subagents',memory:'@felan-ai/ext-memory'},
    async createLocalFelanRuntime(options) {
      seen.options=options;seen.settings=JSON.parse(await readFile(join(options.agentDir,'settings.json'),'utf8'));
      session.model=options.model;
      const handlers={};
      options.inlineExtensions[0].factory({on:(name,handler)=>{handlers[name]=handler;},getThinkingLevel:()=>thinking});
      observeContext=()=>handlers.context({messages:seen.contextMessages},{model:session.model,sessionManager:options.sessionManager});
      seen.observeContext=observeContext;
      seen.setModel=model=>{session.model=model;};
      seen.setThinking=value=>{thinking=value;};
      seen.runtime=options.runtimeFactory({cwd:options.cwd,classifier:{classify(){throw Error('must override');}}});
      return {session,localSubagentHost:host,async dispose(){seen.disposed=true;if(options.disposeError)throw Error('Bearer private-token disposal details');}};
    }};
  const modelRuntime={getModel:(provider,id)=>({provider,id}),async getAvailableOfType(type,provider){seen.classifierLookups++;assert.equal(type,'classifier');assert.equal(provider,'typesafe');return [{id:'jev-latest'}];}};
  return {core,felan,modelRuntime,seen};
}
test('persistent SDK RPC uses scoped models, default effort and no classifier for disabled arm',async () => {
  const workspace=await mkdtemp(join(tmpdir(),'turn-eval-'));
  try {
    await cp(new URL('../',import.meta.url),workspace,{recursive:true});const fake=services();
    const servicesFake=services();
    const result=await runScenario({...servicesFake,id:'recovery',mode:'disabled',modelId:'gpt-6.1-sol',workspace,source});
    const {seen}=servicesFake;
    assert.equal(seen.classifierLookups,0);assert.ok(seen.runtimes.every(r=>r.classifier===undefined));
    assert.equal(seen.settings.felanThinking.dynamic,true);assert.equal(seen.options.thinkingLevel,undefined);assert.equal(seen.settings.defaultThinkingLevel,'high');
    assert.deepEqual(seen.settings.enabledModels,['openai-codex/gpt-6.1-sol','openai-codex/gpt-6-luna']);assert.equal(seen.settings.builtinExtensions.memory,false);
    assert.deepEqual(seen.bind,[{mode:'rpc'}]); assert.equal(seen.prompts[0],'/prewalk'); assert.ok(seen.disposed);
    assert.equal(result.usage.combined.inputTokens,15);assert.equal(result.usage.combined.costUsd,null);assert.ok(result.timing.inputToFirstOutputMs>=0);
    checkMetadata(result,'recovery');
    assert.ok(result.phases.filter(row=>row.kind==='inference').every(row=>row.provider==='openai-codex' && row.phase===null));
    assert.ok(!(await readFile(join(workspace,'.eval-output/result.json'),'utf8')).includes('secret transcript'));
    const diagnostics=JSON.parse(await readFile(join(workspace,'.eval-output/diagnostics.json'),'utf8'));
    assert.equal(diagnostics.status,'completed');assert.ok(diagnostics.phases.some(row=>row.kind==='inference'));
    assert.ok(diagnostics.lifecycle.some(event=>event.stage==='session-prompt'&&event.outcome==='completed'));
    assert.deepEqual(diagnostics.childOutcomes,[]);
    assert.ok(!JSON.stringify(diagnostics).includes('secret transcript'));
    await assert.rejects(readFile(join(servicesFake.seen.options.agentDir,'settings.json'),'utf8'));
    await assert.rejects(checkBusiness(join(workspace,'project'),'recovery'));
    assert.equal(JSON.parse(await readFile(join(workspace,'.eval-output/diagnostics.json'),'utf8')).status,'completed');
  } finally {await rm(workspace,{recursive:true,force:true});}
});
test('runtime disposal failures are recorded without persisting exception text',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'turn-eval-'));
  try {
    await cp(new URL('../',import.meta.url),workspace,{recursive:true});const fake=services();
    const create=fake.felan.createLocalFelanRuntime;
    fake.felan.createLocalFelanRuntime=async options=>{
      const runtime=await create(options);
      return {...runtime,async dispose(){throw Error('private bearer-secret');}};
    };
    await runScenario({...fake,id:'routine',mode:'disabled',modelId:'gpt-6.1-sol',workspace,source});
    const diagnostics=JSON.parse(await readFile(join(workspace,'.eval-output/diagnostics.json'),'utf8'));
    assert.equal(diagnostics.status,'failed');
    assert.ok(diagnostics.failures.some(failure=>failure.category==='runtime-dispose-failed'));
    assert.ok(!JSON.stringify(diagnostics).includes('bearer-secret'));
    await assert.rejects(readFile(join(fake.seen.options.agentDir,'settings.json'),'utf8'));
  }finally{await rm(workspace,{recursive:true,force:true});}
});
test('driver setup errors retain only sanitized diagnostics and remove the private agent directory',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'turn-eval-'));
  try {
    await cp(new URL('../',import.meta.url),workspace,{recursive:true});const fake=services();
    fake.felan.createLocalFelanRuntime=async options=>{fake.seen.options=options;throw Error('Bearer private-token raw provider response');};
    await assert.rejects(runScenario({...fake,id:'routine',mode:'disabled',modelId:'gpt-6.1-sol',workspace,source}),/sanitized diagnostics/);
    const diagnostics=JSON.parse(await readFile(join(workspace,'.eval-output/diagnostics.json'),'utf8'));
    assert.deepEqual(diagnostics.failures,[{stage:'runtime-setup',category:'driver-operation-failed'}]);
    assert.equal(diagnostics.status,'failed');
    assert.ok(!JSON.stringify(diagnostics).includes('private-token'));
    assert.ok(!JSON.stringify(diagnostics).includes('raw provider response'));
    await assert.rejects(readFile(join(fake.seen.options.agentDir,'settings.json'),'utf8'));
  }finally{await rm(workspace,{recursive:true,force:true});}
});
test('assistant, child and prompt failures record safe categories without transcript or provider errors',async()=>{
  for (const [options,category] of [
    [{stopReason:'error'},'assistant-turn-failed'],
    [{children:[{status:'failed',error:'Bearer child-token raw provider detail'}]},'child-session-failed'],
    [{promptError:true},'assistant-turn-failed'],
  ]) {
    const workspace=await mkdtemp(join(tmpdir(),'turn-eval-'));
    try {
      await cp(new URL('../',import.meta.url),workspace,{recursive:true});const fake=services(options);
      const result=await runScenario({...fake,id:'routine',mode:'disabled',modelId:'gpt-6.1-sol',workspace,source});
      assert.equal(result.status,'failed');
      const diagnosticsText=await readFile(join(workspace,'.eval-output/diagnostics.json'),'utf8');
      const diagnostics=JSON.parse(diagnosticsText);
      assert.ok(diagnostics.failures.some(failure=>failure.category===category));
      assert.ok(diagnostics.lifecycle.some(event=>event.stage==='session-prompt'&&event.outcome==='failed'));
      if (category==='child-session-failed') assert.deepEqual(diagnostics.childOutcomes,[{status:'failed'}]);
      assert.ok(!diagnosticsText.includes('private-token'));
      assert.ok(!diagnosticsText.includes('child-token'));
      assert.ok(!diagnosticsText.includes('raw provider'));
      assert.ok(!diagnosticsText.includes('secret transcript'));
      await assert.rejects(readFile(join(fake.seen.options.agentDir,'settings.json'),'utf8'));
    } finally {await rm(workspace,{recursive:true,force:true});}
  }
});
test('tool errors record only a safe failure category and lifecycle stage',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'turn-eval-'));
  try {
    await cp(new URL('../',import.meta.url),workspace,{recursive:true});
    const toolFailure=services({toolError:true});
    const result=await runScenario({...toolFailure,id:'routine',mode:'disabled',modelId:'gpt-6.1-sol',workspace,source});
    assert.equal(result.status,'completed');
    const diagnosticsText=await readFile(join(workspace,'.eval-output/diagnostics.json'),'utf8');
    const diagnostics=JSON.parse(diagnosticsText);
    assert.ok(diagnostics.failures.some(failure=>failure.category==='tool-call-failed'));
    assert.ok(!diagnosticsText.includes('private-tool-name'));
    assert.ok(!diagnosticsText.includes('raw tool error'));
    assert.ok(!diagnosticsText.includes('secret'));
    assert.ok(toolFailure.seen.disposed);
  } finally {await rm(workspace,{recursive:true,force:true});}
});
test('inference context records the actual model and effort with the latest phase, not replayed historical labels',async () => {
  const workspace=await mkdtemp(join(tmpdir(),'turn-eval-'));
  try {
    await cp(new URL('../',import.meta.url),workspace,{recursive:true});const fake=services();
    const create=fake.felan.createLocalFelanRuntime;
    fake.felan.createLocalFelanRuntime=async options=>{
      const runtime=await create(options);
      const {seen}=fake;
      seen.contextMessages=[{role:'custom',customType:'pi-prewalk:planning'}];
      seen.observeContext();
      seen.setModel({provider:'openai-codex',id:'gpt-6-luna'});seen.setThinking('medium');
      seen.contextMessages.push({role:'custom',customType:'pi-prewalk:implementation'});
      return runtime;
    };
    const result=await runScenario({...fake,id:'implementation',mode:'disabled',modelId:'gpt-6.1-sol',workspace,source});
    const rows=result.phases.filter(row=>row.kind==='inference');
    assert.deepEqual(rows.map(({phase,provider,model,thinking})=>({phase,provider,model,thinking})),[
      {phase:'pi-prewalk:planning',provider:'openai-codex',model:'gpt-6.1-sol',thinking:'high'},
      {phase:'pi-prewalk:implementation',provider:'openai-codex',model:'gpt-6-luna',thinking:'medium'},
    ]);
    checkMetadata(result,'implementation');
  }finally{await rm(workspace,{recursive:true,force:true});}
});
test('enabled injection is explicit; tests never load the provider entrypoint',async () => {
  for (const mode of ['shared','separated']) {
    const workspace=await mkdtemp(join(tmpdir(),'turn-eval-'));
    try {await cp(new URL('../',import.meta.url),workspace,{recursive:true});const fake=services();
      await runScenario({...fake,id:'routine',mode,modelId:'gpt-6-luna',workspace,source});
      assert.equal(fake.seen.classifierLookups,1);assert.ok(fake.seen.runtimes[0].classifier);assert.ok(fake.seen.runtime.classifier);
    }finally{await rm(workspace,{recursive:true,force:true});}
  }
});
test('persistent drain waits for asynchronous child completion and resumed parent inference',async () => {
  let pending=true;const session={isStreaming:false};const host={hasPendingWork:()=>pending};
  const completion=setTimeout(()=>{session.isStreaming=true;pending=false;},5);
  const parent=setTimeout(()=>{session.isStreaming=false;},55);
  const started=performance.now();await drain(session,host);assert.ok(performance.now()-started>=50);
  clearTimeout(completion);clearTimeout(parent);
});
