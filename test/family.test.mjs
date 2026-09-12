import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFamily, createFamilyQueries, relationEvents, installFamilyRoutes, FAMILY_PATH, HISTORY_PATH } from '../family.mjs';

const entries = [
  {sessionId:'a',parentSessionId:'root',createdAt:1,depth:1,team:'dev',title:'A',promptExcerpt:'PRIVATE',externalRef:'PRIVATE',expectedWorkspace:'PRIVATE'},
  {sessionId:'b',parentSessionId:'root',createdAt:2,depth:1,team:'dev',title:'B'},
  {sessionId:'c',parentSessionId:'a',createdAt:3,depth:2,team:'nested',title:'C'},
  {sessionId:'foreign',parentSessionId:'other-root',createdAt:4,depth:1,team:'dev',title:'Other'},
];
const snapshot = {state:'ready',maxEntries:500,entries};
const ids = new Set(['root','a','b','c','foreign','other-root','solo']);
test('root, child and grandchild resolve the same family without mixing equal team names',()=>{
 for(const id of ['root','a','c']){
  const result=buildFamily(snapshot,id,ids);
  assert.equal(result.rootSessionId,'root');
  assert.deepEqual(result.nodes.map(n=>n.sessionId),['root','a','b','c']);
  assert.equal(result.currentSessionId,id);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|promptExcerpt|expectedWorkspace|externalRef/);
 }
 assert.deepEqual(buildFamily(snapshot,'c',ids).currentPath,['root','a','c']);
 assert.equal(buildFamily(snapshot,'solo',ids).associated,false);
 assert.equal(buildFamily(snapshot,'unknown',ids).code,'session-not-visible');
});
test('broken/cyclic ancestry and unreadable registry do not become ordinary empty states',()=>{
 const cycle={...snapshot,entries:[{sessionId:'a',parentSessionId:'b'},{sessionId:'b',parentSessionId:'a'}]};
 assert.equal(buildFamily(cycle,'a',ids).code,'lineage-cycle');
 const partial=buildFamily({...snapshot,entries:[entries[2]]},'c',ids);
 assert.equal(partial.ancestryComplete,false);
 assert.equal(partial.rootSessionId,'a');
 assert.equal(buildFamily({...snapshot,state:'invalid'},'a',ids).code,'registry-unavailable');
 const hidden=buildFamily(snapshot,'c',new Set(['c']));
 assert.equal(hidden.nodes.find(n=>n.sessionId==='a').title,undefined);
});
const event=(seq,type,data)=>({type:'event',event:{seq,type,time:seq*1000,data}});
const call=event(5,'tool/call',{callId:'call-1',name:'task_send',arguments:JSON.stringify({sessionId:'c',mode:'steer',message:'PRIVATE'})});
const result=event(6,'tool/result',{message:{source:{kind:'tool',callId:'call-1'},content:[{type:'tool-result',isError:false,content:[{type:'text',text:JSON.stringify({ok:true,targetId:'c',delivered:true,private:'PRIVATE'})}]}]}});
const report=event(7,'user/message',{source:{kind:'coordinator',form:'relay',senderSessionId:'c'},content:[{type:'text',text:'PRIVATE'}]});
test('native event pages project only relation facts and retain uncertainty at a missing call boundary',()=>{
 const {events,unmatched}=relationEvents([call,result,report],'a','c');
 assert.equal(unmatched,0);
 assert.deepEqual(events.map(e=>e.kind),['send','report']);
 assert.equal(events[0].mode,'steer');
 assert.doesNotMatch(JSON.stringify(events),/PRIVATE|content|message/);
 assert.equal(relationEvents([result],'a','c').unmatched,1);
 assert.equal(relationEvents([call,result,report],'a','b').events.length,0);
});
test('history reads only the actual parent with a bounded native page and rejects other families',async()=>{
 const calls=[];
 const queries=createFamilyQueries({registry:{snapshot:()=>snapshot},sessionController:{
  list:async()=>({items:[...ids].map(sessionId=>({sessionId,projections:{asOfSeq:20}}))}),
  page:async(request)=>{calls.push(request);return {records:[call,result,report],hasMore:true}},
  resolveAgent(){throw Error('must not activate')},inspect(){throw Error('must not read all history')},
 }});
 const history=await queries.history('b','c',null,new AbortController().signal);
 assert.equal(history.sourceSessionId,'a');
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0],{address:{kind:'session',sessionId:'a'},throughSeq:20,maxMessages:30});
 assert.deepEqual(history.nextCursor,{throughSeq:20,beforeSeq:5});
 assert.equal((await queries.history('b','foreign',null,new AbortController().signal)).code,'target-not-in-family');
 assert.equal(calls.length,1);
 await queries.history('b','c',history.nextCursor,new AbortController().signal);
 assert.equal(calls[1].beforeSeq,5);
});
test('connection-owned routes have a read-only method set and validate identifiers/cursors',async()=>{
 const routes=[];
 const connection={fetch:{register(route){routes.push(route);return()=>{}}}};
 const ctx={inject(deps,fn){assert.deepEqual(deps,['connection']);fn({connection})},effect(fn){return fn()}};
 installFamilyRoutes(ctx,{registry:{snapshot:()=>snapshot},sessionController:{list:async()=>({items:[...ids].map(sessionId=>({sessionId}))})}});
 assert.deepEqual(routes.map(r=>r.path),[FAMILY_PATH,HISTORY_PATH]);
 assert.ok(routes.every(r=>r.methods.length===1&&r.methods[0]==='GET'));
 const family=await routes[0].fetch(new Request('http://dsh.internal'+FAMILY_PATH+'?sessionId=c'));
 assert.equal(family.status,200);assert.equal((await family.json()).rootSessionId,'root');
 assert.equal((await routes[0].fetch(new Request('http://dsh.internal'+FAMILY_PATH))).status,400);
 assert.equal((await routes[1].fetch(new Request('http://dsh.internal'+HISTORY_PATH+'?sessionId=c&targetId=a&beforeSeq=-2&throughSeq=9'))).status,400);
});
