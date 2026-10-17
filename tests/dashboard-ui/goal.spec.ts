import { test, expect, openChat } from "./fixtures.js";
import { openAiFrame, openAiDone } from "../fixtures/mock-provider.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
const final={frames:[openAiFrame({content:"Taking another useful step."},"stop"),openAiDone]};
const complete={frames:[openAiFrame({tool_calls:[{index:0,id:"proof",type:"function",function:{name:"goal",arguments:JSON.stringify({action:"update",criteria:[{id:"criterion-1",status:"done",evidence:"fixture acceptance checked"}]})}},{index:1,id:"done",type:"function",function:{name:"goal",arguments:JSON.stringify({action:"complete"})}}]},"tool_calls"),openAiDone]};
test.describe("native lifecycle",()=>{
 test.use({scenario:{agent:{tools:{use:["builtin/goal"]}},responses:[{hold:true},final,complete]}});
 test("AC-5 browser start pause edit resume clear and reconnect share canonical state",async({page,raw})=>{
  await openChat(page,raw); const goal=page.getByTestId("native-goal");
  await goal.getByRole("button",{name:"Start native Goal",exact:true}).click();
  await goal.getByRole("textbox",{name:"Goal objective",exact:true}).fill("Ship fixture");
  await goal.getByRole("button",{name:"Start Goal",exact:true}).click();
  await expect.poll(()=>raw.provider.requests.length).toBe(1); await expect(page.getByTestId("goal-status")).toHaveText("active");
  await page.reload(); await expect(page.getByTestId("goal-status")).toHaveText("active"); expect(raw.provider.requests.length).toBe(1);
  await page.getByRole("textbox",{name:"Message",exact:true}).fill("Steering is not consent"); await page.getByRole("button",{name:"Send",exact:true}).click();
  await goal.getByRole("button",{name:"Pause Goal",exact:true}).click(); await expect(page.getByTestId("goal-status")).toHaveText("paused"); expect(raw.provider.requests.length).toBe(1);
  await goal.getByRole("button",{name:"Edit Goal",exact:true}).click(); await goal.getByRole("textbox",{name:"Goal objective",exact:true}).fill("Reframed fixture"); await goal.getByRole("button",{name:"Save Goal edits",exact:true}).click();
  await expect(goal.locator(".goal-objective")).toHaveText("Reframed fixture"); await expect(page.getByTestId("goal-status")).toHaveText("paused");
  await goal.getByRole("button",{name:"Resume Goal",exact:true}).click(); await expect(page.getByTestId("goal-status")).toHaveText("complete"); expect(raw.provider.requests.length).toBe(3);
  await goal.getByText("Criteria and evidence",{exact:true}).click(); await expect(goal).toContainText("fixture acceptance checked"); await expect(goal).toContainText("Requests 3/");
  await goal.getByRole("button",{name:"Clear Goal",exact:true}).click(); await expect(page.getByTestId("goal-status")).toHaveText("not started"); await page.reload(); await expect(page.getByTestId("goal-status")).toHaveText("not started"); expect(raw.provider.requests.length).toBe(3);
 });
});
test.describe("native approval waiting",()=>{
 test.use({scenario:{agent:{tools:{use:["builtin/goal","builtin/write_file"],rules:[{match:"builtin/write_file",effect:"ask"}]}},responses:[{frames:[openAiFrame({tool_calls:[{index:0,id:"write",type:"function",function:{name:"write_file",arguments:JSON.stringify({path:"forbidden",content:"bad"})}}]},"tool_calls"),openAiDone]}]}});
 test("AC-5 approval is activity, steering never consents, pause cancels waiting work",async({page,raw})=>{
  await openChat(page,raw); const box=page.getByRole("textbox",{name:"Message",exact:true}); await box.fill("/goal start Ship approval fixture"); await page.getByRole("button",{name:"Send",exact:true}).click();
  const goal=page.getByTestId("native-goal"); await expect(goal).toContainText("Waiting for approval"); await expect(page.getByTestId("goal-status")).toHaveText("active");
  await box.fill("yes"); await page.getByRole("button",{name:"Send",exact:true}).click(); expect(existsSync(join(raw.root,"forbidden"))).toBe(false);
  await goal.getByRole("button",{name:"Pause Goal",exact:true}).click(); await expect(page.getByTestId("goal-status")).toHaveText("paused"); expect(existsSync(join(raw.root,"forbidden"))).toBe(false); expect(raw.provider.requests.length).toBe(1);
 });
});

test.describe("native editor concurrency and preservation",()=>{
 test.use({scenario:{agent:{tools:{use:["builtin/goal"]}},responses:[{hold:true}]}});
 async function pausedGoal(raw:Awaited<ReturnType<typeof import("../fixtures/dashboard.js").dashboardFixture>>){
  const session=await raw.json<{id:string}>("/sessions","POST",{cwd:raw.root,agent:"raw"}),path=`/sessions/${session.id}/goal`;
  await raw.json(`${path}/commands`,"POST",{clientRequestId:"start",expectedRevision:0,command:{action:"start",definition:{objective:"Original objective",steps:[{id:"verify",label:"Verify",detail:"KEEP_THIS_DETAILED_INSTRUCTION"}]}}});
  await expect.poll(()=>raw.provider.requests.length).toBe(1);
  const active=await raw.json<{revision:number}>(path);
  const paused=await raw.json<{revision:number}>(`${path}/commands`,"POST",{clientRequestId:"pause",expectedRevision:active.revision,command:{action:"pause"}});
  return {session,path,paused};
 }
 test("AC-5 editor rejects stale draft instead of overwriting remote required criteria",async({page,raw})=>{
  const f=await pausedGoal(raw);await page.goto(raw.server.launchUrl);await page.goto(`${raw.server.url}/chat/${f.session.id}`);
  const goal=page.getByTestId("native-goal");await goal.getByRole("button",{name:"Edit Goal",exact:true}).click();await goal.getByRole("textbox",{name:"Goal objective",exact:true}).fill("Local old draft");
  await raw.json(`${f.path}/commands`,"POST",{clientRequestId:"remote-edit",expectedRevision:f.paused.revision,command:{action:"edit",definition:{objective:"Remote new objective",criteria:[{label:"NEW_REMOTE_REQUIRED_ACCEPTANCE"}]}}});
  await expect(goal.locator(".goal-objective")).toHaveText("Remote new objective");await goal.getByRole("button",{name:"Save Goal edits",exact:true}).click();
  await expect(page.getByText(/stale_revision/).first()).toBeVisible();
  const state=await raw.json<{goal:{definition:{objective:string;criteria:{label:string}[]}}}>(f.path);expect(state.goal.definition.objective).toBe("Remote new objective");expect(state.goal.definition.criteria[0]?.label).toBe("NEW_REMOTE_REQUIRED_ACCEPTANCE");
 });
 test("AC-5 objective-only edit preserves structured step IDs and details",async({page,raw})=>{
  const f=await pausedGoal(raw);await page.goto(raw.server.launchUrl);await page.goto(`${raw.server.url}/chat/${f.session.id}`);
  const goal=page.getByTestId("native-goal");await goal.getByRole("button",{name:"Edit Goal",exact:true}).click();await goal.getByRole("textbox",{name:"Goal objective",exact:true}).fill("Updated objective only");await goal.getByRole("button",{name:"Save Goal edits",exact:true}).click();await expect(goal.locator(".goal-objective")).toHaveText("Updated objective only");
  const state=await raw.json<{goal:{definition:{steps:{id:string;detail?:string}[]}}}>(f.path);expect(state.goal.definition.steps[0]).toMatchObject({id:"verify",detail:"KEEP_THIS_DETAILED_INSTRUCTION"});
 });
});
