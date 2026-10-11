import { MAX_TEXT_ANSWER_BYTES, type FormField, type PanelDocument } from "../../../panels/contract.js";
import { validateDocument } from "../../../panels/validate.js";
import type { ToolContext } from "../../primitives.js";
import type { NormalizedArguments } from "../../registry.js";
import { errorResult } from "../../results.js";
import type { ToolHandlerResult } from "../../types.js";
import { MODEL_NOTE_BYTES } from "../../normalize.js";

type Option = string | { label: string; description?: string };
interface Question { question: string; header?: string; options?: Option[]; multi_select?: boolean; allow_other?: boolean }
interface Input extends Partial<Question> { questions?: Question[] }

export const example = { question: "Which database should the service use?", options: ["Postgres", "SQLite"] };
const OLD = 'ask_user asks a question in plain words: {"question":"Which database should the service use?","options":["Postgres","SQLite"]}; '
  + 'several questions use "questions":[{"question":"…","header":"…","options":[…],"multiSelect":false}]';
const QUESTION_KEYS = ["question", "header", "options", "multi_select", "allow_other"];

const OPTION_KEYS = ["label", "description"];

/** Moves an alias to its canonical name; when both are present the alias is dropped with a note. */
function alias(item: Record<string, unknown>, notes: string[], from: string, to: string): void {
  if (!Object.hasOwn(item, from)) return;
  if (item[to] === undefined) { item[to] = item[from]; notes.push(`read ${from} as ${to}`); }
  else notes.push(`ignored ${from}: ${to} is set`);
  delete item[from];
}

/**
 * One trained question shape: `multiSelect` and `allowOther` read as their snake-case names. Fields this tool has no
 * use for, on a question or an option, are dropped with a note instead of failing the call.
 */
function normalizeQuestion(question: Record<string, unknown>, notes: string[], keep: readonly string[]): Record<string, unknown> {
  const next = { ...question };
  alias(next, notes, "multiSelect", "multi_select");
  alias(next, notes, "allowOther", "allow_other");
  for (const key of Object.keys(next)) if (!keep.includes(key)) { delete next[key]; notes.push(`ignored ${key}`); }
  if (Array.isArray(next.options)) next.options = next.options.map((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return option;
    const kept = Object.fromEntries(Object.entries(option).filter(([key]) => OPTION_KEYS.includes(key)));
    for (const key of Object.keys(option)) if (!OPTION_KEYS.includes(key)) notes.push(`ignored option ${key}`);
    return kept;
  });
  return next;
}

/**
 * The trained shapes (docs/tool-ux-design.md §4.2): one `question`, or `questions[]` as Claude Code, Qwen and Codex send
 * it. The removed kind/id/free_text schema is rejected with an example.
 */
export function normalizeArguments(input: Record<string, unknown>): NormalizedArguments {
  const notes: string[] = [];
  const questions = input.questions;
  if (Array.isArray(questions) && questions.some((item) => item && typeof item === "object" && ("kind" in item || ("label" in item && !("question" in item))))) {
    return { args: input, rejected: OLD };
  }
  // Top-level keys the schema does not name are dropped by dispatch; only the question fields are cleaned here.
  const args = normalizeQuestion(input, notes, [...QUESTION_KEYS, ...Object.keys(input).filter((key) => !["multiSelect", "allowOther"].includes(key))]);
  if (Array.isArray(questions)) {
    args.questions = questions.map((item) => item && typeof item === "object" && !Array.isArray(item)
      ? normalizeQuestion(item as Record<string, unknown>, notes, QUESTION_KEYS) : item);
  }
  return { args, notes: [...new Set(notes)] };
}

const optionLabel = (option: Option) => typeof option === "string" ? option : option.label;

/** The questions of a call, in order. */
function questionsOf(args: Input): Question[] {
  return args.questions ?? [{ question: args.question!, ...(args.header !== undefined ? { header: args.header } : {}),
    ...(args.options !== undefined ? { options: args.options } : {}), ...(args.multi_select !== undefined ? { multi_select: args.multi_select } : {}),
    ...(args.allow_other !== undefined ? { allow_other: args.allow_other } : {}) }];
}

const fieldId = (index: number, count: number) => count === 1 ? "answer" : `q${index + 1}`;
const cut = (text: string, chars: number) => [...text].length <= chars ? text : `${[...text].slice(0, chars - 1).join("")}…`;

/** A choice as the form shows it: the whole label, then as much of its description as fits in 200 characters. */
function shownLabel(option: Option): string {
  if (typeof option === "string" || !option.description) return optionLabel(option);
  const room = 200 - [...option.label].length - 3;
  return room >= 2 ? `${option.label} — ${cut(option.description, room)}` : option.label;
}

const size = (text: string) => Buffer.byteLength(text, "utf8");
const SEPARATOR = 2; // ", " between the parts of one answer

/**
 * Limits that keep the text result within the output budget: the form accepts answers by option id, but the result
 * spells out each chosen label, so a multiple choice may allow fewer selections and the text fields share what is left.
 */
function limits(questions: readonly Question[], budget: number): { selected: Array<number | undefined>; text: number } | undefined {
  // The fixed text around the answers; "(skipped)" is counted for every one of several questions as an upper bound.
  const single = questions.length === 1;
  if (budget < size("User skipped the question")) return undefined;
  let room = budget - (single ? size("User answered: ")
    : size("User answered:") + questions.reduce((sum, question) => sum + size(`\n- ${question.question}: (skipped)`), 0));
  const labels = questions.map((question) => (question.options ?? []).map((option) => size(optionLabel(option))).sort((a, b) => b - a));
  const selected = questions.map((question, index) => question.options?.length && question.multi_select ? labels[index]!.length : undefined);
  const cost = (index: number) => {
    const question = questions[index]!;
    if (!question.options?.length) return 0;
    const count = question.multi_select ? selected[index]! : 1;
    return labels[index]!.slice(0, count).reduce((sum, bytes) => sum + bytes + SEPARATOR, 0);
  };
  const texts = questions.reduce((count, question) => count + (!question.options?.length || (question.allow_other ?? true) ? 1 : 0), 0);
  const total = () => questions.reduce((sum, _question, index) => sum + cost(index), 0) + texts * (1 + SEPARATOR);
  while (total() > room) {
    const widest = selected.reduce<number | undefined>((best, count, index) => count !== undefined && count > 1
      && (best === undefined || cost(index) > cost(best)) ? index : best, undefined);
    if (widest === undefined) return undefined;
    selected[widest]!--;
  }
  room -= total() - texts * 1;
  return { selected, text: texts ? Math.min(MAX_TEXT_ANSWER_BYTES, Math.floor(room / texts)) : MAX_TEXT_ANSWER_BYTES };
}

/**
 * The form the existing interaction paths render. A question becomes one field: free text without options, else a
 * single or multiple choice whose options get generated ids. `allow_other` (default true with options) adds an optional
 * text field, and then the choice itself is optional too, so the user can answer in their own words or skip. With a
 * budget, selection counts and text lengths are limited so the spelled-out result fits it.
 */
function documentFor(args: Input, budget = Infinity): PanelDocument {
  const questions = questionsOf(args);
  const bounded = Number.isFinite(budget) ? limits(questions, budget) : undefined;
  if (Number.isFinite(budget) && !bounded) throw Object.assign(new Error("the questions and their answers cannot fit the output budget"), { code: "interaction_budget_too_small" });
  const text = bounded ? { max_bytes: bounded.text } : {};
  const fields: FormField[] = [];
  questions.forEach((question, index) => {
    const id = fieldId(index, questions.length);
    const label = cut(question.header ?? question.question, 200);
    const description = question.header !== undefined || label !== question.question ? { description: cut(question.question, 500) } : {};
    if (!question.options?.length) { fields.push({ id, label, ...description, kind: "text", multiline: true, required: false, ...text }); return; }
    const other = question.allow_other ?? true;
    const options = question.options.map((option, at) => ({ id: `o${at + 1}`, label: shownLabel(option) }));
    const selected = bounded?.selected[index];
    fields.push(question.multi_select ? { id, label, ...description, kind: "multi_select", options, required: !other,
      ...(selected !== undefined && selected < options.length ? { max_selected: selected } : {}) }
      : { id, label, ...description, kind: "single_select", options, required: !other });
    if (other) fields.push({ id: `${id}_other`, label: "Other", kind: "text", required: false, ...text });
  });
  return { title: cut(questions.length === 1 ? questions[0]!.header ?? "Question" : "Questions", 80), blocks: [{ id: "form", kind: "form", fields }] };
}

/** One answer as text: the chosen option labels, then any text of the user's own; undefined when nothing was given. */
function answerText(question: Question, id: string, answers: Record<string, unknown>): string | undefined {
  const value = answers[id];
  const parts: string[] = [];
  if (typeof value === "string" && value) parts.push(question.options?.length ? optionLabel(question.options[Number(value.slice(1)) - 1]!) : value);
  if (Array.isArray(value)) for (const choice of value) parts.push(optionLabel(question.options![Number(String(choice).slice(1)) - 1]!));
  const other = answers[`${id}_other`];
  if (typeof other === "string" && other) parts.push(other);
  return parts.length ? parts.join(", ") : undefined;
}

function resultText(args: Input, answers: Record<string, unknown>): string {
  const questions = questionsOf(args);
  if (questions.length === 1) {
    const answer = answerText(questions[0]!, fieldId(0, 1), answers);
    return answer === undefined ? "User skipped the question" : `User answered: ${answer}`;
  }
  return ["User answered:", ...questions.map((question, index) =>
    `- ${question.question}: ${answerText(question, fieldId(index, questions.length), answers) ?? "(skipped)"}`)].join("\n");
}

function validOption(option: unknown): boolean {
  if (typeof option === "string") return option.length > 0;
  if (!option || typeof option !== "object" || Array.isArray(option)) return false;
  const { label, description, ...rest } = option as Record<string, unknown>;
  return typeof label === "string" && label.length > 0 && (description === undefined || typeof description === "string") && !Object.keys(rest).length;
}

function questionError(value: unknown, at: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${at} must be an object`;
  const question = value as Record<string, unknown>;
  const unknown = Object.keys(question).find((key) => !QUESTION_KEYS.includes(key));
  if (unknown) return `${at}: unknown field ${unknown}`;
  if (typeof question.question !== "string" || !question.question.trim()) return `${at}: question must be a nonempty string`;
  if (question.header !== undefined && (typeof question.header !== "string" || !question.header.trim())) return `${at}: header must be a nonempty string`;
  for (const key of ["multi_select", "allow_other"]) if (question[key] !== undefined && typeof question[key] !== "boolean") return `${at}: ${key} must be a boolean`;
  if (question.options !== undefined) {
    if (!Array.isArray(question.options) || question.options.length > 32) return `${at}: options must be a list of at most 32 entries`;
    if (!question.options.every(validOption)) return `${at}: each option is a nonempty string or {"label": "…", "description": "…"}`;
  }
  return undefined;
}

export function validateArgs(raw: unknown): string | undefined {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "arguments must be an object";
    const args = raw as Record<string, unknown>;
    if (args.questions !== undefined) {
      if (QUESTION_KEYS.some((key) => args[key] !== undefined)) return "use question or questions, not both";
      if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) return "questions must contain 1–3 entries";
      for (const [index, question] of args.questions.entries()) { const error = questionError(question, `questions[${index}]`); if (error) return error; }
    } else {
      const error = questionError(Object.fromEntries(QUESTION_KEYS.filter((key) => args[key] !== undefined).map((key) => [key, args[key]])), "arguments");
      if (error) return error;
    }
    validateDocument(documentFor(args as Input));
    return undefined;
  } catch (error) { return (error as Error).message; }
}

const UNANSWERED: Record<string, string> = {
  cancelled: "User skipped the question",
  expired: "The question expired without an answer",
  interrupted: "The question was interrupted before an answer",
};

export async function handler(raw: unknown, context: ToolContext): Promise<ToolHandlerResult> {
  const invalid = validateArgs(raw);
  if (invalid) return errorResult("invalid_arguments", invalid);
  if (!context.interactions) return errorResult("interaction_unavailable", "This host has no response adapter");
  const args = raw as Input;
  const host = { summary: cut(questionsOf(args)[0]!.question.split("\n", 1)[0]!, 200) };
  try {
    // Room for the bounded note dispatch may append, such as an ignored argument, plus its separator.
    const result = await context.interactions.request({ panel: "questions", document: documentFor(args, context.maxOutputBytes - MODEL_NOTE_BYTES - 1) });
    if (result.status === "answered") return { isError: false, content: [{ type: "text", text: resultText(args, result.answers) }], host: { ...host, status: "ok" } };
    return { isError: true, code: `interaction_${result.status}`, content: [{ type: "text", text: UNANSWERED[result.status] ?? `The question ended: ${result.status}` }],
      host: { ...host, status: "error" } };
  } catch (error) {
    // Standalone plugins and the host have separate module instances; protocol error codes cross that boundary.
    const failure = error as Error & { code?: string };
    return errorResult(failure.code?.startsWith("interaction_") ? failure.code : "interaction_error", failure.message);
  }
}
