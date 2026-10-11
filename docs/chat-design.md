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

To be written with the header phase.

## 5. Messages

To be written with the messages phase.

## 6. Work

To be written with the Work phase.

## 7. Approval and questions

To be written with the approval phase.

## 8. Composer

To be written with the composer phase.

## 9. Verification

- **Stress session.** `tests/dashboard-ui/chat-stress.ts` runs a real-length session through the mock provider: a long Vietnamese request, reasoning, a todo, a successful command, an edit with a diff, a failing `npm run lint`, an answer with a heading, a table, inline code, a code block with `!==` and `<=`, and a list; a second turn whose write waits for approval; a third with a pending `ask_user` question.
- **Geometry.** `tests/dashboard-ui/chat-layout.spec.ts` asserts the contract of each section at 1440 px (side panel open and closed), 800 px and 390 px, in both themes, plus axe.
- **Gallery.** After `npm run build`, `npx tsx tests/dashboard-ui/capture-chat.ts` writes `test-results/chat/chat-<view>-<scheme>.png`; `npx tsx tests/dashboard-ui/compare-chat.ts` reads the local mockups (`RAW_CHAT_MOCKUPS`, default `test-results/chat-mock/`; it does nothing when they are absent) and writes `test-results/chat/compare-<mockup>-<scheme>.png`, the mockup on the left and the dashboard on the right at the same CSS size. They are compared by eye, not as pixel assertions.
