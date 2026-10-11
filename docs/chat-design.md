# Chat design

This document owns how the dashboard's frame and main chat area look: the backdrop and the main card, the chat header, messages, Work groups and tool rows, approval and question cards, and the composer. The side panel's contents are owned by [side-panel-design.md](side-panel-design.md); behaviour (sending, history, approvals, compaction) by [dashboard.md](dashboard.md) and [dashboard-composer-design.md](dashboard-composer-design.md); tool display hints by [tool-ux-design.md](tool-ux-design.md).

The approved mockups are kept outside the repository: they were drawn with private sample content. They are the visual reference (sizes, padding, radii and colours are taken from their CSS) and are named here by view: `chat-dark`, `chat-light`, `work`, `question`, `composer`, `narrow`. The gallery (§9), captured from a neutral stress session, shows the result.

## 1. Why it changed

The chat looked like a stack of forms next to a side panel that had been redesigned:

- **Rules everywhere.** Full-height rules divided the rail, the session list, the chat and the side panel, and full-width rules divided the toolbar, the header and the tab strip, so the screen read as a grid of boxes rather than one place to work.
- **Two header rows.** A 58 px toolbar (breadcrumb, search, Activity) sat over a header with a 20 px title, the full temporary path and the agent.
- **Heavy messages.** Each user message was a bordered card labelled "You"; every tool call was another bordered box; panel receipts looked like more tools.
- **Raw output.** Terminal previews showed the server's `[stdout]`, `[stderr]` and `[exit N · t]` markers; "Saved preview" and "Arguments" were bare links.
- **Repetition.** A pending `ask_user` question appeared three times (a tool row waiting for its result, the question, and "Waiting for your answer"); context usage appeared twice under the composer.
- **Code ligatures** turned `!==` and `<=` into single symbols.

## 2. Visual language

The chat uses the side panel's language ([side-panel-design.md](side-panel-design.md) §2): the bundled OFL fonts Inter and JetBrains Mono only, chips with tinted backgrounds and a word for every status, cards with a 1 px border and 10 px radius, monospace only for commands, paths and code, with ligatures off. Chat prose is 15 px at line height 1.65; secondary text 11 to 12.5 px muted.

## 3. Frame

There are no full-height or full-width rules. Regions are separated by tone and by one rounded card (the `chat-dark` and `chat-light` mockups):

- **Backdrop.** The app shell has a backdrop darker than the canvas (`--backdrop`: `#07060b` dark, `#eeecf3` light) with 8 px padding at the top and bottom. The rail, the workspace sidebar (workspace button, New chat, search, sessions) and the side panel sit directly on it: no background of their own and no border.
- **The card.** The main area is the only card: the canvas colour, a 1 px `--frame` border (`#211b2d` dark, `#e4e1ea` light), a 14 px radius, and in the light theme a soft shadow (`0 1px 2px rgba(20,12,40,.05), 0 4px 14px rgba(20,12,40,.04)`). On a chat it holds the header, the conversation and the composer; on other pages it holds the toolbar and the page. The side panel is outside the card, so the chat sits between two matching sides; with the side panel closed the card reaches the right padding.
- **Spacing.** The sidebar's content and the side panel's content are each 16 px from the card.
- **One centre line.** The workspace button (52 px high, its top on the card's top edge), the chat header (52 px), the side panel's title row (52 px) and the rail's logo share one centre line, 35 px below the top of the shell.
- **Selection on the backdrop.** The hover tint is too close to the light backdrop, so the selected session row and the active rail item use the canvas colour with a 1 px shadow in the light theme; the search field and the workspace button keep their border.
- **Side panel tabs** are a segmented control: a strip with a 10 px radius and 3 px padding (dark `--seg`; light translucent white with a 1 px `--frame` ring), tabs with a 7 px radius, the selected tab raised on `--seg-on` with a small shadow. No underline and no rule under the strip. Dragging, keyboard movement, overflow scrolling and badges are unchanged.
- **Resizing.** The sidebar and side panel resize handles sit in the gaps beside the card, invisible until hovered or focused (an accent line).
- **Narrow windows.** Below 900 px the sidebar is the drawer it was and the side panel the modal it was, both in the backdrop colour. Below 600 px the frame is full-bleed: no backdrop padding, the card has no radius or border (the `narrow` mockup), and the horizontal rail keeps its contents and layout on the backdrop colour without a bottom rule; the change of tone separates it from the chat.

## 4. Header

On a chat the app toolbar is not shown: the chat header is the card's first row and carries the toolbar's controls (the `chat-dark`, `chat-light` and `narrow` mockups). Other pages, and `/chat` before a session is open, keep the toolbar inside the card.

- **One row,** 52 px high, 18 px left and 14 px right padding, no rule under it. Its centre is the frame's centre line (§3).
- **Left to right:** "Workspace menu" (below 900 px only, opens the drawer); the session title (15 px, weight 600, one line with an ellipsis, the whole title in its tooltip); the agent as a muted chip; the workspace path (12 px muted, `~/…` under the home directory once the workspace listing reports it, otherwise the full path; the full path in its tooltip); then icon buttons with an 8 px radius, 32 px (the mockup's 30 px raised to the dashboard's minimum target size): Quick navigation (⌘K), Activity (warning colour while an approval waits, the count of running operations as a badge), Side panel (tinted while the side panel is open, `aria-expanded`) and More actions (agent, rename, Copy workspace path, delete).
- **Below 600 px** the agent chip, the path and Quick navigation are hidden; the path stays in the title row's More actions → Copy workspace path, and ⌘K still opens Quick navigation.
- **Width.** The conversation column and the composer are 720 px at most with 28 px at the sides (14 px below 600 px), centred in the card.

## 5. Messages

- **Your messages** are bubbles on the right of the column (`--bubble`: `#1e1930` dark, `#f1eff6` light), 78 % of the column at most, an 18 px radius, 10 px by 15 px padding, line height 1.55. Attachments sit inside the bubble above the text. There is no "You" label: the time and **Copy message** sit under the bubble and appear on hover or keyboard focus (always on touch screens).
- **The assistant's messages** start with a 20 px "r" mark on the accent tint, **Raw** and the time (12.5 px), then the answer as prose, then **Copy message** under it. "Incomplete response" stays under an interrupted message.
- **Prose** is the Chat font size (15 px by default) at line height 1.65; paragraphs 10 px apart; headings at weight 650 (19, 17 and 15 px for levels 1 to 3); lists indented 20 px; inline code in the Code font size (13 px by default) on a tint with a 5 px radius.
- **Tables** are one box with a 1 px border and a 10 px radius that scrolls sideways when it is wide: muted 12 px headers at weight 600, 13.5 px cells, a rule under each row but the last and no inner vertical rules.
- **Code blocks** have a 10 px radius and a header row with the language (11.5 px, muted) and a **Copy** button (named "Copy code" for assistive technology); the code is in the Code font size at line height 1.6.
- **Ligatures are off for all code** in the dashboard, so `!==` and `<=` read as typed.
- **Scope.** This typography, the table box and the code header belong to chat messages. Markdown elsewhere (a Library preview, a side panel markdown block) keeps its look; only the ligature rule is global.
- **Sizes.** The Chat font size and Code font size settings default to 15 px and 13 px; a size you chose is kept.

## 6. Work

- **The summary line.** A turn's reasoning and tool calls form one group with a 13 px summary line: a chevron, **Worked 0.3s** (weight 550; **Working** with a spinner at the right end while the turn runs), `· 4 tools` muted (`· Reasoning` when there are no calls), a `1 failed` error chip when calls failed (an exit other than 0, a timeout, a denial, a cancellation, an error, an unknown outcome), and a `Needs approval` warning chip while a call waits. At the right, one pill per panel the group updated opens that panel in the side panel: Files changed as `+4 −1`, the lines this group's file changes added and removed (the panel's own summary counts the whole session); a checklist as `Todo 1/3` from its latest update; another panel as its latest title; a rejected update as an error pill with the panel's name.
- **Opening.** A group opens when you toggle it, or by the **Show reasoning** and **Show tool details** preferences. It does not open by itself while it runs or when a call fails: the summary line carries those states. A call waiting for approval keeps its group open, because its Allow once and Deny are in the call's card. Your toggle is kept per group.
- **Rows** sit on a 1 px rule, 16 px in. Reasoning is a muted italic line with a brain glyph that ends in an ellipsis and opens to the full text. Each call is one row, 30 px high, with an 8 px radius and a hover tint: a 14 px status glyph (check, x, spinner, shield for approval, ban for denied or cancelled, clock for timed out) whose state is also accessible text, the title (13 px, weight 550), the summary (12 px monospace, muted, ellipsis), then at the right the lines added and removed by a file change, a pill per other panel the call updated (`1 of 3 done ↗`), a chip only for states other than OK (`Exit 1`, `Timed out`, `Denied`), the duration (11.5 px) and a chevron. At 390 px the summary is hidden so the row stays one line.
- **Cards.** Opening a row shows a card under it (10 px radius, the side panel's card colour, an error border for a failed call). Failed calls start open, and every call does with **Show tool details**. A command's output is on the code background (12 px, line height 1.6, at most 16 lines before it scrolls): the `[stdout]`/`[stderr]` markers are removed, stderr lines are in the error colour, and the footer says `stderr · exit 1 · 0.1 s`; the channel is left out when a hidden-lines notice hides where the visible lines came from. A diff uses the side panel's colours, without its file headers; the footer names the file. Other results keep their bodies. The footer has **Copy** (output or diff), **Full output** when a full copy was saved, and **Arguments**, which opens the exact arguments above the footer. A display abbreviation, a tool-truncated result and a result code show as muted footer text. A running command shows no body but a line linking to Commands, where its live output is.
- **Receipts.** A call's panel updates are pills on its row and in the summary line, never rows of their own. An update without a call in the group (an action you ran from a panel, tagged *You*) is a pill row of its own.

## 7. Approval and questions

To be written with the approval phase.

## 8. Composer

To be written with the composer phase.

## 9. Verification

- **Stress session.** `tests/dashboard-ui/chat-stress.ts` runs a real-length session through the mock provider: a long Vietnamese request, reasoning, a todo, a successful command, an edit with a diff, a failing `npm run lint`, an answer with a heading, a table, inline code, a code block with `!==` and `<=`, and a list; a second turn whose write waits for approval; a third with a pending `ask_user` question.
- **Geometry.** `tests/dashboard-ui/chat-layout.spec.ts` asserts the contract of each section at 1440 px (side panel open and closed), 800 px and 390 px, in both themes, plus axe.
- **Gallery.** After `npm run build`, `npx tsx tests/dashboard-ui/capture-chat.ts` writes `test-results/chat/chat-<view>-<scheme>.png`; `npx tsx tests/dashboard-ui/compare-chat.ts` reads the local mockups (`RAW_CHAT_MOCKUPS`, default `test-results/chat-mock/`; it does nothing when they are absent) and writes `test-results/chat/compare-<mockup>-<scheme>.png`, the mockup on the left and the dashboard on the right at the same CSS size. They are compared by eye, not as pixel assertions.
