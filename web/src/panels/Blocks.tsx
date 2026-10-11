import { Form } from "./blocks/Form.js";
import { MermaidDiagram } from "../diagrams/MermaidDiagram.js";
import type { PanelBlock, PanelDocument } from "../../../src/panels/contract.js";
import { Checklist } from "./blocks/Checklist.js";
import { Files } from "./blocks/Files.js";
import { KeyValue } from "./blocks/KeyValue.js";
import { PanelMarkdown } from "./blocks/Markdown.js";
import { Progress } from "./blocks/Progress.js";
import { Steps } from "./blocks/Steps.js";
import { Table } from "./blocks/Table.js";
import { Timeline } from "./blocks/Timeline.js";
import { BlockActions, useOffered } from "./actions.js";
import type { InsertRef } from "./status.js";

/** One block. A kind this host does not know shows its `fallback` text, or a plain notice, and never breaks the section. */
function Block({ block, onInsert, hideCompleted }: { block: PanelBlock; onInsert: InsertRef; hideCompleted: boolean }) {
  const b = block as any;
  switch (block.kind) {
    case "checklist": return <Checklist block={block.id} items={b.items} onInsert={onInsert} hideCompleted={hideCompleted} />;
    case "steps": return <Steps block={block.id} items={b.items} />;
    case "progress": return <Progress label={b.label} value={b.value} max={b.max} indeterminate={b.indeterminate} />;
    case "key_value": return <KeyValue entries={b.entries} onInsert={onInsert} />;
    case "table": return <Table block={block.id} title={block.title ?? "Table"} columns={b.columns} rows={b.rows} onInsert={onInsert} />;
    case "markdown": return <PanelMarkdown text={b.text} />;
    case "mermaid": return <MermaidDiagram source={b.source} title={block.title} fallback={block.fallback} />;
    case "timeline": return <Timeline events={b.events} max={b.max} />;
    case "form": return <Form blockId={block.id} fields={b.fields} />;
    case "files": return <Files entries={b.entries} onInsert={onInsert} />;
    default: return <p className="panel-fallback" data-testid="panel-fallback">{block.fallback ?? "This block type is not supported by this dashboard."}</p>;
  }
}
function BlockView({ block, repeats, onInsert, hideCompleted, onHideCompleted }: { block: PanelBlock; repeats: (text: string) => boolean; onInsert: InsertRef; hideCompleted: boolean; onHideCompleted: (value: boolean) => void }) {
  const hasActions = useOffered("block", block.id).length > 0;
  const title = block.title && !repeats(block.title) ? block.title : undefined;
  return (
    <section className="panel-block" data-kind={block.kind}>
      {(title || block.kind === "checklist" || hasActions) && (
        <div className="panel-block-header">
          {title && <h4>{title}</h4>}
          {block.kind === "checklist" && (
            <label className="panel-hide-completed">
              <input type="checkbox" checked={hideCompleted} onChange={(event) => onHideCompleted(event.target.checked)} />
              Hide completed
            </label>
          )}
          <BlockActions block={block.id} label={`Actions for ${block.title ?? block.kind}`} />
        </div>
      )}
      <Block block={block} onInsert={onInsert} hideCompleted={hideCompleted} />
    </section>
  );
}
/**
 * A panel document's blocks. The body never repeats its chrome (docs/tool-ux-design.md §6.1): the document title and block
 * titles show only when they differ from the section title, and in a side-panel section the subtitle is in the header tooltip and the
 * summary in the header. An inline view, which has no such header, shows its subtitle and summary.
 */
export function Blocks({ document, title, inline = false, onInsert, hideCompleted, onHideCompleted }: { document: PanelDocument; title?: string | undefined; inline?: boolean; onInsert: InsertRef; hideCompleted: boolean; onHideCompleted: (value: boolean) => void }) {
  const same = (text: string) => text.trim().toLocaleLowerCase() === title?.trim().toLocaleLowerCase();
  return (
    <>
      {document.title && !same(document.title) && <h4 className="panel-doc-title">{document.title}</h4>}
      {inline && document.subtitle && !same(document.subtitle) && <p className="muted small panel-subtitle">{document.subtitle}</p>}
      {inline && document.summary && <p className="panel-summary">{document.summary}</p>}
      {document.blocks.map((block) => <BlockView key={block.id} block={block} repeats={same} onInsert={onInsert} hideCompleted={hideCompleted} onHideCompleted={onHideCompleted} />)}
    </>
  );
}
