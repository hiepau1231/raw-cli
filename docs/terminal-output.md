# Terminal output

When an agent selects hooks, terminal status and saved history show a bounded receipt for every executed hook, including successful empty-output hooks. The receipt names the hook, lifecycle event and outcome; hook input and raw stdout stay out of terminal status. See [hooks](hooks.md).

Raw presents an agent header, streaming Markdown answer, tool activity, and a session footer. The `ui` object at the root of `config.json` controls this presentation. It is independent of an agent's model, prompt, tools, cache, and session identity.

```json
{
  "ui": {
    "density": "normal",
    "reasoning": "summary",
    "color": "auto",
    "icons": "auto",
    "theme": "terminal",
    "palette": { "accent": "cyan", "thinking": "magenta" }
  }
}
```

`density` is `compact`, `normal`, or `verbose`. `reasoning` is `hidden`, `summary`, or `full`; when omitted it defaults to `full` with verbose density and `summary` otherwise. Summary is a host activity label, not a model-generated rewrite of the reasoning. `color` is `auto`, `always`, or `never`; `icons` is `auto`, `unicode`, or `ascii`; `theme` is `terminal`, `dark`, or `light`. The default theme uses the terminal's own foreground and basic palette. Flags `--display`, `--reasoning`, `--color`, `--icons`, and `--theme` override the corresponding config settings. Config validation rejects unknown options and palette roles.

The palette accepts semantic roles `accent`, `text`, `muted`, `thinking`, `path`, `code`, `success`, `warning`, `error`, `syntax_keyword`, `syntax_string`, `syntax_number`, `syntax_comment`, `syntax_type`, and `syntax_punctuation`. Values are basic ANSI color names, their `bright_` variants, or `default`. Raw does not accept escape sequences as color names.

Color and animation are terminal features. Redirected streams, `TERM=dumb`, and disabled color remain plain; `NO_COLOR` affects `auto`. A redirected one-shot stdout contains only the assistant's original text plus the conventional final newline. UI labels, tool activity, errors, context, and continuation use stderr. A piped session command prints history to stdout because history is that command's primary output.

The normal view uses semantic icons: brand `◆`, assistant `●`, read `↳`, write `✎`, Bash `$`, skill `◇`, MCP `↗`, success `✓`, failure `✗`, attention `!`, and continuation `↪`. ASCII mode carries the same states with text labels. Success and failure colors supplement these labels. A tool's icon comes from its display hint (`icon`, when the terminal has that symbol), then MCP for config and package MCP tools (`mcp/…` and `<package>#mcp/…`), then its kind: `read` uses the read icon, `edit` the write icon, `execute` the Bash icon, and every other tool the generic `•`.

Each tool call starts with one line, `<icon> <title>  <summary>`, built from the tool's display hints and its normalized arguments ([display hints](tools.md#display-hints)): `$ Run the suite  npm test`, `↳ Read  src/app.ts:10 +20`, `↗ Fixture lookup  x`. A summary that begins with the icon's own glyph drops it, so Bash shows `$ Run command  npm test`, not `$ Run command  $ npm test`. A call that never ran (rejected or interrupted) is marked with the attention icon and also prints its complete display arguments on the next line; file tools show paths and sizes there, never file contents. Verbose density adds the canonical identity in parentheses.

The result follows as `<status> · [+N −M ·] [code ·] <duration>`, where the status is exactly one of `ok`, `error`, `exit N`, `timed out`, `cancelled` or `denied`. `+N −M` sums the changed lines of the files a call edited; the code appears for a failure whose code says more than its status. Then come the preview lines the density allows (none in compact, four in normal, nine in verbose or for a failure). A preview keeps at most nine whole lines: the first and last four around `… [N lines hidden] …`, with any line longer than 220 characters ending in `…`. Bash output appears as its own lines. A JSON result is pretty-printed whole from the largest value-safe reduction that fits its line budget (three times the preview lines, shared by all JSON values of the result, with `… N more JSON values omitted` past it), so it is never cut as text and stays valid JSON; JSON lines are never hard-wrapped; the stored record keeps a reduction of at most 1500 bytes. A code hint shows the result as highlighted code, tagged with its path when the result names one. A Markdown result (declared by the hint, or MCP text that starts with a heading, list, quote or fence) is rendered with the Markdown renderer. A read window is shown as highlighted code tagged with its path.

An approval prompt's headline is the call's title and summary from its normalized arguments, so `{"cmd":"npm test"}` and `{"command":"npm test"}` both ask `Allow Run command  $ npm test?`; the tool name and its display arguments follow, then `[y/N]`.

When both output descriptors refer to the same interactive terminal, Raw may redraw only its unfinished answer line or activity indicator. It clears transient rows before a tool, approval prompt, or error and commits completed answer text once. Separate terminals, redirects, disabled color and dumb terminals use append-only output. Without a shared terminal, a call is one `raw: <title>  <summary> (<name> <arguments>)` line (`raw: ⚠ …` for a call that never ran) and its result `raw: ↳ <name> <status> · [code ·] <duration>` (`✗` on failure), followed by the preview. The default view keeps successful tool previews short; `--display verbose` reveals the bounded retained body and `--display compact` emphasizes the final answer and errors.

Markdown answers support headings, lists, quotes, links, inline code, fenced code, and tables. Known fenced-code languages and structured read-file previews receive syntax highlighting; unknown languages remain plain. Diff signs stay visible. Streaming text appears progressively, including incomplete code fences. Unusually large incomplete blocks may continue as literal text to avoid blocking output. Redirected answers are not reformatted. Tool previews stay bounded and never change tool data sent to the model.

Recognized code languages and path suffixes include JavaScript/JSX, TypeScript/TSX, Python, Bash/sh, JSON/JSONC, YAML, HTML/XML, CSS, SQL, Go, Rust, C/C++, Java, Markdown and diff. Missing or unrecognized labels remain plain code. The renderer processes the current incomplete block rather than replaying the whole conversation; it limits active parser source to 32 KiB and redraws at most 20 rows on a shared terminal. If either bound is exceeded, it streams that block literally until the next stable boundary. Formatting failures have the same plain-text fallback and do not fail the agent run. A redirected answer keeps the original Markdown bytes.

Footer timing and tool counts describe the current turn. Context is an estimate of the current session's prompt/tool/message size, marked `~`; the percentage is shown only when a context window is configured. Token and cache values describe the cumulative session and appear only when provider coverage supports them. Missing cache counters are unknown, not zero. The continuation command uses the active durable session ID.

The normal footer shows `Done`, `Failed`, `Cancelled`, or `Stopped: max steps`, then elapsed time and started tool calls. Current context appears as an approximate count with a percentage and bar when a window is known. When the estimate reaches the configured compact threshold or effective input budget, the warning names that limit; it never changes the compact decision. Session input/output/cache reads appear only when every request reports the field. Verbose mode and REPL `/stats` show reported-request coverage for each field, including cache writes and the already-defined cache-read ratio. No cache miss or money amount is inferred. A resumable session prints its full `raw --resume ID "query"` command after a successful, failed or interrupted turn; startup/persistence failures do not claim resumability. In REPL mode, turn metrics are compact and the full resume command appears on exit.

`raw sessions show ID` and resume-history playback format retained display records using the current UI settings without re-running tools, opening full model payloads or requesting a model response. Display records keep the title, kind and summary projected when the call ran, so history looks the same after the tool is no longer selected. A page that begins with a result still shows that result's saved status; older records without a title or summary fall back to the tool name and a summary of their saved arguments. An alternate `--config` can supply only terminal appearance for history viewing; the selected model's credential is not required for viewing.

The terminal renderer does not affect ACP protocol output. ACP startup does not load the Markdown/highlighting modules; CLI execution and `sessions show` load them only when needed. A theme change does not change the model request, cache key, or session schema.

Developers can inspect fixed, local examples without an API key or config file:

```sh
node scripts/preview-terminal.mjs --width 40 --theme light --icons ascii
node scripts/preview-terminal.mjs --width 80 --theme dark --icons unicode
node scripts/preview-terminal.mjs --width 120 --theme terminal --icons unicode --display verbose
```

Run these in a real terminal to inspect color; redirecting the gallery gives plain text. The gallery uses fixed example records and times, so it does not create sessions or call tools. Newly written display records use session schema 5; older session schemas fail explicitly, with no migration in this development version.
