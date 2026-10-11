# Tool UX design: model-friendly tool contracts, readable tool display, side-panel redesign

This design makes Raw's built-in tools easy for any model to call. It also makes every tool readable in the CLI and the dashboard, and brings the dashboard side panel up to the standard of common editor UIs.

Status: proposed 2026-10-11. Phases 1 (normalization, host data, value-safe JSON capping), 2 (single-command `bash` with background delegation, flat `process`), 3 (single-file `read_file`/`write_file`, `edit_file`, opt-in `apply_patch`, one shared files-changed panel), 4 (single-question `ask_user` with the `questions[]` alias, `todo` aliases), 5 (display hints, readable rendering on every surface, approval headlines, the full-result route), 6 (dashboard tool cards: header with kind icon, title, summary, status badge and duration; terminal, code, diff, markdown and JSON-tree bodies; the arguments disclosure; Load full output), 7 (side-panel layout: shared height, one type and spacing scale, 28 px headers, 24 px rows, dividers instead of cards, no repeated titles), 8 (Todo: Hide completed in the section menu, hover actions, the in-progress note only; Files changed: relative paths, name and muted directory, `+N −M`, status letter, expandable diff, `@` action, `N files · +a −r` header, omitted-history footer only when non-zero) and 9 (Commands: Running and Completed groups whose open state is stored per session in `raw.dashboard.commands.v1`, 24 px monospace rows with glyph, duration and exit badge, description and differing cwd below, a terminal output frame with status, copy, follow and Load full output, hover Stop, Copy command and `@` saved output, "Older commands not shown") implemented: every phase is implemented. Phase 8 deviations: the explanatory text stays the document subtitle, which phase 7 already shows only in the header tooltip, so panel declarations gain no description field; the Recent diff block is dropped because every row expands its own latest diff, which for binary, too large or unreadable files is the reason there is none; the panel has no `done` status, so its header shows no `Done` badge. Phase 9 deviations: the cwd comparison happens in the dashboard against the session's cwd rather than in `presentation.ts`, which keeps every row's cwd; durations use the tool cards' format (`1.2 s`, `3m 04s`); a row whose group is collapsed stays visible while its output is open, it is focused or it shows a Stop result; the output frame labels a channel only where it changes. Phase 5 deviations: the `read_file` summary is `{path}[:{offset}][ +{limit}]`, not `{path}:{offset}–{end}`, because the end of the window is unknown before the call; CLI result headers omit the tool name, which the call's start line already shows; the full-result route's errors use the dashboard's shared `{error:{code,message}}` body (`full_output_unavailable` 410, `full_output_refused` 403, `not_found` 404). No backward compatibility: the user decided (2026-10-11) that the old argument shapes, rule paths and panel owner are replaced, not kept. Update this file whenever a decision changes. User-facing behavior moves to `tools.md`, `dashboard.md`, `terminal-output.md` and `panels-design.md` as each phase lands.

## Contents

1. Problem and evidence
2. Goals and non-goals
3. Industry practice
4. Part A: tool contracts
5. Part B: tool display
6. Part C: side panel
7. Implementation plan
8. Decisions

## 1. Problem and evidence

**Models miscall the built-in tools.** Every built-in that does work takes a batch array or a `oneOf` union:

- `bash` takes `{"commands":[{"command","timeout_ms","env_refs"}]}`, with 1–16 entries (`src/tools/bundled/bash/tool.json`).
- `read_file` takes `{"files":[{"path","start_line","end_line","max_lines","max_bytes"}]}`.
- `write_file` takes `{"operations":[…]}` with four modes and a sha256 guard, or a `patch` string written in a custom dialect.
- `process` and `ask_user` use `oneOf` schemas.

The user's own session store (`~/.local/state/raw/stores/storage-v6`, models `deepseek-flash` and a local Qwen) has 442 tool calls:

| Tool | Calls | Failed | Failed on argument shape | Most common mistake |
| --- | --- | --- | --- | --- |
| bash | 333 | 56 | about 47 (14% of calls) | top-level `{"command": …}` (39 times), top-level `timeout_ms` (3) |
| read_file | 29 | 5 | 3 | top-level `path` |
| write_file | 44 | 10 | about 7 | top-level `path`, invalid `mode`, missing `operations[0].path` |
| todo | 28 | 2 | 2 | invalid JSON, missing fields in replace mode |

The remaining bash failures are real timeouts. Every shape failure is the model writing the shape it was trained on, which is a single action with flat arguments. Each one costs a full model round trip, and weak local models often repeat it.

**Only three tools render well.**

- `src/sessions/visible.ts:33,106` gives batch rows only to `builtin/read_file`, `builtin/write_file` and `builtin/bash`.
- Every other tool falls through to `addLines(lines, "json", JSON.stringify(value))` (`visible.ts:121`). This includes `todo`, `process`, MCP tools and plugins. The result is one minified JSON line, which `bounded()` then cuts in the middle, so the JSON can break.
- The dashboard card shows the tool identity as its title, the Terminal icon for every tool, and the arguments as a JSON block (`web/src/timeline.tsx:131,138,154`).
- The CLI header is the whole `JSON.stringify(args)` (`src/terminal/tools.ts:35`).
- Bash itself shows stdout inside a one-line JSON row (`visible.ts:119`).
- A tool has no way to declare how it should be displayed.
- `docs/terminal-output.md:26` promises "a generic readable fallback", which this code does not deliver.

**The side panel looks unfinished.** Screenshots of the current build (fixture session) show these problems:

- **Files changed:**
  - absolute paths, wrapped and underlined (`web/src/panels/blocks/Files.tsx:16`, `.panel-ref` in `styles.css:3506`);
  - no `+N −M` per file;
  - the title and an explanatory subtitle repeated inside the body;
  - an "Omitted 0" row.
- **Commands:**
  - each command is bold prose that wraps mid-word, followed by a full cwd line and a default-styled "Output" button (`web/src/panels/Commands.tsx:80-85`, `styles.css:3725-3729`);
  - "Completed commands (N)" is a plain button;
  - its expanded state lives in `Commands` and resets whenever the section collapses, because `Section.tsx:86-90` unmounts the body. After that, only rows that are focused, failed or showing output stay visible, so it looks as if only the latest command is listed.
- **Todo:** the title is repeated, a "Hide completed" checkbox sits in the body, and every row shows its own `⋯` button.
- **Layout:**
  - each expanded section is fixed at 50% of the panel height (`SidePanel.tsx:57`, required by `panels-design.md` §13.1 "Size"), so a short list leaves a large empty box and a long one is clipped;
  - font sizes mix 11, 12 and 13 px, and spacing uses literals of 4, 6, 8, 10 and 12 px.

## 2. Goals and non-goals

**Goals**

1. A model trained on any mainstream agent harness calls Raw's built-in tools correctly on the first try, without reading a long description.
2. Common near-miss argument **names** are accepted, not rejected (degrade, never block). These are aliases from other harnesses; Raw's own old batch shapes are not kept.
3. Every tool is readable on every surface: a one-line summary of the call, a status, and a result body that is not broken JSON. This includes MCP and plugin tools.
4. A tool author can improve how their tool is displayed by declaring a few fields, without writing UI.
5. The side panel follows the VS Code / Cursor pattern: dense rows, status glyphs, relative paths, diff stats, monospace commands, sections that share the height.

**Non-goals**

- Running tool calls in parallel. Calls in one assistant message keep running in order (`src/agent.ts:1428-1471`).
- New panel block kinds, or changes to the `raw.panel/2` document format.
- Theming beyond the existing light and dark tokens.
- Backward compatibility (§4.6). Old batch shapes, old rule paths, old result rows and the old tool-owned files-changed panel are not supported after the change.
- Rewriting stored history.

## 3. Industry practice

These are the argument schemas of mainstream harnesses. Sources and line numbers are in the research notes for this design:

- Claude Code: tools reference and the Piebald-AI prompt extraction.
- Codex: `codex-rs/core/src/tools/handlers`.
- Gemini CLI: `packages/core/src/tools/definitions`.
- Qwen Code: `packages/core/src/tools`.
- OpenCode: `packages/core/src/tool/plugin`.
- OpenHands: `openhands-tools`.
- Anthropic text editor tool.

| Kind | Claude Code | Gemini CLI | Qwen Code | OpenCode | OpenHands / SWE-agent / Anthropic |
| --- | --- | --- | --- | --- | --- |
| Shell | `Bash {command, timeout(ms), description, run_in_background}` | `run_shell_command {command, description, dir_path, is_background}` | `run_shell_command {command, timeout(ms), description, directory, is_background}` | `shell {command, workdir, timeout(ms), background}` | `terminal {command, timeout(s)}` |
| Read | `Read {file_path, offset, limit}` | `read_file {file_path, start_line, end_line}` | `read_file {file_path, offset, limit}` | `read {path, offset, limit}` | `view {path, view_range}` |
| Write | `Write {file_path, content}` | `write_file {file_path, content}` | `write_file {file_path, content}` | `write {path, content}` | `create {path, file_text}` |
| Edit | `Edit {file_path, old_string, new_string, replace_all}` | `replace {file_path, old_string, new_string, allow_multiple}` | `edit {file_path, old_string, new_string, replace_all}` | `edit {path, oldString, newString, replaceAll}` | `str_replace {path, old_str, new_str}` |
| Todo | `TodoWrite {todos[{content, status, activeForm}]}` | `write_todos {todos[{description, status}]}` | `todo_write {todos[{id, content, status}]}` | — | `task_tracker` |
| Ask | `AskUserQuestion {questions[…]}` | `ask_user {questions[]}` | `ask_user_question {questions[{question, header, options, multiSelect}]}` | `question {questions[]}` | — |

Codex differs in three ways: `exec_command {cmd, workdir, yield_time_ms}`, a freeform `apply_patch` grammar, and `update_plan {plan[{step, status}]}`.

What every harness shares:

- one action per call, with flat scalar arguments;
- `command` for the shell;
- `file_path` or `path`;
- `old_string`/`new_string` for edits;
- line windows as `offset`/`limit`;
- timeouts in milliseconds (OpenHands uses seconds).

No harness uses a batch array of commands or files. Models run several commands or reads by emitting several tool calls in one message.

## 4. Part A: tool contracts

### 4.1 Principles

- **One action per call.** Every built-in takes flat arguments. Parallel work means several calls in one message, which Raw already runs in order.
- **Canonical names follow the majority:**
  - `command`, `path`, `content`, `old_string`, `new_string`, `replace_all`;
  - `offset` (1-based line) and `limit` (line count);
  - `timeout` in milliseconds.
- **Aliases are normalized, never rejected.** A normalization step runs before validation for each built-in (§4.3). It maps the names other harnesses use to the canonical ones. Policy, hooks, approvals and history all see the **normalized** arguments, so a rule written for `command` matches whichever name the model used.
- **Model-facing results are plain text**, the way harnesses return them. Structured data for the host travels in `ToolResult.host` (§4.5). That data covers exit codes, timing, saved-copy paths, output pages, file changes and diffs. It is persisted with the result and never sent to a provider.
- **Short descriptions.** Each description is at most about 600 characters. It shows one example call and says only what a model must know. Limits and edge cases live in `docs/tools.md`.
- **Unknown arguments are ignored with a note, not rejected.** The call runs. The result ends with `[ignored unknown argument: foo]`, so the model can correct itself without a failed round trip. This applies only when the remaining arguments are valid. A call missing a required field is still rejected, with an error that shows one canonical example.

### 4.2 The built-in tools

**`bash`**

```jsonc
{ "command": "npm test", "timeout": 120000, "description": "Run the test suite", "env_refs": { "TOKEN": "gh_token" } }
```

- `command` is required. It is a nonempty string run with `bash -c` in the session cwd.
- `timeout` is in milliseconds, default 120000, maximum 600000. A value above the maximum is clamped, with a note. Seconds are accepted only through the explicit aliases `timeout_s` and `timeout_seconds`.
- `description` is optional, at most 200 characters, and is shown as the call's title on every surface.
- **`run_in_background`** (optional boolean; aliases `is_background` and `background`). Decided by the user (2026-10-11, D10): a background call starts a managed job through the existing process manager instead of running in the foreground.
  - **Delegation.** The call is still a `bash` call for policy, hooks and approval, with `run_in_background: true` in its normalized arguments (also in the fallback case), so rules can condition on it. After the bash gates pass, the host dispatches `process {action: "start", command, cwd, label: description, env_refs, timeout}` through the normal registry path, so the `builtin/process` policy, hooks, approval and limits apply too. The nested dispatch shares the outer call's ID, signal, approval and hook services, but not its lifecycle observers: there is one `bash` call on every surface, with its own arguments. `timeout` is passed only when the model gave one: a background job has no default timeout.
  - **Result.** `Started background job <id> (<command>).` followed by the two follow-up calls, `process {"action":"output","id":"<id>"}` and `process {"action":"stop","id":"<id>"}`. Host data carries the job ID. The job appears in the Commands panel like any `process` job. A refusal reached inside the `process` dispatch (a rejected approval, a blocking hook, limits, an unsupported platform) is returned as that error, and nothing runs in the foreground.
  - **Degrade.** When `builtin/process` is not selected for the agent, not exposed to the call, or hidden by an unconditional `deny` rule, the bash gates still run with the flag; then the flag is ignored with the note `[ignored run_in_background: background jobs need the process tool; ran in the foreground]` and the command runs in the foreground under its timeout.
- `env_refs` is unchanged from today, for one command.
- **Result.** The text is the output, with stdout and stderr in the order they were produced and each block tagged with its `channel`. It is followed by one status line:
  - `[exit 0 · 1.2s]`;
  - `[exit 2 · 0.4s]`;
  - `[timed out after 120s; process group stopped]`.

  Oversized output keeps its start and end around the existing `…[N bytes omitted; full output: <path>]…` marker, and `fullOutputPath` is set. A nonzero exit sets `isError: false` but `exitCode`, so the model reads the exit code and the host can still color the status.
- **Aliases:**
  - `cmd` and `script` map to `command`;
  - `timeout_ms` maps to `timeout`, in milliseconds;
  - `timeout_s` and `timeout_seconds` are multiplied by 1000 into `timeout`;
  - `workdir`, `cwd`, `dir_path` and `directory` mean cd into that directory first. The value is resolved against the session cwd and must stay inside the workspace rules that already apply to `process.cwd`.

**`read_file`**

```jsonc
{ "path": "src/app.ts", "offset": 120, "limit": 80 }
```

- `path` is required.
- `offset` is a 1-based first line, default 1. `limit` is a line count, default 2000.
- **Result.** The text is the selected lines with a line-number gutter (`  120│…`), the format models are trained on. It ends with `[lines 120–199 of 431]`, or `[end of file]`. A file larger than the window says how to continue (`offset: 200`).
  - The existing per-line and byte budgets stay. A line longer than the budget is cut with a marker.
  - `sha256` is no longer returned.
- **Aliases:**
  - `file_path`, `filePath` and `absolute_path` map to `path`;
  - `start_line` maps to `offset`;
  - `end_line` becomes `limit = end_line − offset + 1`;
  - `max_lines` and `lines` map to `limit`;
  - `view_range: [a, b]` becomes `offset: a` and `limit: b − a + 1`, where `b = -1` means to the end.

**`write_file`**

```jsonc
{ "path": "notes/todo.md", "content": "# Todo\n" }
```

- It creates or overwrites the file, creating parent directories as needed.
- **Result:** `Wrote 1,240 bytes to notes/todo.md (created)`, or `(overwritten)`.
- **Aliases:**
  - `file_path`, `filePath` and `absolute_path` map to `path`;
  - `file_text`, `text` and `contents` map to `content`.
- `append`, `replace_lines`, the sha256 guard and the `patch` argument are removed from `write_file`. Edits go through `edit_file`, patches through `apply_patch`.

**`edit_file`** (new)

```jsonc
{ "path": "src/app.ts", "old_string": "const a = 1;", "new_string": "const a = 2;", "replace_all": false }
```

- It replaces one exact occurrence of `old_string`, or every occurrence when `replace_all` is true. `new_string` may be empty, which deletes the match.
- **Errors:**
  - zero matches: `old_string not found in src/app.ts`;
  - several matches without `replace_all`: `old_string matches 3 times in src/app.ts; add surrounding lines to make it unique or set replace_all`.

  Each error includes the nearest similar lines, when that is cheap, so the model can retry.
- **Result:** `Edited src/app.ts: 1 replacement (+1 −1 lines)`.
- **Aliases:**
  - `file_path`, `filePath` and `absolute_path` map to `path`;
  - `old_str`, `oldString` and `old_text` map to `old_string`;
  - `new_str`, `newString` and `new_text` map to `new_string`;
  - `replaceAll` maps to `replace_all`;
  - `allow_multiple: true` maps to `replace_all: true`.
- **Shared with `write_file`:** policy effects (`describeEffects` produces `files: [{path, action: "edit"}]`), the files-changed tracking, the `files_changed` panel (one panel shared by both tools, see §6.3) and approval.

**`apply_patch`** (kept, opt-in)

- The patch dialect in `src/tools/file-patch.ts` moves to its own tool, `apply_patch {patch}`. Codex-trained GPT models expect it.
- It is not in the starter tool selection. It is shipped, documented, and can be selected in `tools.use`.

**`process`**

- The `oneOf` schema becomes one flat object:

  ```jsonc
  { "action": "start" | "list" | "status" | "output" | "stop", "command": "...", "id": "...", "cwd": "...", "label": "...", "timeout": 3600000, "cursor": 0, "max_bytes": 65536, "env_refs": {} }
  ```

  The validator already reads a flat object (`process/index.ts:5-22`). It checks per action which fields are required.
- Results become short text (`Started proc_3 · npm run dev`, a status table, an output page with `[next cursor: 18432]`). The structured value moves to host metadata.
- **Aliases:**
  - `timeout_ms` maps to `timeout`;
  - `process_id`, `shell_id` and `bash_id` map to `id`;
  - a field the chosen action does not use is dropped with a host note instead of failing the call.

**`ask_user`**

```jsonc
{ "question": "Which database should the service use?", "options": ["Postgres", "SQLite"], "multi_select": false, "allow_other": true }
```

- It asks one question per call.
- `options` is optional. It accepts strings or `{label, description}` objects; a description is shown after its label. Without options the question is free text.
- `allow_other` defaults to true: the form adds an optional "Other" text field and the choice becomes optional, so the user can answer in their own words or skip.
- The schema lists `questions` next to `question`, because dispatch drops top-level keys the schema does not name.
- The host builds the existing form document from these arguments. The panel, interaction and ledger paths stay unchanged.
- **Result:** the answer as text, e.g. `User answered: Postgres`, or the free text, or `User skipped the question`.
- **Aliases:**
  - `multiSelect` maps to `multi_select`;
  - `header` maps to the field label;
  - `questions: [{question, header, options, multiSelect}]` (the Claude Code, Qwen and Codex shape) asks up to 3 questions in one form. This is an alias for a trained shape, not the old Raw schema; the old `kind`/`id`/`free_text` schema is removed.

**`todo`**

- The schema is unchanged; it already has the TodoWrite shape and its failure rate is low.
- Statuses gain aliases:
  - `completed` maps to `done`;
  - `cancelled` maps to `skipped`;
  - `in-progress` maps to `in_progress`.
- Item text accepts `description`, `title` and `step` as aliases of `content`.

**`view_image`, `list_skills`, `load_skill`, `list_vars`, `read_var`**

- Unchanged, apart from adding `file_path` as an alias of `path` in `view_image`.

### 4.3 Normalization

- Each built-in exports `normalizeArguments(args) → { args, notes }`, run by `ToolRegistry.dispatch` before `validate`.
  - It is pure: it renames aliases and converts explicit units (`timeout_s`). It never guesses values.
  - It is idempotent: canonical arguments pass through unchanged.
  - `notes` (for example `read file_path as path`) go to host data. Only ignored-argument notes are appended to the model text.
- **One action per call.** Dispatch is unchanged after normalization: validate, effects, policy, `PreToolUse`, approval, execution, then `PostToolUse` or `PostToolUseFailure` by outcome.
- **Shapes that are not aliases are rejected.** This includes Raw's old batch shapes (`commands`, `files`, `operations`, `patch` on `write_file`). The error shows one canonical example, e.g. `bash takes one command: {"command":"npm test"}; call bash once per command`.
- **What is stored.**
  - History and model context keep the arguments **as the model sent them**, so replay to the same provider stays byte-identical.
  - Policy, hooks, approvals, effects and display use the normalized arguments, stored on the call record next to the raw ones.
- MCP and plugin tools are not normalized; their schemas belong to their authors.

### 4.4 Policy, hooks and approvals

- **Policy `when` paths.** For the redesigned built-ins, rules on `arguments` bind against the canonical schema (`src/tools/policy.ts:54-110`): `command` for `bash` and `path` for the file tools.
- **Old paths are not translated.** A saved rule or hook subscription on `commands[*].command`, `files[*].path` or `operations[*].path` for these built-ins fails to bind, as any rule on a nonexistent path does today, so the agent does not load until the rule is fixed. Failing loudly is deliberate: silently dropping a `deny` rule would widen permissions. The error is made specific: `rule path commands[*].command does not exist in builtin/bash; the argument is now command`.
- **Shipped examples** are updated: `examples/agents/project-helper/raw.json`, `examples/packages/mixed-kit/agents/helper.json` and `examples/hooks/guard/hook.json`.
- **Effects paths** (`files[*].path` in `effects` conditions, `docs/tool-effects.md`) are unchanged, and `edit_file` and `apply_patch` produce the same effects shape.
- **The policy editor template** (`web/src/pages/agents/PolicyEditor.tsx:17,132-134`) uses `command` and `path`.
- **Hooks** receive the normalized arguments in `tool.arguments` of the `raw.hook/2` request, plus `tool.raw_arguments` when normalization changed something. This is documented in `docs/hooks.md`. (Earlier drafts called these `tool_input` and `raw_tool_input`; Raw's hook protocol names them under `tool`.)
- **Background bash** (§4.2) passes both gates: the `builtin/bash` rules and hooks for the call itself, then the `builtin/process` rules, hooks and approval for the job it starts. A conditional `ask` rule or a `PreToolUse` hook on `process` start therefore also covers background `bash`. An unconditional `deny` on `builtin/process` hides that tool, so background calls fall back to the foreground under the bash gates. When both tools ask for approval, the user may see two prompts for one call.
- **Approvals.** Each tool call is approved on its own, as today; there is no session-wide approval. A model that issues several flat calls where it used to send one batch may get several prompts. Rules that `allow` routine commands avoid that, as they do today. The approval text shows the summary from §5.2 (`$ npm test`, `Edit src/app.ts`), not raw JSON. In the dashboard the approval is a card after its work group with the title, the summary and a short preview of multi-line text; the raw arguments are behind **Arguments** ([chat-design.md](chat-design.md) §7).

### 4.5 Host data

`ToolResult` gains `host?: HostData`. It is filled by built-ins and is optional for every other tool.

- **What it carries:**
  - `summary`: the call summary.
  - `status`: `ok | error | timeout | cancelled`.
  - `durationMs`.
  - Optional fields:
    - `exitCode`, `signal`;
    - `fullOutputPath`, replacing the batch row's `full_output`;
    - `page`: a process output page's position (`cursor` of its first byte, `next`, the job's `total` bytes, `earliestCursor`, `droppedBytes`, `truncated`); its bytes are the result's channel text blocks, so they are not stored twice;
    - `processId`: the job a background `bash` call or `process` start created;
    - `files`: `[{path, action: create|overwrite|edit|delete|rename, added, removed, destination?}]`;
    - `diff`: a unified diff, at most 64 KiB, otherwise omitted with `diffOmitted: true`.
- **Where it goes:**
  - **Persistence.** It is stored with the result in history and in the model context record, like today's `fullOutputPath`.
  - **Providers.** It is removed before providers, hooks receive it as `tool.result.host`, and capping does not count it (like panel blocks, `src/tools/types.ts:26`).
- **Consumers moved to it:**
  - `collectFacts` (`src/compact.ts:593-634`): commands, exit codes, files touched.
  - `savedOutputPaths` (`compact.ts:578-583`) and clearing (`src/context-clearing.ts:71`).
  - The files-changed tracking (`src/agent.ts:1204-1205,1446`), which takes completed file records from any of the three editing tools (§6.3).
  - The commands activity feed (`src/processes/presentation.ts`).
  - Display (Part B).

  The `results[]` row parsing is removed.

### 4.6 No backward compatibility

By the user's decision, nothing old is translated or kept. What happens to existing data:

- **Old sessions.** Resuming with a changed tool schema already marks earlier messages as historical, through the schema digest (`src/sessions/store.ts:670-691`). `projectReplayMessages` then sends old batch calls as text. The model sees them as history, not as native calls that would clash with the new schema. No new code is needed.
- **Old stored display records** render through the generic fallback of Part B: a summary and readable JSON. They lose their special rows.
- **Compaction facts** (`collectFacts`) read only host data. Old calls contribute nothing to "files touched" and "last command".
- **Old rules and hooks** with batch paths fail to bind with a specific error (§4.4).
- **Hooks and plugins** that read `tool.arguments.commands` must change to `tool.arguments.command`. This is listed in the release notes.
- **Forked tool copies.** `examples/tools/*` are regenerated by `scripts/build-tool-examples.mjs`. A user's own fork of an old copy stays a local tool with its own schema.

### 4.7 Verification

- Contract tests per tool:
  - the canonical shape;
  - every alias listed above;
  - the old batch shapes, which are rejected with an example;
  - unknown-argument notes;
  - errors with an example.
- A fixture of the **actual failing shapes** from §1, synthesized without private content: top-level `command`, top-level `timeout_ms`, top-level `path` for reads and writes. Each must run successfully.
- Policy tests: a rule on `command` or `path` matches both canonical and aliased calls (`cmd`, `file_path`); an old batch path fails to bind with the specific error.
- An optional live check: `scripts/eval-tool-calls.mjs` sends 20 fixed tasks to a configured model and counts shape errors before and after. It is not part of `npm test`.

## 5. Part B: tool display

### 5.1 Display hints in `tool.json`

```jsonc
"display": {
  "title": "Search the web",            // human title; default: the tool name, title-cased
  "kind": "search",                     // read | edit | execute | search | fetch | think | other; ACP kind and icon
  "icon": "search",                     // optional; one of the dashboard icon names, default by kind
  "summary": "{query}",                 // template over the normalized arguments; default: §5.2
  "result": "markdown"                  // text | markdown | code | json | terminal; default: §5.3
}
```

- All fields are optional. The manifest validator (`src/tools/plugins/manifest.ts:8-9`) accepts `display`.
- **MCP tools** take `title` from the MCP tool's `annotations.title`, and `kind` from `annotations.readOnlyHint` (`read`) or `openWorldHint` (`fetch`), otherwise `other`. Config `mcp.servers.<name>.display.<tool>` can override any field.
- **Package MCP tools** (`pkg#mcp/…`) are treated like config MCP tools. The CLI icon check `startsWith("mcp/")` is fixed.
- **ACP:** `src/sessions/display.ts:18` takes `kind` from the hint instead of guessing from the name.

**Built-in hints**

| Tool | Title | Kind | Summary | Result |
| --- | --- | --- | --- | --- |
| bash | `description`, or "Run command" | execute | `$ {command}` | terminal |
| read_file | "Read" | read | `{path}:{offset}–{end}` | code |
| write_file | "Write" | edit | `{path}` | text |
| edit_file | "Edit" | edit | `{path}` | diff |
| apply_patch | "Patch" | edit | the changed paths | diff |
| process | "Process" | execute | `{action} {id or command}` | text |
| todo, ask_user | (existing) | think, other | (existing) | panel or interaction |

### 5.2 Call summary (default)

When `summary` is absent, the host builds one line from the normalized arguments:

1. the first present value among `command`, `path`, `url`, `query`, `pattern`, `name`, `id` and `title`;
2. otherwise the first string argument;
3. followed by up to two short `key=value` pairs for the remaining scalar arguments.

The line is cut to 120 characters on every surface, with the full arguments available on expand. Values that look like secrets are never shown in the summary: argument names matching `token|secret|password|key` render as `•••`.

### 5.3 Result body (default)

- **Text content.**
  - `markdown` when the hint says so, or for MCP tools whose text starts with markdown structure (a heading, a list or a fenced block) on the dashboard;
  - otherwise plain text.
  - The CLI renders markdown with the existing terminal markdown renderer.
- **JSON content.**
  - **Dashboard:** a collapsible JSON tree, first two levels open.
  - **CLI:** pretty-printed with two-space indentation.
  - Never a single minified line.
- **Status.** Every card shows exactly one of:
  - ok, error (`isError`), exit N (`exitCode`), timed out, cancelled or denied;
  - plus the duration.
- **Bounding at execution** (`capResult`, `src/tools/results.ts`).
  - Today an oversized JSON block is cut as text before display ever sees it. Instead, an oversized JSON block is saved whole to a spill file, as text is today.
  - The model gets a **value-safe** reduction: valid JSON with long arrays elided as `"… 12 more items"` and long strings head/tail-cut, plus the existing notice naming the saved copy.
  - `fullOutputPath` points at the copy.
- **Bounding in previews** (`bounded()`, `src/sessions/visible.ts`).
  - Text keeps whole lines, head and tail, never cutting inside a line.
  - JSON is shown from the value-safe form, never cut as text.
- **Full result on expand.**
  - **Dashboard:** expanding a card fetches the saved original through a session route (`GET /api/sessions/:id/tool-results/:callId/full`).
    - The route is **read-only**. It takes only the call ID; the path comes from what this session stored for that call, never from the request:
      1. the `host.fullOutputPath` of the call's stored result (bash output, execution-level capping);
      2. otherwise, the `path` of that call's entry in the latest persisted `context_clearing` record of this session that contains the call ID (`results[]: {callId, tool, bytes, path}`, written by `src/agent.ts` when clearing replaces the result with a stub). Each clearing record lists only the results that operation cleared, so the lookup searches back past newer records.
    - It serves the file only when that path is a regular file inside a Raw spill directory. Spill directories are `<tmpdir>/<spill prefix>*` (`src/tools/spill.ts:42-45`), one per process, kept for 7 days. So a copy written by an earlier process is still served after a restart.
    - Every producer records the path it wrote, keyed by the call ID: bash output and execution-level capping in the result's host data (phases 1–2 set `host.fullOutputPath` next to `fullOutputPath`), clearing in its `context_clearing` record. Both survive a server restart and a context replacement, because neither lives only in the model context. The route needs no new directory scheme.
    - It never creates a copy. Clearing's `secureCopy` (`src/context-clearing.ts:56-67`) is not used, because it can produce a copy of the reduced result.
  - **Fallbacks:**
    - **No original** (none recorded, deleted or not readable): the card keeps the stored preview and shows "Full output is no longer available". This also applies after a reload or a compaction.
    - **Capped original** (`fullOutputCapped`): the card shows the copy with "Output was capped at 64 MiB when saved".
  - **Verification:**
    - successful retrieval right after the call and after a restart;
    - each producer: bash output, a capped JSON result, a cleared result;
    - a deleted copy, a capped copy, and a stored path outside the spill directories.

### 5.4 Surfaces

- **Dashboard tool row** (`web/src/tool-cards/ToolRow.tsx`; layout in [chat-design.md](chat-design.md) §6, which supersedes the header below).
  - **Row:** status glyph, title, summary (monospace for commands and paths), a chip for states other than OK, duration.
  - **Card:** closed by default except for errors.
  - **Expanded view by result type:**
    - `terminal`: the output without its channel markers, stderr in the error colour, Copy in the footer. **Full output** is shown when `fullOutputPath` exists.
    - `code`: a highlighted file view with line numbers.
    - `diff`: a unified diff with `+`/`−` coloring.
    - `markdown`: rendered markdown.
    - JSON: the tree.
  - The full arguments are under a "Arguments" disclosure.
- **CLI** (`src/terminal/tools.ts`).
  - **Header:** `<icon> <title> <summary>`.
  - **Result:** `<status> · <duration>`, then up to 4 preview lines at default density (as today).
  - **Bash** shows the output lines directly, not JSON. **Edit** shows `+N −M`.
- **ACP:** title, kind and status from the hints. Content is the text result.
- **Transport.** The loader and the MCP client put the resolved hints on the tool registration; the agent passes them into the projections and events; the canonical display records persist the projected title, kind and summary. Replay renders from those records, so history looks the same after the tool is unselected.

## 6. Part C: side panel

> **Superseded.** The VS Code-style layout below shipped and was replaced by [side-panel-design.md](side-panel-design.md) (Overview and tabs, cards per kind). The data contracts it introduced stay: the host-owned `files_changed` panel and its `added`, `removed` and `diff` fields (§6.3), the Commands projection and its 132-row cap (§6.4).

The reference is the VS Code Explorer / Source Control view and Cursor's agent side panel. This part amends `panels-design.md` §13.1 where noted. The panel contract and block kinds are unchanged.

### 6.1 Layout and tokens

- **Height** (amends §13.1 "Size"). Expanded sections **share** the available height, like VS Code split views. Each expanded section gets an equal share, or the size the user dragged, stored per agent as today. A section whose content is shorter than its share gives the rest to the others. Updates still never resize a section. Only expand, collapse, dragging and window size do.
- **Section header.**
  - 28 px high: chevron, icon, title, a muted count or summary, status glyph.
  - `⋯` appears on hover or focus.
  - The summary takes all the space left over (no 45% cap).
- **Rows.**
  - 24 px high, 13 px text, secondary text at 12 px in the muted color, a monospace face for paths and commands.
  - A hover background; actions appear on the right on hover or focus.
  - Labels end with an ellipsis, and the full text is in a tooltip and in the accessible name.
- **Tokens.** One type scale (12 / 13 / 14) and one spacing scale (4 / 8 / 12 / 16) as CSS variables, used by every panel component. No nested bordered cards: the side panel has no inner section borders, only 1 px dividers between headers, like VS Code.
- **No repeated chrome.**
  - The body does not repeat the section title.
  - A document `title` or `subtitle` shows only when it differs from the declaration title.
  - Explanatory text such as "Successful tool writes in this session…" moves to the header tooltip.

### 6.2 Todo

- **Rows** are a status glyph (the §6 table of `panels-design.md`) followed by the label.
  - Done items are muted with a strikethrough.
  - Children are indented 16 px, with their glyphs aligned.
- **Header:** progress `3/7` with a 2 px progress line.
- **Moved into the `⋯` menu:** "Hide completed" and the item actions, opened from a per-row hover button.
- **Notes** show as a muted second line only for the in-progress item; for other items they are in the tooltip.

### 6.3 Files changed

- **One row per file:**
  - a file-type icon;
  - the **file name** in normal weight and the **relative directory** muted, e.g. `parser.ts  src/`;
  - `+12 −3` in success and error colors;
  - a status letter at the right (`A`, `M`, `D`, `R`) in the matching color.
- **Paths** are relative to the session cwd. Paths outside it show `~/…` or the absolute path, muted.
- **Clicking a row** expands its latest diff inline (unified diff, monospace, max 400 px, scrollable). The **`@`** hover action inserts `@path` into the composer, as today.
- **Header:** `3 files · +40 −12`.
- **Omitted history** shows only when there is some, as a muted footer row.
- **Grouping.** `write_file`, `edit_file` and `apply_patch` publish to one `files_changed` panel owned by the host (`host/files_changed`), not by a single tool. This lands in phase 3 with the editing tools:
  - **Declaration discovery** lists it when the agent selects any of the three tools.
  - **Publication** comes from the host data of every completed editing action, including actions completed before an abort (today this protection exists only for `write_file`, `src/agent.ts:1446`).
  - **The old tool-owned panel.** The `builtin/write_file` panel declaration is removed, so the old panel of an existing session is shown as stale (§12 of `panels-design.md`) until the session is cleared. No migration.
  - **Identities.** Policy, hooks and effects keep each tool's own identity; only the panel owner changes.
  - **Phase 8** changes only how the panel looks.
- **Diff stats.** The files-changed document gains `added`/`removed` counts per file and the latest unified diff per file. The counts come from a complete line diff of the before and after content, not from the bounded diff preview that `src/tools/write-changes.ts` builds today (6144 bytes), so a large edit still reports its full `+N −M`. The stored diff stays bounded (64 KiB, §4.5).
- **Block contract.** The `files` block gains optional `added`, `removed` and `diff`. Older documents without them render as today, minus the stats. This is the one change to `raw.panel/2` blocks: an additive optional field, allowed by §17 forward compatibility.

### 6.4 Commands

- **Two groups**, each a collapsible group header inside the section:
  - **Running (N)**, open by default;
  - **Completed (N)**, collapsed by default, newest first.
- **Group open state** is stored per session in the browser (`raw.dashboard.commands.v1`). It lives in a store outside the section body, so collapsing and reopening the section keeps it. This fixes the reset described in §1.
- **One 24 px row per command:**
  - a status glyph: a spinner while running, a check for exit 0, a cross with the error color for a nonzero exit, a clock for timed out, a slashed circle for stopped;
  - the command in monospace on one line, with an ellipsis;
  - at the right, the duration (`1.2s`, `3m 04s`) and an exit badge (`exit 2`) for nonzero exits.
- **Below a row**, a muted secondary line shows the `description` (§4.2) when the call had one, and the cwd only when it differs from the session cwd.
- **Clicking a row** expands an output frame:
  - dark terminal background, monospace 12 px, max 320 px, scrollable, auto-following while running;
  - a header with exit status and a copy button;
  - a link to the full output when it was saved.
- **Hover actions:** stop (running rows), copy command, insert `@` reference to the saved output.
- **The 132-row server cap** (`src/processes/presentation.ts`) stays. The Completed group header shows the total, and a final muted row says `older commands not shown` when the cap applies.

### 6.5 Details

Details keeps its content and uses the same row and key/value styling: label muted on the left, value right-aligned, tabular numbers.

### 6.6 Verification

- Playwright specs under `tests/dashboard-ui/`:
  - **Commands:** the open state of the Completed group survives a section collapse and reopen, and a reload.
  - **Files changed:** rows show the relative path and `+N −M`, and expand to a diff.
  - **Todo:** "Hide completed" is in the menu.
  - **Sharing:** an expanded short section gives its spare height to another.
- **Screenshot captures** (`tests/dashboard-ui/capture-panels.ts`) are refreshed and compared by eye in review. They are not pixel assertions.
- The **axe checks** in light and dark themes keep passing (`accessibility.spec.ts`).

## 7. Implementation plan

Each phase is reviewed with `codex-impl-review` and committed on its own. Every phase keeps `npm run check` and `npm run test:web` passing.

**Group A: tool contracts**

1. **Normalization, preflight and host data.**
   - `normalizeArguments` in the registry, the action list, and the whole-call preflight (§4.3).
   - `ToolResult.host`, its persistence, and its removal before providers.
   - Specific binding errors for old rule paths.
   - Execution-level value-safe JSON capping.
   - No built-in changes yet; tests use a fixture tool.
2. **bash and process.**
   - New schemas, text results with host data, aliases, explicit seconds aliases.
   - The `process` flat schema.
   - `run_in_background` delegated to `process` start, with the foreground fallback (D10).
   - The commands activity feed keeps its per-command entries.
   - Docs, skills and examples.
3. **read_file, write_file, edit_file, apply_patch.**
   - New schemas and text results, aliases, the old `files`/`operations`/`patch` shapes.
   - `edit_file` with its effects.
   - The host-owned `files_changed` panel (§6.3).
   - `apply_patch` split out; `append`, `replace_lines`, the sha256 guard and `patch` removed from `write_file`.
   - `collectFacts`, `savedOutputPaths` and clearing on host data.
   - The `file_path` alias of `view_image`.
   - Docs, skills and examples.
4. **ask_user and todo aliases.**
   - The single-question shape and the `questions[]` alias over the existing form.
   - Todo status and content aliases.

**Group B: display**

5. **Display hints and generic rendering.**
   - The `display` manifest field and the MCP annotation mapping.
   - Summaries, readable JSON, line-safe and value-safe previews, status and duration.
   - The full-result route with its unavailable fallback.
   - Approvals show summaries (§4.4). This moved here from phase 1 because the summary machinery lands in this phase; until then approvals show the normalized arguments.
   - CLI and ACP.
6. **Dashboard tool cards.**
   - Header, status badge, and the terminal, code, diff, markdown and JSON-tree bodies.
   - The arguments disclosure.

**Group C: side panel**

7. **Layout, tokens and section chrome.**
   - Shared height, header and row styles, no repeated titles. Amend `panels-design.md` §13.1.
8. **Todo and Files changed.**
   - Row designs, the files block `added`/`removed`/`diff`, and the host-owned `files_changed` panel shared by the three edit tools.
9. **Commands.**
   - Groups with persisted open state, rows, the output frame and hover actions.

One `loop-plan` covers all nine phases in this order: Group A, then B, then C. Cross-group dependencies:
- phase 5 needs host data (phase 1);
- phase 8 needs the host-owned panel and diff stats (phase 3);
- phase 9 needs the commands host data (phase 2).

## 8. Decisions

- **D1. One action per call, with aliases instead of rejections.** Decided by the user (2026-10-11).
- **D1a. No backward compatibility.** Decided by the user (2026-10-11). The old batch shapes, rule paths, result rows and tool-owned files-changed panel are dropped, not translated.
- **D2. Canonical argument names.** `path` over `file_path`, because Raw already uses `path` everywhere and the alias covers the other name. `offset`/`limit` over `start_line`/`end_line`, and timeouts in milliseconds, following the majority of §3.
- **D3. Model-facing results are text; metadata goes to the host.** Trained models read text tool output. JSON rows with escaped stdout cost tokens and are hard to read.
- **D4. Store raw arguments, act on normalized ones.** Replay stays byte-identical to what the provider produced, while rules and display see one shape.
- **D5. `apply_patch` is kept as a separate opt-in tool.** The dialect exists and suits Codex-trained models. Mixing it into `write_file` made both harder to call.
- **D6. Display hints, not tool-authored UI.** A tool author declares a title, kind, summary and result type; the host renders a fixed set of bodies. This follows `panels-design.md` D2.
- **D7. VS Code / Cursor as the side-panel reference.** Decided by the user (2026-10-11). Sections share the height instead of the fixed 50% of §13.1.
- **D8. One host-owned files-changed panel for all editing tools.** Splitting it per tool would show the same files in several sections.

- **D9. Timeouts are milliseconds everywhere.** Seconds come only from explicit `timeout_s`/`timeout_seconds` aliases; there is no magnitude heuristic.
- **D10. `bash` delegates background calls to `process`.** Decided by the user (2026-10-11), replacing the earlier "no background mode". Models trained on Claude Code, Gemini CLI and Codex send `run_in_background`/`is_background`/`background`; running those in the foreground would hang a dev server until the timeout. The flag starts a managed job through the `process` gates (§4.2, §4.4), and degrades to the foreground with a note when `process` is unavailable.
- **D11. `read_file` defaults to 2000 lines**, still bounded by the existing byte budget, which wins when smaller.
