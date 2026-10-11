import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

// Run after capture-side-panel.ts. Renders the approved mockups at the gallery's scale and writes
// test-results/side-panel/compare-<mockup>-<scheme>.png: the mockup on the left, the dashboard's tab on the right, both at
// their CSS size, so the two can be compared. Not a pixel assertion. The mockups hold private sample content, so they are
// not in the repository: put their `mockups.tsx` in test-results/side-panel-mock/ (ignored), or name the folder in
// RAW_SIDE_PANEL_MOCKUPS.
const out = "test-results/side-panel";
const mockups = process.env.RAW_SIDE_PANEL_MOCKUPS ?? "test-results/side-panel-mock";
if (!existsSync(join(mockups, "mockups.tsx"))) {
  console.log(`no mockups in ${mockups}; nothing to compare`);
  process.exit(0);
}
mkdirSync(out, { recursive: true });
execFileSync("npx", ["tsx", join(mockups, "mockups.tsx")], { stdio: "inherit" });
const mock = join(out, "mock.html");
renameSync(join(mockups, "mock.html"), mock);
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
        <img src="${data(join(out, `mock-${id}.png`))}" style="zoom:0.5"><img src="${data(ours)}" style="zoom:0.5"></body>`);
      await page.screenshot({ path: join(out, `compare-${id}-${scheme}.png`), fullPage: true });
    }
  }
  console.log(`compared ${Object.keys(pairs).length} mockups`);
} finally {
  await browser.close();
}
