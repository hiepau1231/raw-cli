// A collapsible JSON tree (docs/tool-ux-design.md §5.3): objects and arrays are disclosures, the first two levels open.
const OPEN_LEVELS = 2;

function JsonValue({ value }: { value: unknown }) {
  const type = value === null ? "null" : typeof value;
  return <span className={`json-${type}`}>{JSON.stringify(value)}</span>;
}

function JsonNode({
  name,
  value,
  depth,
}: {
  name?: string | undefined;
  value: unknown;
  depth: number;
}) {
  const label = name !== undefined && <span className="json-key">{name}: </span>;
  if (value === null || typeof value !== "object")
    return (
      <li>
        {label}
        <JsonValue value={value} />
      </li>
    );
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (!entries.length)
    return (
      <li>
        {label}
        <span className="json-empty">
          {open}
          {close}
        </span>
      </li>
    );
  return (
    <li>
      <details open={depth < OPEN_LEVELS || undefined}>
        <summary>
          {label}
          <span className="json-brace">{open}</span>
          <span className="json-count">
            {" "}
            {entries.length} {Array.isArray(value) ? "items" : "keys"}{" "}
          </span>
          <span className="json-brace">{close}</span>
        </summary>
        <ul>
          {entries.map(([key, item]) => (
            <JsonNode key={key} name={key} value={item} depth={depth + 1} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function JsonTree({ values }: { values: unknown[] }) {
  return (
    <ul className="json-tree" aria-label="JSON result">
      {values.map((value, index) => (
        <JsonNode key={index} value={value} depth={0} />
      ))}
    </ul>
  );
}
