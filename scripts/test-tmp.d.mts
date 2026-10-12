export interface TestRun {
  env: { TMPDIR: string; TEMP?: string; TMP?: string; WT_SESSION?: string; XDG_CONFIG_HOME: string; XDG_STATE_HOME: string; XDG_DATA_HOME: string };
  cleanup(): void;
}

export function testRun(options?: { signals?: boolean; platform?: NodeJS.Platform }): TestRun;
