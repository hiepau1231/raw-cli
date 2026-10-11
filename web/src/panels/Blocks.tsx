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
function Block({ block, title, onInsert, hideCompleted }: { block: PanelBlock; title?: string | undefined; onInsert: InsertRef; hideCompleted: boolean }) {
  const b = block as any;
  switch (block.kind) {
    case "checklist": return <Checklist block={block.id} title={title} items={b.items} onInsert={onInsert} hideCompleted={hideCompleted} />;
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
/** " · 1 of 3" for steps (done and skipped count as finished), " · 2 rows" for a table. */
function counted(block: PanelBlock) {
  const b = block as any;
  if (block.kind === "steps" && b.items.length) return ` · ${b.items.filter((step: { status: string }) => step.status === "done" || step.status === "skipped").length} of ${b.items.length}`;
  if (block.kind === "table") return ` · ${b.rows.length} ${b.rows.length === 1 ? "row" : "rows"}`;
  return "";
}
function BlockView({ block, repeats, docTitle, onInsert, hideCompleted, onHideCompleted }: { block: PanelBlock; repeats: (text: string) => boolean; docTitle?: string | undefined; onInsert: InsertRef; hideCompleted: boolean; onHideCompleted?: ((value: boolean) => void) | undefined }) {
  const toggle = block.kind === "checklist" && onHideCompleted;
  const hasActions = useOffered("block", block.id).length > 0;
  const title = block.title && !repeats(block.title) ? block.title : docTitle;
  // A checklist puts its title on the line with its count; steps and tables add theirs to the title (steps.png, kvtable.png).
  const heading = block.kind === "checklist" ? undefined : title && `${title}${counted(block)}`;
  return (
    <section className="panel-block" data-kind={block.kind}>
      {(heading || toggle || hasActions) && (
        <div className="panel-block-header">
          {heading && <h4>{heading}</h4>}
          {toggle && (
            <label className="panel-hide-completed">
              <input type="checkbox" checked={hideCompleted} onChange={(event) => toggle(event.target.checked)} />
              Hide completed
            </label>
          )}
          <BlockActions block={block.id} label={`Actions for ${block.title ?? block.kind}`} />
        </div>
      )}
      <Block block={block} title={block.kind === "checklist" ? title : undefined} onInsert={onInsert} hideCompleted={hideCompleted} />
    </section>
  );
}
/**
 * A panel document's blocks. The body never repeats its chrome (docs/tool-ux-design.md §6.1): the document title and block
 * titles show only when they differ from the section title, and in a side-panel section the subtitle is in the header tooltip and the
 * summary in the header. An inline view, which has no such header, shows its subtitle and summary, and its checklists a
 * "Hide completed" checkbox when given `onHideCompleted` (a section has it in its `⋯` menu instead).
 */
export function Blocks({ document, title, inline = false, onInsert, hideCompleted, onHideCompleted }: { document: PanelDocument; title?: string | undefined; inline?: boolean; onInsert: InsertRef; hideCompleted: boolean; onHideCompleted?: ((value: boolean) => void) | undefined }) {
  const same = (text: string) => text.trim().toLocaleLowerCase() === title?.trim().toLocaleLowerCase();
  const docTitle = document.title && !same(document.title) ? document.title : undefined;
  // A lone untitled checklist (the Todo shape) puts the document title on the line with its count.
  const lone = document.blocks.length === 1 && document.blocks[0]!.kind === "checklist" && !(document.blocks[0]!.title && !same(document.blocks[0]!.title));
  // A lone untitled form (an ask_user question) leads with its state and question (question.png), not the document title.
  const question = document.blocks.length === 1 && document.blocks[0]!.kind === "form" && !document.blocks[0]!.title;
  return (
    <>
      {docTitle && !lone && !question && <h4 className="panel-doc-title">{docTitle}</h4>}
      {inline && document.subtitle && !same(document.subtitle) && <p className="muted small panel-subtitle">{document.subtitle}</p>}
      {inline && document.summary && <p className="panel-summary">{document.summary}</p>}
      {document.blocks.map((block) => <BlockView key={block.id} block={block} repeats={same} docTitle={lone ? docTitle : undefined} onInsert={onInsert} hideCompleted={hideCompleted} onHideCompleted={inline ? onHideCompleted : undefined} />)}
    </>
  );
}
