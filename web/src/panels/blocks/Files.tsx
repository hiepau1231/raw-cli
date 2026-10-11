import { useState } from "react";
import { AtSign, ChevronRight, File, FileCode, FileImage, FileJson, FileText, type LucideIcon } from "lucide-react";
import type { FileEntry } from "../../../../src/panels/contract.js";
import { Diff } from "../../tool-cards/ResultBody.js";
import type { InsertRef } from "../status.js";

const letter = { added: "A", modified: "M", deleted: "D", referenced: "R" } as const;
const CODE = /^(c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|kt|mjs|cjs|php|py|rb|rs|scss|sh|sql|swift|ts|tsx|vue|zsh)$/;
function fileIcon(name: string): LucideIcon {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (extension === "json") return FileJson;
  if (/^(png|jpe?g|gif|webp|svg|ico)$/.test(extension)) return FileImage;
  if (CODE.test(extension)) return FileCode;
  if (/^(md|mdx|txt|rst|log)$/.test(extension)) return FileText;
  return File;
}
/** The sum of one count, or undefined when no entry reports it: a missing count is not a zero. */
const total = (entries: readonly FileEntry[], key: "added" | "removed") =>
  entries.some((entry) => entry[key] !== undefined) ? entries.reduce((sum, entry) => sum + (entry[key] ?? 0), 0) : undefined;

/**
 * A review list (docs/side-panel-design.md §6): "N files changed" with the totals and a ratio bar, then per file the status
 * letter, the name in bold, its folder below ("project root" at the session directory), `+N −M` and a chevron when it has a
 * diff. A `label` replaces the name. A row with a diff is a button that expands it; the `@` action shows on hover or focus.
 */
export function Files({ entries, onInsert }: { entries: FileEntry[]; onInsert: InsertRef }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const added = total(entries, "added");
  const removed = total(entries, "removed");
  const ratio = added !== undefined && removed !== undefined && added + removed > 0 ? added / (added + removed) : undefined;
  return (
    <div className="files">
      <div className="files-head">
        <span className="files-count">{entries.length} {entries.length === 1 ? "file" : "files"} changed</span>
        {added !== undefined && <span className="sp-stat added">+{added}</span>}
        {removed !== undefined && <span className="sp-stat removed">−{removed}</span>}
      </div>
      {ratio !== undefined && <span className="files-ratio" aria-hidden="true"><i className="added" style={{ width: `${ratio * 100}%` }} /><i className="removed" /></span>}
      <ul className="panel-files">
        {entries.map((entry, index) => {
          const key = `${entry.path}:${index}`;
          const expanded = !!entry.diff && open.has(key);
          const cut = Math.max(entry.path.lastIndexOf("/"), entry.path.lastIndexOf("\\")) + 1;
          const name = (entry.label ?? entry.path.slice(cut)) + (entry.line ? `:${entry.line}` : "");
          // Paths are relative to the session directory; one outside it is absolute and keeps its whole folder.
          const folder = cut > 0 ? entry.path.slice(0, cut - 1) || entry.path.slice(0, cut) : "project root";
          const Icon = fileIcon(entry.path);
          const content = (
            <>
              {entry.status
                ? <span className={`panel-file-status file-${entry.status}`} aria-hidden="true" title={entry.status}>{letter[entry.status]}</span>
                : <Icon size={14} aria-hidden="true" className="panel-file-icon" />}
              <span className="panel-file-text">
                <span className="panel-file-name">{name}</span>
                <span className="panel-file-dir">{folder}</span>
              </span>
              {(entry.added !== undefined || entry.removed !== undefined) && (
                <span className="panel-file-stats">
                  {entry.added !== undefined && <span className="panel-file-added">+{entry.added}</span>}
                  {entry.removed !== undefined && <span className="panel-file-removed">−{entry.removed}</span>}
                </span>
              )}
              {entry.diff && <ChevronRight size={14} aria-hidden="true" className="panel-chevron panel-file-chevron" />}
              {entry.status && <span className="sr-only">{entry.status}</span>}
            </>
          );
          const toggle = () => setOpen((old) => { const next = new Set(old); if (!next.delete(key)) next.add(key); return next; });
          return (
            <li key={key}>
              <div className="panel-row panel-file-row">
                {entry.diff ? (
                  <button type="button" className="panel-file" aria-expanded={expanded} title={entry.path} onClick={toggle}>{content}</button>
                ) : (
                  <span className="panel-file" title={entry.path}>{content}</span>
                )}
                <button type="button" className="icon-button panel-row-action" onClick={() => onInsert(entry.path)} aria-label={`Insert @${entry.path} into the message`} title={`Insert @${entry.path} into the message`}>
                  <AtSign size={14} aria-hidden="true" />
                </button>
              </div>
              {expanded && <div className="panel-file-diff"><Diff text={entry.diff!} /></div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
