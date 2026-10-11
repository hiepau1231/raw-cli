import type { InteractionRequest } from "../../../../src/interactions/contract.js";
import { formRequest } from "../interaction-state.js";
import { useEffect, useId, useRef, useState } from "react";
import type { FormAnswers, FormField, InteractionResponseAcknowledgement, InteractionState } from "../../../../src/panels/contract.js";
import { MAX_TEXT_ANSWER_BYTES, validateFormAnswers } from "../../../../src/panels/forms.js";
import { resolveAction } from "../../../../src/panels/actions.js";
import { errorText } from "../../api.js";
import { useActionScope } from "../actions.js";

export function Form({ blockId, fields }: { blockId: string; fields: FormField[] }) {
  const scope = useActionScope();
  const request = formRequest(scope?.item, scope?.host.interactions ?? [], blockId);
  return <FormControls key={request?.identity.requestId ?? "unavailable"} blockId={blockId} fields={fields} request={request} scope={scope} />;
}

const stateChip: Record<InteractionState, [string, string]> = {
  pending: ["Waiting for you", "accent"], answered: ["Answered", "success"], cancelled: ["Cancelled", "muted"],
  expired: ["Expired", "muted"], interrupted: ["Interrupted", "warning"],
};
const encoder = new TextEncoder();
type ChoiceField = Extract<FormField, { options: unknown }>;
type TextField = Extract<FormField, { kind: "text" }>;
/** Only ask_user pairs a choice with its own-answer field `<id>_other`; any other form's fields stay independent. */
const OTHER_OWNER = "builtin/ask_user";

/**
 * A question as question.png shows it: a state chip, the question, one card per option (radio or checkbox), an "Other…"
 * card that opens the free-text field paired with the choice (`<id>_other`), then Skip and the primary Send answer.
 * React owns draft/ACK/busy state per request; late work belongs to the unmounted old control.
 */
function FormControls({ blockId, fields, request, scope }: {
  blockId: string; fields: FormField[]; request: InteractionRequest | undefined; scope: ReturnType<typeof useActionScope>;
}) {
  const prefix = useId();
  const [draft, setDraft] = useState<FormAnswers>({});
  const [others, setOthers] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState<InteractionResponseAcknowledgement>();
  const retry = useRef<{ body: string; key: string } | undefined>(undefined);
  const focusOther = useRef<string | undefined>(undefined);
  const currentAck = ack?.requestId === request?.identity.requestId ? ack : undefined;
  const canonicalResult = request?.canonicalResult ?? currentAck?.canonicalResult;
  const shown = request?.form.fields ?? fields;
  const pairs = (request?.identity.owner ?? scope?.item.owner) === OTHER_OWNER;
  const pairOf = (field: FormField) => !pairs || field.kind === "text" ? undefined
    : shown.find((other): other is TextField => other.kind === "text" && !other.required && other.id === `${field.id}_other`);
  const paired = new Set(shown.flatMap((field) => pairOf(field)?.id ?? []));
  useEffect(() => {
    if (!canonicalResult) return;
    const result = JSON.parse(canonicalResult) as { answers?: FormAnswers };
    if (!result.answers) return;
    setDraft(result.answers);
    setOthers(Object.fromEntries(shown.filter((field) => paired.has(field.id) && result.answers![field.id]).map((field) => [field.id.slice(0, -"_other".length), true])));
  }, [canonicalResult]);
  useEffect(() => {
    if (!focusOther.current) return;
    document.getElementById(`${prefix}-${focusOther.current}`)?.focus();
    focusOther.current = undefined;
  });
  const state = currentAck?.state ?? request?.state;
  const disabled = !request || state !== "pending" || busy || !scope?.host.respond;
  const actions = (request?.declaration.actions.filter(action => {
    if (action.kind !== "response") return false;
    try { resolveAction(request.declaration, { action: action.id, block: blockId }, request.document); return true; } catch { return false; }
  }) ?? []).sort((a, b) => Number(a.response === "submit") - Number(b.response === "submit"));
  // A computed key in a literal makes an own property even for an ID such as "__proto__".
  const set = (id: string, value: string | string[] | undefined) => setDraft(previous => {
    const next: FormAnswers = { ...previous, [id]: value ?? "" };
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[id];
    return next;
  });
  const toggleOther = (field: ChoiceField, open: boolean) => {
    setOthers(previous => ({ ...previous, [field.id]: open }));
    if (open) focusOther.current = `${field.id}_other`; else set(`${field.id}_other`, undefined);
    // A single choice is either an option or the user's own answer.
    if (open && field.kind === "single_select") set(field.id, undefined);
  };
  const submit = async (response: "submit" | "cancel") => {
    if (disabled || !request || !scope?.host.respond) return;
    try {
      if (response === "submit") for (const field of request.form.fields) {
        const value = draft[field.id];
        const limit = field.kind === "text" ? field.max_bytes ?? MAX_TEXT_ANSWER_BYTES : 0;
        if (typeof value === "string" && field.kind === "text" && encoder.encode(value).length > limit) throw new Error(`${field.label} is too long: at most ${limit.toLocaleString("en-US")} bytes`);
      }
      const answers = response === "submit" ? validateFormAnswers(request.form, draft) : undefined;
      const body = JSON.stringify({ response, answers });
      if (retry.current?.body !== body) retry.current = { body, key: crypto.randomUUID() };
      setError(""); setBusy(true);
      setAck(await scope.host.respond(request, { requestId: request.identity.requestId, expectedRevision: request.revision,
        idempotencyKey: retry.current.key, ...(response === "submit" ? { response, answers: answers! } : { response }) }));
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  const textInput = (field: TextField, label?: string) => {
    const id = `${prefix}-${field.id}`;
    const value = typeof draft[field.id] === "string" ? draft[field.id] as string : "";
    const props = { id, className: "panel-input", value, disabled, "aria-label": label,
      "aria-describedby": field.description ? `${id}-description` : undefined, onChange: (event: { target: { value: string } }) => set(field.id, event.target.value || undefined) };
    return field.multiline ? <textarea rows={3} {...props} /> : <input type="text" {...props} />;
  };
  const [chip, tone] = state ? stateChip[state] : [undefined, undefined];
  return <div className="panel-form">
    {!request && <p role="note">Responses are unavailable for this form.</p>}
    {chip && <div className="panel-form-head"><span className={`sp-chip tone-${tone} panel-form-state`} role="status">{chip}</span></div>}
    {shown.filter((field) => !paired.has(field.id)).map(field => {
      const id = `${prefix}-${field.id}`;
      const description = field.description ? <p id={`${id}-description`} className="panel-form-description">{field.description}</p> : null;
      const describedBy = field.description ? `${id}-description` : undefined;
      if (field.kind === "text") return <div className="panel-form-field" key={field.id}>
        <label className="panel-form-question" htmlFor={id}>{field.label}</label>
        {description}
        {textInput(field)}
      </div>;
      const pair = pairOf(field);
      const multiple = field.kind === "multi_select";
      const value = draft[field.id];
      const chosen = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
      const full = multiple && chosen.length >= (field.max_selected ?? field.options.length);
      const otherOpen = !!pair && !!others[field.id];
      return <div className="panel-form-field" key={field.id}>
        <span className="panel-form-question" id={`${id}-label`}>{field.label}</span>
        {description}
        <div className="panel-options" role={multiple ? "group" : "radiogroup"} aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
          {field.options.map(option => {
            const selected = chosen.includes(option.id);
            return <label key={option.id} className="panel-option" data-selected={selected}>
              <input type={multiple ? "checkbox" : "radio"} name={id} checked={selected} disabled={disabled || (full && !selected)}
                onChange={event => {
                  if (!multiple) { set(field.id, option.id); if (pair) toggleOther(field, false); return; }
                  set(field.id, event.target.checked ? [...chosen, option.id] : chosen.filter(choice => choice !== option.id));
                }} />
              <span className="panel-option-label">{option.label}</span>
            </label>;
          })}
          {pair && <label className="panel-option panel-option-other" data-selected={otherOpen}>
            <input type={multiple ? "checkbox" : "radio"} name={id} checked={otherOpen} disabled={disabled} onChange={event => toggleOther(field, multiple ? event.target.checked : true)} />
            <span className="panel-option-label">Other…</span>
          </label>}
        </div>
        {otherOpen && textInput(pair, pair.label)}
        {/* An optional single choice can be withdrawn; a radio alone cannot be unchecked. */}
        {!multiple && !field.required && !pair && chosen.length > 0 && <button type="button" className="panel-button panel-form-clear" disabled={disabled}
          onClick={() => set(field.id, undefined)}>Clear choice</button>}
      </div>;
    })}
    {error && <p className="error small" role="alert">{error}</p>}
    {actions.length > 0 && <div className="panel-form-actions">{actions.map(action => <button key={action.id} type="button" className={action.response === "submit" ? "panel-button primary" : "panel-button"} disabled={disabled} onClick={() => void submit(action.response!)}>{action.label}</button>)}</div>}
  </div>;
}
