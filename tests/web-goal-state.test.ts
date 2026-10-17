import assert from "node:assert/strict";
import test from "node:test";
import { reduceEvent } from "../web/src/session.js";
import { transitionGoal, type GoalState } from "../src/goals/contract.js";
import type { DashboardEvent } from "../src/dashboard/streams.js";
const start=()=>transitionGoal({revision:0,goal:null},{action:"start",definition:{objective:"Ship"}},"user");
const frame=(type:string,data:unknown)=>({type,data,sessionId:"session",instanceId:"host",sequence:1,id:"host:1"} as DashboardEvent);
const snapshot=(goal:GoalState)=>frame("snapshot",{goal,history:{items:[]},inputs:[],live:[],operations:[],panels:[]});
test("AC-5 stale Goal frames and stale resets cannot undo clear or replace a newer goal",()=>{
 const a=start(); let state=reduceEvent(undefined,snapshot(a));
 const clear=transitionGoal(a,{action:"clear"},"user"); state=reduceEvent(state,frame("goal",clear)); assert.equal(state?.goal?.goal,null); assert.equal(state?.goal?.revision,clear.revision);
 state=reduceEvent(state,frame("goal",a)); assert.equal(state?.goal?.goal,null);
 state=reduceEvent(state,snapshot(a)); assert.equal(state?.goal?.goal,null);
 const b=transitionGoal(clear,{action:"start",definition:{objective:"Second"}},"user"); state=reduceEvent(state,frame("goal",b)); assert.equal(state?.goal?.goal?.id,b.goal?.id);
 state=reduceEvent(state,frame("goal",clear)); assert.equal(state?.goal?.goal?.id,b.goal?.id);
 state=reduceEvent(state,frame("reset",{goal:b,history:{items:[]},inputs:[],live:[],operations:[],panels:[]})); assert.equal(state?.goal?.goal?.id,b.goal?.id);
});
test("AC-5 an operation ending cleanly never completes or resumes a native Goal projection",()=>{
 const a=start(),paused=transitionGoal(a,{action:"pause"},"user"); let state=reduceEvent(undefined,snapshot(paused));
 state=reduceEvent(state,frame("operation",{id:"op",state:"completed",sessionId:"session"})); assert.deepEqual(state?.goal,paused);
});
