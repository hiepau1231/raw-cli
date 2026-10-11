import { testRun } from "../../scripts/test-tmp.mjs";

// Workers inherit these, so every temp file a spec, fixture or server writes lands in one directory removed at the end.
export default function globalSetup() {
  const run = testRun({ signals: false });
  Object.assign(process.env, run.env);
  return run.cleanup;
}
