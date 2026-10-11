# Side panel design

This document owns how the dashboard side panel looks and behaves. It replaces the layout parts of [panels-design.md](panels-design.md) §13.1 (the stack of accordion sections) and [tool-ux-design.md](tool-ux-design.md) §6 (the VS Code-style rows). The panel contract, block kinds, HTTP routes, stream frames and opening rules of §13.1 are unchanged.

The approved mockups are in [design/side-panel/](design/side-panel/) (`frame-tabs.png`, `frame-overview.png`, `commands.png`, `todo.png`, `files.png`, `details.png`, `steps.png`, `kvtable.png`, `question.png`; source `mockups.tsx`). They are the visual reference.

## 1. Why it changed

The accordion stack put every panel in one column of 28 px headers and 24 px rows that shared the height. In use it failed in three ways:

- **Nothing was readable at the default width.** Rows wrapped at 320 px, so a status glyph sat on one line and its label on the next; key/value pairs and tables broke mid-word.
- **Heights froze.** Shares were measured only when the layout changed, so a section that grew kept a stale height: Commands showed 132 px of 178 px of content, and Todo got 460 px for 420 px.
- **Rows did not explain anything.** A command was a one-line row behind a toggle, and a reader had to open each one to learn what failed and why.

The new design gives each panel the full height in its own tab, and presents each kind of content as cards made for scanning: what is running, what failed, what is next.

## 2. Visual language

The side panel follows the rest of the dashboard (the OpenAI/ChatGPT-like look of the session list and chat), not VS Code:

- Inter, 13 px labels at weight 500 to 600, 11 to 12 px muted secondary text, 11 px uppercase group labels with 0.8 px tracking (`.group-label`).
- Cards: 1 px `--border`, 10 px radius, `--panel` background, 10 to 12 px padding. Rows inside cards use the inset hover of `.session-row`.
- Chips for status: 11 px, weight 600, pill radius, tinted backgrounds derived from `--accent`, `--success`, `--warning` and `--error` in both themes. Status is never colour-only: every chip has a word or a glyph with an accessible name.
- Monospace (`--mono`) only for commands, output and paths in code.

## 3. Frame: Overview and tabs

The side panel has a compact title row (Side panel, close) and a **tab strip** under it:

1. **Overview**, always first.
2. One tab per visible panel, in the stored per-agent order (the insertion rule of §13.1 is unchanged): declared tool panels, Commands, plugin and MCP panels.
3. **Details**, always last.

Overview and Details cannot be moved or hidden.

- **Tabs.** The active tab shows its icon and label; inactive tabs show their icon and badge, and the label in their tooltip and accessible name. The strip scrolls horizontally when it overflows. An unseen dot marks a panel updated since it was last viewed.
- **Badges.** Checklist progress `done/total`; files: the file count; Commands: the running count (accent), else the failed count (error), else the total; Details: the context use in percent (warning from 80 %, error from 95 %); other panels: `done/total` when the document reports progress. A done or failed document shows a small status glyph instead; there is no text pill. Closed and Stale show as a muted chip in the Overview card and the tab header.
- **Keyboard.** WAI-ARIA tabs with manual activation: arrow keys, `Home` and `End` move focus between tabs, `Enter` or `Space` selects. Tab moves into the active panel.
- **Reorder and hide.** Drag a tab along the strip, or use **Move left**, **Move right** and **Hide tab** in the tab header's `⋯` menu. Order and hidden tabs are stored per agent as before.
- **Overview.** One card per visible panel: icon, title, status on the right (badge, chips, `+a −r`), up to two key lines from the panel's content (the todo item in progress; the running and failed commands; file totals and names; the current step; else the summary), and a thin progress bar when progress exists. Details appears as a Context card. Clicking a card selects its tab. Hidden panels are listed in a final row, "N hidden", that shows them again.
- **Tab content.** A header row with the full title, a muted summary and the `⋯` menu (panel actions, Hide completed for checklists, Move left/right, Hide tab), then the stale banner and rejected-update notice, then the content, scrolling inside the remaining height. There is no height sharing and no divider.

### 3.1 What stays from §13.1

- **Updates never move the reader.** An update never switches the active tab, never moves focus and never scrolls the active tab's content. It changes badges, Overview cards and the unseen dot.
- **Active tab.** Stored per session in the browser; Overview by default.
- **Follow the tool.** When a panel declared `first_update` receives its first revision and its tab is not hidden, the side panel opens once per session without moving focus. It selects that panel's tab only when Overview is the active tab, so it never takes the user away from a panel they chose.
- **Receipts.** Clicking a receipt opens the side panel, unhides the panel's tab and selects it.
- **Seen.** A panel counts as seen when its tab is active and the side panel is open; Overview marks nothing seen.
- Announcements, stale and rejected states, panel and item actions, Hide completed, `@` insertion, the narrow drawer and the per-agent stack are unchanged.

### 3.2 Browser storage

`raw.dashboard.panels.v1` keeps `order`, `hidden` (per agent), `seen`, `opened` and `hideCompleted`, and gains `tab` (per session: the selected tab id). The fields `heights` and `expanded` of earlier versions are ignored when loaded and are no longer written. Corrupt or foreign data falls back to defaults field by field.

## 4. Commands

One card per command, newest first by start time ([commands.png](design/side-panel/commands.png)).

- **Filter.** Chips `All N`, `Running N`, `Failed N` (failed includes timed out and lost), stored per session. An empty filter shows a short note and keeps the chips. The chip counts cover the listed rows; "Older commands not shown" closes the list when the server cut older ones.
- **Running card.** Accent border, a `Running` chip with a spinner and the ticking duration, the call's description as the title (else the command), the command line in monospace with an ellipsis and the full text in `title`, the last three output lines for foreground Bash, and a footer: start time, foreground or background, **Output**, and **Stop for background jobs only**. Foreground Bash stops with the turn's Stop in the composer, because per-command Stop exists only for supervisor-managed processes.
- **Failed card.** Error border, an `Exit N` chip, duration and time, title, command, the last error lines, **Copy** and **Output**.
- **Timed out, stopped, lost.** One compact card with its own chip.
- **Succeeded.** One compact line: check glyph, title with ellipsis, duration; the command as a muted second line when the title is the description. Activating a compact card shows the whole card, opens its output and moves focus to its **Output** button.
- **Cards in use stay put.** A card whose output is open, that holds focus, that is stopping or that shows a notice stays in the current filter after its state changes, and leaves it only when it is no longer in use. New cards inserted above keep the reader's scroll anchor.
- **Output** opens the terminal frame inside the card (auto-follow, Copy output, Load more, full output and `@`). Background output is read through the process control only after Output is opened; there is no live tail for background jobs because every read of their output is policy-checked and audited.
- **Tail.** Foreground command records carry `tail`: the last three non-empty lines, each with its channel, terminal control sequences removed, a carriage return keeping only what follows it (progress bars), 160 bytes per line and 512 bytes in all, refreshed whenever the record is saved ([dashboard-api.md](dashboard-api.md)). A failed card highlights stderr lines.

## 5. Todo (checklist blocks)

([todo.png](design/side-panel/todo.png))

- A header line "N of M done" (with the document title when it differs from the tab title) and a progress bar.
- **Groups by top-level subtree,** so hierarchy is never split: an item goes to **Now** when it or any descendant is in progress; else to **Next** when it or any descendant is unfinished (pending, blocked, failed); else to **Completed** (the whole subtree done or skipped).
- **Now** is a highlighted card: the active item's spinner glyph, its full label (wrapping allowed) and its note. A done parent shows its in-progress child under it.
- **Next** items keep the glyph on the first line and clamp labels to two lines with the full text in `title`. Blocked and failed show their colour and status word.
- **Completed** is one toggle row, "Completed N · skipped M", whose open state is kept per panel.
- **Hide completed** hides the Completed row and finished items inside unfinished subtrees, never an unfinished item.
- The primary status action, item `⋯` actions, priority tag and ref chip are kept.

## 6. Files changed (files blocks)

([files.png](design/side-panel/files.png))

- A summary line "N files changed" with `+a −r` (each only when known) and a ratio bar when both are known.
- Rows: a coloured status letter (A, M, D, R), the file name in bold with an ellipsis, its folder on a muted second line ("project root" for the session directory; `~/…` or the absolute path outside it), `+N −M`, and a chevron when a diff exists. Clicking opens the diff inline (400 px at most, scrolling); `@` on hover or focus inserts the path. A footer appears only when older history was omitted.

## 7. Details

([details.png](design/side-panel/details.png))

- **Context card.** Tokens in large type (`6.9k / 8.2k tokens`), the percent chip and a bar coloured by fill (warning from 80 %, error from 95 %), then retained messages, whether a summary exists and the auto-compact trigger; **Compact now** when available.
- **Usage card.** Last turn and session totals, with rows only for reported values; one note when the provider reports no token counts; cache coverage when measured.
- **Summary card** when a summary exists (expandable, copyable).
- **Continue in terminal** with the copyable resume command.
- **Session paths** (ID, workspace, config, model, attached capabilities) in a final card. Nothing Details shows today is dropped; unreported values are covered by the note.

## 8. Plugin blocks

([steps.png](design/side-panel/steps.png), [kvtable.png](design/side-panel/kvtable.png))

- **Steps.** A vertical stepper with a connecting line, the glyph on the first line, the current step bold with its detail and `aria-current="step"`, the duration muted on the right.
- **Progress.** Label (ellipsis and `title`) and `value / max` on one line, a 6 px bar; indeterminate bars animate unless reduced motion is set.
- **Timeline.** Newest first, a coloured level dot (with the level as hidden text), relative time above the label, detail below.
- **Key/value.** The muted key above the value; values wrap at word boundaries; a ref is a file chip `name:line` with the full path in `title`, inserting `@path`.
- **Table.** Narrower than 420 px (always in the side panel, whose maximum width is 360 px), each row is a card: status glyph, the first column as title, the others as `Label: value`, ref chip, actions. From 420 px (inline chat views) a compact table with single-line cells, ellipsis and `title`. Never wider than its container.
- **Markdown.** 13 px prose; code blocks scroll inside.
- Unknown kinds keep their fallback text.

## 9. Questions (`ask_user` and form blocks)

([question.png](design/side-panel/question.png))

- Single-select options as radio cards, multi-select as checkbox cards, **Other…** as an inline text field when allowed, text fields full width.
- **Skip** (cancel) secondary and **Send answer** primary; a status chip "Waiting for you", "Answered" or "Cancelled".
- Byte limits appear only as a validation error. Submission, idempotency, disabled states and acknowledgements are unchanged.
- Inline chat views use the same renderers at chat width.

## 10. Verification

- A stress session (`tests/dashboard-ui/side-panel-stress.ts`) with long Vietnamese todo items, deep paths, failing and streaming commands, a background job, a plugin panel with every block kind and a question.
- Geometry specs at 320 px and 360 px, light and dark, asserting the measured container width: no horizontal overflow, glyphs on the first text line, truncated text with its full value in `title` or the accessible name.
- A gallery (`tests/dashboard-ui/capture-side-panel.ts`) writes one image per tab to `docs/dashboard/side-panel-*.png`; each is compared with its mockup by eye in review. These are not pixel assertions.
