/** A turn, or a Work group inside a turn: its record ids in order, and the prefix of the key it gets by default. */
export interface KeyUnit {
  ids: string[];
  prefix: string;
}

/**
 * Keys that survive what happens to a unit between renders (docs/chat-design.md §10): records added at its start (an
 * earlier history page) or its end (a live answer), and a split by a new user message. A unit takes the key of the
 * earliest of its records the previous render knew, unless an earlier unit took that key; otherwise prefix + its first id.
 * `next` maps every record to its unit's key, for the next render.
 */
export function assignStableKeys(units: KeyUnit[], previous: ReadonlyMap<string, string>): { keys: string[]; next: Map<string, string> } {
  const taken = new Set<string>();
  const next = new Map<string, string>();
  const keys = units.map((unit, index) => {
    let key = unit.ids.map((id) => previous.get(id)).find((known) => known !== undefined && !taken.has(known));
    if (key === undefined) {
      const base = `${unit.prefix}${unit.ids[0] ?? `#${index}`}`;
      key = base;
      for (let copy = 2; taken.has(key); copy++) key = `${base}~${copy}`;
    }
    taken.add(key);
    for (const id of unit.ids) next.set(id, key);
    return key;
  });
  return { keys, next };
}

/**
 * Splits the timeline's records into turns. A turn starts at your message, and also at a record of an operation the
 * current turn does not hold: an operation can show records (a hook receipt, its live answer) before your message
 * reaches the history. Your message then joins that turn when it holds only its own operation and no message yet, so
 * the turn keeps its key and its live answer stays mounted.
 */
export function splitTurns<T extends { kind: string; operationId?: string | undefined }>(records: readonly T[]): T[][] {
  const turns: T[][] = [];
  let operations = new Set<string>();
  let hasUser = false;
  for (const record of records) {
    const operation = record.operationId;
    const opensOwn = record.kind === "user"
      ? hasUser || !(operation !== undefined && operations.size === 1 && operations.has(operation))
      // History from the terminal has no operation: a dashboard operation after it still opens its own turn.
      : operation !== undefined && !operations.has(operation);
    if (!turns.length || opensOwn) {
      turns.push([]);
      operations = new Set();
      hasUser = false;
    }
    turns.at(-1)!.push(record);
    if (operation !== undefined) operations.add(operation);
    if (record.kind === "user") hasUser = true;
  }
  return turns;
}
