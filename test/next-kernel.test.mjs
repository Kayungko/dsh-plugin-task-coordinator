import test from 'node:test';
import assert from 'node:assert/strict';
import { readPersistedProgress } from '../ops.mjs';
import { feedbackPage } from '../feedback.mjs';
import { createFamilyQueries } from '../family.mjs';

test('0.2 cold progress reads bounded event pages without resuming a Session', async () => {
  const events=Array.from({length:900},(_,seq)=>({seq,type:'user/message',data:{id:`m${seq}`,content:[{type:'text',text:`event ${seq}`}]}}));
  const controller={events:async(request,signal)=>{
    assert.equal(request.address.sessionId,'cold');
    assert.equal(request.maxMessages,400);assert.ok(signal instanceof AbortSignal);
    const end=Math.min(events.length,request.beforeSeq??events.length);
    return {cursor:899,records:events.slice(Math.max(0,end-400),end).map(event=>({type:'event',event})),hasMore:end>400};
  }};
  const initial=await readPersistedProgress(controller,'cold',null);
  assert.equal(initial.from,500);assert.equal(initial.throughSeq,900);assert.equal(initial.events.length,400);
  const incremental=await readPersistedProgress(controller,'cold',10);
  assert.equal(incremental.events[0].seq,10);assert.equal(incremental.events.at(-1).seq,409);
  const page=feedbackPage({sessionId:'cold',...incremental,nextSeq:10,limit:6,chars:100,source:'persisted'});
  assert.equal(page.messages[0].seq,10);assert.equal(page.hasMore,true);assert.equal(page.coverage,'complete');
});

test('0.2 empty cold event page has a valid empty cursor',async()=>{
  const value=await readPersistedProgress({events:async()=>({cursor:-1,records:[]})},'empty',null);
  assert.deepEqual(value,{events:[],from:0,throughSeq:0});
});

test('0.2 history omits an unknown cut and pins subsequent pages to the returned cursor',async()=>{
  let request;
  const queries=createFamilyQueries({registry:{snapshot:()=>({state:'ready',entries:[{sessionId:'child',parentSessionId:'parent'}]})},sessionController:{
    list:async()=>({items:[{sessionId:'parent'},{sessionId:'child'}]}),
    page:async(value)=>{request=value;return {cursor:20,hasMore:true,records:[{type:'event',event:{seq:5,type:'user/message',data:{}}}]};},
  }});
  const result=await queries.history('parent','child',null,new AbortController().signal);
  assert.equal(result.ok,true);assert.equal(Object.hasOwn(request,'throughSeq'),false);
  assert.deepEqual(result.nextCursor,{throughSeq:20,beforeSeq:5});
});
