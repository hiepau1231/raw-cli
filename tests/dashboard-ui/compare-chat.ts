import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Run after capture-chat.ts. Writes test-results/chat/compare-<mockup>-<scheme>.png: the approved mockup on the left and
// the dashboard's view on the right, both at their CSS size, so the two can be compared. Not a pixel assertion. The
// mockups hold private sample content, so they are not in the repository: keep their PNGs in test-results/chat-mock/
// (ignored), or name the folder in RAW_CHAT_MOCKUPS.
const out = "test-results/chat";
const mockups = process.env.RAW_CHAT_MOCKUPS ?? "test-results/chat-mock";
if (!existsSync(join(mockups, "chat-dark.png"))) {
  console.log(`no mockups in ${mockups}; nothing to compare`);
  process.exit(0);
}
mkdirSync(out, { recursive: true });
/** Mockup image → the gallery views it is compared with. */
const pairs: Record<string, string[]> = {
  "chat-dark": ["desktop-dark"], "chat-light": ["desktop-light"], work: ["work-dark", "work-light"], question: ["question-dark", "question-light"],
  composer: ["composer-dark", "composer-light"], narrow: ["narrow-dark", "narrow-light"],
};
const data = (file: string) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
const browser = await chromium.launch();
let count = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  for (const [mockup, views] of Object.entries(pairs)) {
    const mock = join(mockups, `${mockup}.png`);
    if (!existsSync(mock)) continue;
    for (const view of views) {
      const ours = join(out, `chat-${view}.png`);
      if (!existsSync(ours)) continue;
      // Both are captured at device scale 2: half size is their CSS size.
      await page.setContent(`<body style="margin:0;background:#888;display:flex;gap:16px;padding:16px;align-items:flex-start">
        <img src="${data(mock)}" style="zoom:0.5"><img src="${data(ours)}" style="zoom:0.5"></body>`);
      await page.screenshot({ path: join(out, `compare-${mockup}-${view.split("-").pop()}.png`), fullPage: true });
      count++;
    }
  }
  console.log(`wrote ${count} comparisons`);
} finally {
  await browser.close();
}
