import { useState } from "react";
import type { GoalCommand, GoalDefinition, GoalState } from "../../../src/goals/contract.js";
export function GoalControls({ state, selected, disabled, activity, command }: {
  state: GoalState | undefined; selected: boolean; disabled: boolean; activity: string | undefined;
  command: (value: GoalCommand, expectedRevision?: number) => Promise<void>;
}) {
  const goal = state?.goal;
  const [draft, setDraft] = useState<GoalState>();
  const [editing, setEditing] = useState(false), [objective, setObjective] = useState(""), [doneWhen, setDoneWhen] = useState("");
  const [criteria, setCriteria] = useState(""), [steps, setSteps] = useState("");
  const [tokens, setTokens] = useState(""), [requests, setRequests] = useState("");
  if (!selected && !goal) return null;
  const terminal = goal?.status === "complete" || goal?.status === "abandoned";
  const blocked = disabled || !selected;
  const openEdit = () => {
    setDraft(structuredClone(state ?? { revision: 0, goal: null }));
    setObjective(goal?.definition.objective ?? ""); setDoneWhen(goal?.definition.doneWhen ?? "");
    setCriteria(goal?.definition.criteria.map(item => `${item.required ? "" : "? "}${item.label}`).join("\n") ?? "");
    setSteps(goal?.definition.steps.map(item => item.label).join("\n") ?? ""); setEditing(true);
  };
  const lines = (value: string) => value.split("\n").map(s => s.trim()).filter(Boolean);
  const submit = async () => {
    if (!draft) return;
    const originalSteps = [...(draft.goal?.definition.steps ?? [])];
    const definition: GoalDefinition = { objective, ...(doneWhen.trim() ? { doneWhen } : {}),
      ...(criteria.trim() ? { criteria: lines(criteria).map(label => ({ label: label.startsWith("? ") ? label.slice(2) : label, required: !label.startsWith("? ") })) } : {}),
      steps: lines(steps).map(label => {
        const index = originalSteps.findIndex(item => item.label === label);
        const original = index < 0 ? undefined : originalSteps.splice(index, 1)[0];
        return { label, ...(original ? { id: original.id, ...(original.detail === undefined ? {} : { detail: original.detail }) } : {}) };
      }) };
    await command({ action: draft.goal ? "edit" : "start", definition }, draft.revision); setEditing(false);
  };
  return <section className="native-goal" aria-label="Native Goal" data-testid="native-goal">
    <div className="native-goal-heading"><strong>Native Goal</strong><span data-testid="goal-status">{goal?.status ?? "not started"}</span>{activity && <small>{activity}</small>}</div>
    {goal && <>
      <p className="goal-objective">{goal.definition.objective}</p>
      {goal.reason && <p>Stop reason: <strong>{goal.reason}</strong></p>}{goal.nextAction && <p>Needs user action: {goal.nextAction}</p>}
      <small>Requests {goal.usage.requests}/{goal.definition.maxRequests} · Tokens {goal.usage.inputTokens + goal.usage.outputTokens}{goal.definition.tokenBudget === undefined ? " (no token cap)" : `/${goal.definition.tokenBudget}`} · Usage coverage input {goal.usage.inputCoverage}/{goal.usage.requests}, output {goal.usage.outputCoverage}/{goal.usage.requests} · Active {Math.floor(goal.elapsedMs / 1000)}s{goal.elapsedApproximate ? " (approximate)" : ""}</small>
      <details><summary>Criteria and evidence</summary><p>Done when: {goal.definition.doneWhen}</p><ul>{goal.definition.criteria.map(item => <li key={item.id}><strong>{item.status}</strong> — {item.label}{item.required ? " (required)" : ""}{item.evidence && <p>Evidence (recorded, not test certification): {item.evidence}</p>}</li>)}</ul>{goal.definition.steps.length > 0 && <ol>{goal.definition.steps.map(item => <li key={item.id}>{item.status} — {item.label}{item.detail && `: ${item.detail}`}</li>)}</ol>}</details>
    </>}
    {!selected && <p>Select builtin/goal to control this saved native Goal.</p>}
    <div className="actions">
      {!goal && <button disabled={blocked} onClick={openEdit}>Start native Goal</button>}
      {goal && !terminal && <>
        {goal.status === "active" ? <button disabled={blocked} onClick={() => void command({ action: "pause" }).catch(() => {})}>Pause Goal</button> : <button disabled={blocked} onClick={() => void command({ action: "resume" }).catch(() => {})}>Resume Goal</button>}
        <button disabled={blocked} onClick={openEdit}>Edit Goal</button>
        <button disabled={blocked || !goal.definition.criteria.every(c => !c.required || (c.status === "done" && c.evidence))} onClick={() => void command({ action: "complete" }).catch(() => {})}>Complete Goal</button>
        <button disabled={blocked} onClick={() => void command({ action: "abandon" }).catch(() => {})}>Abandon Goal</button>
      </>}
      {goal && <button disabled={blocked} onClick={() => void command({ action: "clear" }).catch(() => {})}>Clear Goal</button>}
    </div>
    {editing && <form className="native-goal-editor" onSubmit={event => { event.preventDefault(); void submit().catch(() => {}); }}>
      <label>Goal objective<textarea aria-label="Goal objective" value={objective} required onChange={e => setObjective(e.target.value)} /></label>
      <label>Done when<textarea aria-label="Done when" value={doneWhen} onChange={e => setDoneWhen(e.target.value)} /></label>
      <label>Criteria (one per line; prefix optional with ? )<textarea aria-label="Goal criteria" value={criteria} onChange={e => setCriteria(e.target.value)} /></label>
      <label>Steps (one per line)<textarea aria-label="Goal steps" value={steps} onChange={e => setSteps(e.target.value)} /></label>
      <small>Editing pauses and settles work, resets criteria/evidence and keeps cumulative usage. It does not resume.</small>
      <div className="actions"><button disabled={blocked} type="submit">{draft?.goal ? "Save Goal edits" : "Start Goal"}</button><button type="button" onClick={() => setEditing(false)}>Cancel Goal edits</button></div>
    </form>}
    {goal && !terminal && <details><summary>Goal budget</summary><form onSubmit={e => { e.preventDefault(); const budget = { action: "setBudget" as const, ...(tokens ? { tokenBudget: Number(tokens) } : {}), ...(requests ? { maxRequests: Number(requests) } : {}) }; void command(budget).catch(() => {}); }}>
      <label>Token cap<input aria-label="Goal token cap" type="number" min="1" step="1" value={tokens} onChange={e => setTokens(e.target.value)} /></label>
      <label>Request cap<input aria-label="Goal request cap" type="number" min="1" step="1" value={requests} onChange={e => setRequests(e.target.value)} /></label>
      <p>Budgets stop between requests, not a hard billing cap. A request may exceed the token threshold.</p>
      <div className="actions"><button disabled={blocked || (!tokens && !requests)} type="submit">Set Goal budget</button><button disabled={blocked || goal.definition.tokenBudget === undefined} type="button" onClick={() => void command({ action: "setBudget", tokenBudget: null }).catch(() => {})}>Remove token cap</button></div>
    </form></details>}
  </section>;
}
