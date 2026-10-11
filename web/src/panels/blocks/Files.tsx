import { useState } from "react";
import { AtSign, File, FileCode, FileImage, FileJson, FileText, type LucideIcon } from "lucide-react";
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
const absolute = (path: string) => path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);

/**
 * A source-control style file list (docs/tool-ux-design.md §6.3): the file name with its directory muted, `+N −M`, the status
 * letter at the right. A `label` replaces name and directory; a path outside the cwd (absolute) is shown whole and muted. A
 * row with a diff is a button that expands it; the `@` action shows on hover or focus.
 */
export function Files({ entries, onInsert }: { entries: FileEntry[]; onInsert: InsertRef }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  return (
    <ul className="panel-files">
      {entries.map((entry, index) => {
        const key = `${entry.path}:${index}`;
        const expanded = !!entry.diff && open.has(key);
        const outside = absolute(entry.path);
        const split = entry.label === undefined && !outside;
        const cut = split ? Math.max(entry.path.lastIndexOf("/"), entry.path.lastIndexOf("\\")) + 1 : 0;
        const name = (split ? entry.path.slice(cut) : entry.label ?? entry.path) + (entry.line ? `:${entry.line}` : "");
        const Icon = fileIcon(entry.path);
        const counted = entry.added !== undefined || entry.removed !== undefined;
        // Each count shows only when known: a missing one is not a zero.
        const content = (
          <>
            <Icon size={14} aria-hidden="true" className="panel-file-icon" />
            <span className={`panel-file-name${outside ? " outside" : ""}`}>{name}</span>
            {cut > 0 && <span className="panel-file-dir">{entry.path.slice(0, cut)}</span>}
            {counted && (
              <span className="panel-file-stats">
                {entry.added !== undefined && <span className="panel-file-added">+{entry.added}</span>}
                {entry.removed !== undefined && <span className="panel-file-removed">−{entry.removed}</span>}
              </span>
            )}
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
              {entry.status && (
                <span className={`panel-file-status file-${entry.status}`} aria-hidden="true" title={entry.status}>{letter[entry.status]}</span>
              )}
            </div>
            {expanded && <div className="panel-file-diff"><Diff text={entry.diff!} /></div>}
          </li>
        );
      })}
    </ul>
  );
}
