export interface TestRun {
  env: { TMPDIR: string; XDG_CONFIG_HOME: string; XDG_STATE_HOME: string; XDG_DATA_HOME: string };
  cleanup(): void;
}

export function testRun(options?: { signals?: boolean }): TestRun;
