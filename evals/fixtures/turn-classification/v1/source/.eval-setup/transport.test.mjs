import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport, measureNativeRuntime, mergeMetadata, sumKnown } from './transport.mjs';
const q = { type:'bool',instructions:'judge',criteria:{true:'yes',false:'no'} };
const validate = (questions, answers) => { assert.deepEqual(Object.keys(questions).sort(),Object.keys(answers).sort()); for (const answer of Object.values(answers)) assert.equal(answer.type,'bool'); return answers; };
test('separated transport preserves identical state, question IDs and questions and runs concurrently', async () => {
  const state = { request:'task',extensions:{thinking:{},prewalk:{},subagents:{}} };
  const questions = { 'thinking:effort':q,'prewalk:entry':q,'subagents:discovery':q };
  let active = 0, peak = 0;
  const rows = [];
  const native = { async classify(s, qs, signal) {
    assert.equal(s,state); assert.equal(signal,controller.signal); active++; peak = Math.max(peak,active);
    await new Promise(resolve => setTimeout(resolve,5)); active--;
    for (const [id,question] of Object.entries(qs)) assert.equal(question,questions[id]);
    return { answers:Object.fromEntries(Object.keys(qs).map(id => [id,{type:'bool',probability:0.5}])),metadata:{usage:{requests:2,inputTokens:4,outputTokens:1}} };
  } };
  const controller = new AbortController();
  const result = await createTransport(native,'separated',validate,rows).classify(state,questions,controller.signal);
  assert.equal(peak,3); assert.equal(result.metadata.usage.requests,6); assert.equal(result.metadata.usage.costUsd,undefined);
  assert.equal(rows[0].nativeInvocations,3); assert.equal(rows[0].questionCount,3);
  const sharedRows = [];
  await createTransport(native,'shared',validate,sharedRows).classify(state,questions,controller.signal);
  assert.equal(sharedRows[0].stateDigest,rows[0].stateDigest); assert.equal(sharedRows[0].questionsDigest,rows[0].questionsDigest);
  assert.equal(sharedRows[0].nativeInvocations,1);
});
test('unnamespaced later calls pass through untouched and malformed answers fail closed',async () => {
  const state = {}, questions = {handoff:q,completion:q}; let calls=0;
  const native={async classify(s,qs){calls++;assert.equal(s,state);assert.deepEqual(qs,questions);return {answers:{handoff:{type:'bool'},completion:{type:'bool'}}};}};
  await createTransport(native,'separated',validate,[]).classify(state,questions); assert.equal(calls,1);
  const rows=[];
  await assert.rejects(createTransport({async classify(){return {answers:{}};}},'shared',validate,rows).classify(state,questions));
  assert.equal(rows[0].status,'failed'); assert.equal(createTransport(null,'disabled',validate,[]),undefined);
});
test('provider dispatch counting includes failures and unknown pricing stays unknown',async () => {
  const requests=[]; let fail=false;
  const runtime=measureNativeRuntime({async classify(){if(fail)throw Error('secret');return {stopReason:'stop',usage:{input:3,output:2,cost:{total:0}}};}},requests);
  const model={provider:'typesafe',id:'jev-latest',cost:{input:0,output:0}};
  await runtime.classify(model,{questions:{one:q}},{}); fail=true;
  await assert.rejects(runtime.classify(model,{questions:{two:q}},{}));
  assert.equal(requests.length,2); assert.equal(requests[0].costUsd,null); assert.equal(requests[1].status,'failed');
  assert.ok(!JSON.stringify(requests).includes('secret')); assert.equal(sumKnown([1,null]),null);
  assert.equal(mergeMetadata([{metadata:{usage:{requests:1,costUsd:1}}},{}],2).usage.costUsd,undefined);
});
