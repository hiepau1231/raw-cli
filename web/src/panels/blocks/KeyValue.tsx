import type { KeyValueEntry } from "../../../../src/panels/contract.js";
import { Ref, type InsertRef } from "../status.js";

/** Facts as a stack (kvtable.png): the key muted above its value; a reference is a file chip with its folder. */
export function KeyValue({ entries, onInsert }: { entries: KeyValueEntry[]; onInsert: InsertRef }) {
  return (
    <dl className="panel-kv">
      {entries.map((entry, index) => (
        <div key={`${entry.key}:${index}`}>
          <dt>{entry.key}</dt>
          <dd>
            {entry.value && <span className="panel-kv-value">{entry.value}</span>}
            {entry.ref && <span className="panel-kv-ref"><Ref value={entry.ref} onInsert={onInsert} folder /></span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
