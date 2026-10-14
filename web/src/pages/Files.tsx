import { useMemo, useState } from "react";
import { ChevronRight, FileImage, FileText, Folder, FolderOpen, Search } from "lucide-react";
import { useWorkspaceFiles } from "../data/queries.js";
import { buildTree, countFiles, fileKind, filterTree, type TreeFolder } from "../files/tree.js";
import { usePageGate } from "../states.js";
import { Empty } from "../ui.js";

/** One folder's children: folders first, then files, with each branch rendered only while it is open. */
function FolderRows({ node, open, toggle, forced }: { node: TreeFolder; open: ReadonlySet<string>; toggle: (path: string) => void; forced: boolean }) {
  return (
    <ul className="files-tree-list">
      {node.folders.map((folder) => {
        const expanded = forced || open.has(folder.path);
        const Glyph = expanded ? FolderOpen : Folder;
        return (
          <li key={folder.path} className="files-tree-item">
            <button type="button" className="files-tree-row" data-folder={folder.path} aria-expanded={expanded} onClick={() => toggle(folder.path)}>
              <ChevronRight size={14} aria-hidden="true" className="files-tree-chevron" />
              <Glyph size={14} aria-hidden="true" />
              <span className="files-tree-name">{folder.name}</span>
            </button>
            {expanded && <FolderRows node={folder} open={open} toggle={toggle} forced={forced} />}
          </li>
        );
      })}
      {node.files.map((file) => {
        const Glyph = fileKind(file.path) === "image" ? FileImage : FileText;
        return (
          <li key={file.path} className="files-tree-item">
            <button type="button" className="files-tree-row" data-file={file.path} title={file.path}>
              <Glyph size={14} aria-hidden="true" />
              <span className="files-tree-name">{file.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The Files tab (docs/files-tab-spec.md): a read-only tree of the selected workspace with a filter. The listing is
 * the same git-aware view the agent's `@` references use, so the two never disagree about what exists.
 */
export function FilesPage({ workspace }: { workspace: string }) {
  const { data, error, mutate } = useWorkspaceFiles();
  const gate = usePageGate({ ready: !!data, error, onRetry: () => void mutate(), label: "Loading files" });
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(() => buildTree((data?.entries ?? []).map((entry) => entry.path)), [data]);
  const shown = useMemo(() => filterTree(tree, query), [tree, query]);
  const filtering = query.trim() !== "";
  const matches = countFiles(shown);
  const toggle = (path: string) => setOpen((old) => {
    const next = new Set(old);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  if (gate || !data) return gate;
  const listing = data;
  return (
    <div className="files-page">
      <header className="page-header">
        <h1>Files</h1>
        <span className="workspace-path" title={workspace}>
          {workspace}
        </span>
      </header>
      {listing.total === 0 ? (
        <Empty title="This workspace has no files">
          The agent sees the same view through @ references, so there is nothing here to point it at.
        </Empty>
      ) : (
        <>
          <label className="search-input files-filter">
            <Search size={14} aria-hidden="true" />
            <input
              aria-label="Filter files"
              placeholder="Filter by path…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {filtering && (
            <p className="files-summary">
              {matches} of {listing.entries.length} files
            </p>
          )}
          {listing.truncated && (
            <p className="files-summary">
              Showing {listing.entries.length} of {listing.total} files
            </p>
          )}
          {matches === 0 ? (
            <p className="files-page-hint">No file matches the filter</p>
          ) : (
            <div className="files-tree" data-files-tree>
              <FolderRows node={shown} open={open} toggle={toggle} forced={filtering} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The context panel's Files section: which workspace the tab is showing. */
export function FilesNav({ workspace }: { workspace: string }) {
  return (
    <nav aria-label="Files" className="context-nav">
      <div className="group-label">Files</div>
      <p className="files-nav-path" title={workspace}>
        {workspace}
      </p>
    </nav>
  );
}
