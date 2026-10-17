import { goalFixture, goalUsage } from "./goals.js";
const f = goalFixture(request => { request.onUsage?.(goalUsage); process.stdout.write(JSON.stringify({ ready: true, root: f.root, sessionId: f.session.id }) + "\n"); return new Promise(() => {}); });
void f.agent.runGoal({ objective: "Provisional crash", tokenBudget: 100 }).catch(error => { console.error(error); process.exitCode = 1; });
