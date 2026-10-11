import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

// Run after capture-side-panel.ts. Renders the approved mockups (docs/design/side-panel/mockups.tsx) at the gallery's
// scale and writes test-results/side-panel/compare-<mockup>-<scheme>.png: the mockup on the left, the dashboard's tab on
// the right, so the two can be compared at the same size. Not a pixel assertion.
const out = "test-results/side-panel";
mkdirSync(out, { recursive: true });
execFileSync("npx", ["tsx", "docs/design/side-panel/mockups.tsx"], { stdio: "inherit" });
const mock = join(out, "mock.html");
renameSync("docs/design/side-panel/mock.html", mock);
/** Mockup shot id → the gallery tab it shows. */
const pairs: Record<string, string> = {
  "frame-tabs": "commands", "frame-overview": "overview", commands: "commands", todo: "todo", files: "files-changed", details: "details",
  steps: "gadget", kvtable: "gadget", question: "question",
};
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(`file://${resolve(mock)}`);
  // The mockups name Inter first and a platform monospace; render them with the dashboard's bundled fonts so sizes compare.
  const fonts = (pkg: string, family: string) => readFileSync(`node_modules/@fontsource-variable/${pkg}/wght.css`, "utf8")
    .replaceAll("url(./files/", `url(file://${resolve(`node_modules/@fontsource-variable/${pkg}/files`)}/`).replace(/font-family: '[^']+'/g, `font-family: '${family}'`);
  await page.addStyleTag({ content: `${fonts("inter", "Inter")}\n${fonts("jetbrains-mono", "Raw Mono")}\n.mono,.cmd,.tail,.diff{font-family:'Raw Mono',monospace!important}` });
  await page.evaluate(() => document.fonts.ready);
  for (const id of Object.keys(pairs)) await page.locator(`#${id} .shot`).screenshot({ path: join(out, `mock-${id}.png`) });
  for (const scheme of ["dark", "light"]) {
    for (const [id, tab] of Object.entries(pairs)) {
      const ours = join(out, `side-panel-${tab}-${scheme}.png`);
      if (!existsSync(ours)) continue;
      const data = (file: string) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
      await page.setContent(`<body style="margin:0;background:#888;display:flex;gap:16px;padding:16px;align-items:flex-start">
        <img src="${data(join(out, `mock-${id}.png`))}" style="width:320px"><img src="${data(ours)}" style="width:320px"></body>`);
      await page.screenshot({ path: join(out, `compare-${id}-${scheme}.png`), fullPage: true });
    }
  }
  console.log(`compared ${Object.keys(pairs).length} mockups`);
} finally {
  await browser.close();
}
