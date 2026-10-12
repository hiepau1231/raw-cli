import { useEffect, useState } from "react";
import { ChevronRight, Lock, Plus, Search } from "lucide-react";
import { mutate } from "swr";
import type { ComponentInfo } from "../../../../src/management/components.js";
import { api, errorText } from "../../api.js";
import { keys } from "../../data/keys.js";
import { Link, useRouter } from "../../router.js";
import { Empty, ErrorMessage, Field, Modal } from "../../ui.js";

/** The chat sidebar's search field, for a Library list. */
export function ListSearch({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="search-input list-search">
      <Search size={16} aria-hidden="true" />
      <input type="search" aria-label={label} placeholder={`${label}…`} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** "Used by N" as a chip, anything else ("Not selected", "Usage unavailable") as muted text. */
export function UsageLabel({ used, children }: { used: boolean; children: string }) {
  return <span className={used ? "sp-chip tone-accent component-row-usage" : "muted component-row-usage"}>{children}</span>;
}

/** The › a linked row shows on hover or focus. */
export const RowChevron = () => (
  <span className="row-chevron" aria-hidden="true">
    <ChevronRight size={16} />
  </span>
);

export type ComponentKind = "tools" | "skills" | "hooks";

export const kindCopy: Record<ComponentKind, { title: string; singular: string; description: string }> = {
  tools: { title: "Tools", singular: "tool", description: "Functions an agent can call. Inspection never runs them." },
  skills: { title: "Skills", singular: "skill", description: "Instructions an agent can load when it needs them." },
  hooks: { title: "Hooks", singular: "hook", description: "Checks that run around tool calls. Inspection never runs them." },
};

export const sourceLabel: Record<ComponentInfo["source"], string> = {
  builtin: "Builtin",
  local: "Local",
  agent: "Agent",
  package: "Package",
  linked: "Linked",
};

export function ComponentsList({
  kind,
  items,
  error,
  onRetry,
}: {
  kind: ComponentKind;
  items: ComponentInfo[];
  /** A failed refresh while cached rows are still shown. */
  error?: string;
  onRetry?: () => void;
}) {
  const copy = kindCopy[kind];
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const query = filter.trim().toLowerCase();
  const visible = items.filter((item) =>
    `${item.id} ${item.name} ${item.description}`.toLowerCase().includes(query),
  );
  const create = (
    <button className="primary" onClick={() => setCreating(true)}>
      <Plus size={16} aria-hidden="true" />
      Create {copy.singular}
    </button>
  );
  return (
    <div className="management-page">
      {error && (
        <ErrorMessage>
          Could not refresh {kind}. {error}{" "}
          <button className="text-button" onClick={onRetry}>
            Try again
          </button>
        </ErrorMessage>
      )}
      {items.length ? (
        <>
          <header className="resource-header">
            <div>
              <h1>{copy.title}</h1>
              <p className="muted">{copy.description} Builtins and packages are read-only; fork them to customize.</p>
            </div>
            {create}
          </header>
          <ListSearch label={`Search ${kind}`} value={filter} onChange={setFilter} />
          {visible.length ? (
            <ul className="data-table" aria-label={`${copy.title} catalog`}>
              {visible.map((item) => (
                // The whole row opens the component (the name link covers it); the detail page shows the diagnostic.
                <li key={item.id} className="data-row component-row linked">
                  <div className="component-row-name">
                    <Link className="row-link" href={`/library/${kind}/${encodeURIComponent(item.id)}`}>{item.id}</Link>
                    {item.description && <span className="muted component-row-description">{item.description}</span>}
                  </div>
                  <div className="metadata component-row-badges">
                    <span className="badge">
                      {item.readOnly && <Lock size={11} aria-hidden="true" />}
                      {sourceLabel[item.source] ?? item.source}
                      {item.readOnly && <span className="sr-only"> (Read-only)</span>}
                    </span>
                    {item.validation !== "valid" && <span className="badge error">Invalid</span>}
                  </div>
                  <UsageLabel used={item.usageAvailable && item.usedBy.length > 0}>
                    {!item.usageAvailable
                      ? "Usage unavailable"
                      : item.usedBy.length
                        ? `Used by ${item.usedBy.length}`
                        : "Not selected"}
                  </UsageLabel>
                  <RowChevron />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted catalog-no-results">
              No {kind} match “{filter.trim()}”.{" "}
              <button className="text-button" onClick={() => setFilter("")}>
                Clear search
              </button>
            </p>
          )}
        </>
      ) : (
        <Empty title={`No ${kind} yet`} action={create}>
          {copy.description}
        </Empty>
      )}
      <CreateComponentDialog kind={kind} items={items} open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function CreateComponentDialog({
  kind,
  items,
  open,
  onOpenChange,
}: {
  kind: ComponentKind;
  items: ComponentInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { navigate } = useRouter();
  const examples = items.filter((item) => item.source === "builtin").map((item) => item.id);
  const [folder, setFolder] = useState("");
  const [template, setTemplate] = useState(
    kind === "tools" ? "builtin/read_file" : kind === "skills" ? "builtin/create_skill" : "",
  );
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setFolder("");
    setError("");
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Create ${kindCopy[kind].singular}`}
      description={
        kind === "hooks"
          ? "Create a hook manifest and script, then select it on an agent."
          : "Start from a shipped example. The new component stays unselected until you attach it."
      }
    >
      <ErrorMessage>{error}</ErrorMessage>
      <Field label="Component folder">
        <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="my_component" />
      </Field>
      {kind !== "hooks" && (
        <Field label="Example">
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            {examples.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </Field>
      )}
      <div className="actions">
        <button
          className="primary"
          disabled={!folder || (kind !== "hooks" && !template)}
          onClick={() => {
            void api(
              `/components/${kind}`,
              "POST",
              kind === "hooks"
                ? {
                    id: `local/${folder}`,
                    files: {
                      "hook.json": JSON.stringify({ protocol_version: 2, name: folder, events: [{ name: "PreToolUse", match: "builtin/bash" }],
                        command: "node", args: ["./index.mjs"], timeout_ms: 5000 }, null, 2) + "\n",
                      "index.mjs": "let input = '';\nprocess.stdin.on('data', chunk => input += chunk);\nprocess.stdin.on('end', () => {\n  const event = JSON.parse(input);\n  process.stdout.write(JSON.stringify({ decision: 'continue' }));\n});\n",
                    },
                  }
                : { id: `local/${folder}`, cloneFrom: template },
            ).then(
              async () => {
                // The list and the sidebar's count read this catalog; the detail page does not refetch it.
                await mutate(keys.components(kind));
                onOpenChange(false);
                navigate(`/library/${kind}/${encodeURIComponent(`local/${folder}`)}`);
              },
              (cause) => setError(errorText(cause)),
            );
          }}
        >
          {kind === "hooks" ? "Create hook" : "Create from example"}
        </button>
      </div>
    </Modal>
  );
}
