import { useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import { ChevronRight, FileImage, FileText, Folder, FolderOpen, RotateCw, Search } from "lucide-react";
import type { WorkspaceFileText } from "../../../src/dashboard/files.js";
import { MAX_TEXT_BYTES } from "../../../src/dashboard/limits.js";
import { api, blobDataUrl, errorText, fetchBlob } from "../api.js";
import { keys } from "../data/keys.js";
import type { FilesState } from "../files/use-files-state.js";
import { formatBytes, lineCount } from "../files/format.js";
import { countFiles, fileKind, type TreeFolder } from "../files/tree.js";
import { CodeBlock, Markdown } from "../markdown.js";
import { usePageGate } from "../states.js";
import { CopyButton, Empty, ErrorMessage } from "../ui.js";

/** The languages the code block can highlight; anything else falls back to plain text. */
const LANGUAGE: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", json: "json", md: "md", markdown: "md",
  css: "css", html: "html", py: "py", rb: "rb", rs: "rs", go: "go", sh: "sh", bash: "sh", yml: "yaml",
  yaml: "yaml", toml: "toml", sql: "sql", java: "java", kt: "kotlin", php: "php", swift: "swift",
};

const languageOf = (path: string): string => LANGUAGE[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text";

/** One folder's children: folders first, then files, with each branch rendered only while it is open. */
function FolderRows({ node, open, toggle, selected, onOpen }: {
  node: TreeFolder; open: ReadonlySet<string>; toggle: (path: string) => void; selected: string; onOpen: (path: string) => void;
}) {
  return (
    <ul className="files-tree-list">
      {node.folders.map((folder) => {
        const expanded = open.has(folder.path);
        const Glyph = expanded ? FolderOpen : Folder;
        return (
          <li key={folder.path} className="files-tree-item">
            <button type="button" className="files-tree-row" data-folder={folder.path} aria-expanded={expanded} onClick={() => toggle(folder.path)}>
              <ChevronRight size={14} aria-hidden="true" className="files-tree-chevron" />
              <Glyph size={14} aria-hidden="true" />
              <span className="files-tree-name">{folder.name}</span>
              <span className="files-tree-count">{countFiles(folder)}</span>
            </button>
            {expanded && <FolderRows node={folder} open={open} toggle={toggle} selected={selected} onOpen={onOpen} />}
          </li>
        );
      })}
      {node.files.map((file) => {
        const Glyph = fileKind(file.path) === "image" ? FileImage : FileText;
        return (
          <li key={file.path} className="files-tree-item">
            <button
              type="button"
              className="files-tree-row"
              data-file={file.path}
              title={file.path}
              aria-current={file.path === selected ? "true" : undefined}
              onClick={() => onOpen(file.path)}
            >
              <span className="files-tree-gap" aria-hidden="true" />
              <Glyph size={14} aria-hidden="true" />
              <span className="files-tree-name">{file.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Above this, the text is shown without syntax highlighting: a megabyte through the highlighter blocks the page. */
const HEAVY_TEXT = 200_000;

const KIND_LABEL = { markdown: "Markdown", image: "Image", text: "Text" } as const;

/** The viewer's header: the file's name and path, what it is, and what can be done with it. */
function ViewerHead({ path, chips, actions }: { path: string; chips: string[]; actions?: ReactNode }) {
  return (
    <header className="files-viewer-head">
      <div className="files-viewer-title">
        <h2 className="files-viewer-name" title={path.split("/").pop()}>{path.split("/").pop()}</h2>
        <div className="files-viewer-path" title={path}>{path}</div>
      </div>
      <div className="files-viewer-chips">
        {chips.map((chip) => <span key={chip} className="badge">{chip}</span>)}
      </div>
      <div className="files-viewer-actions">
        {actions}
        <CopyButton value={path} label="Copy path" text="Copy path" className="files-copy" />
      </div>
    </header>
  );
}

/** Source | Preview, a radio group so arrow keys move between the two choices. */
function ViewMode({ mode, onChange }: { mode: "source" | "preview"; onChange: (mode: "source" | "preview") => void }) {
  const options = [{ value: "source", label: "Source" }, { value: "preview", label: "Preview" }] as const;
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label="Markdown view"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const next = mode === "source" ? "preview" : "source";
        onChange(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus();
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-value={option.value}
          aria-checked={mode === option.value}
          tabIndex={mode === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The file itself: text or code, Markdown as source or preview, a raster image, or the reason it is not shown. */
function FileView({ workspace, path, tick, onRetry }: { workspace: string; path: string; tick: number; onRetry: () => void }) {
  const kind = fileKind(path);
  const [mode, setMode] = useState<"source" | "preview">("source");
  const [image, setImage] = useState<{ url: string; bytes: number } | { failed: true } | undefined>(undefined);
  const text = useSWR<WorkspaceFileText>(
    kind === "image" ? null : [keys.workspaceFile(workspace, path), tick],
    ([url]) => api<WorkspaceFileText>(url),
    { dedupingInterval: 0, keepPreviousData: false, shouldRetryOnError: false },
  );
  useEffect(() => {
    setMode("source");
    if (kind !== "image") { setImage(undefined); return; }
    // The request is aborted when the selection changes, so a slow image can never land under another file's name.
    const controller = new AbortController();
    setImage(undefined);
    // A data URL, not an object URL: the dashboard's CSP allows `img-src 'self' data:` and blocks `blob:`.
    void fetchBlob(keys.workspaceImage(workspace, path), controller.signal)
      .then(async (blob) => ({ url: await blobDataUrl(blob), bytes: blob.size }))
      .then((shown) => { if (!controller.signal.aborted) setImage(shown); })
      .catch(() => { if (!controller.signal.aborted) setImage({ failed: true }); });
    return () => controller.abort();
  }, [workspace, path, kind, tick]);

  if (kind === "image") {
    const sized = image && !("failed" in image);
    return (
      <>
        <ViewerHead path={path} chips={[KIND_LABEL.image, ...(sized ? [formatBytes(image.bytes)] : [])]} />
        {!image && <p className="files-page-hint">Loading…</p>}
        {image && "failed" in image && <p className="files-page-hint" data-files-notice>This image cannot be shown.</p>}
        {sized && (
          <div className="files-image">
            <img data-files-image src={image.url} alt={path.split("/").pop() ?? path} onError={() => setImage({ failed: true })} />
            <p className="files-summary" data-files-image-size>{image.bytes} bytes</p>
          </div>
        )}
      </>
    );
  }
  if (text.error) return (
    <>
      <ViewerHead path={path} chips={[KIND_LABEL[kind]]} />
      <div className="files-view-message">
        <ErrorMessage>{errorText(text.error)}</ErrorMessage>
        <button type="button" className="foot-button" onClick={onRetry}>Retry</button>
      </div>
    </>
  );
  if (!text.data) return (
    <>
      <ViewerHead path={path} chips={[KIND_LABEL[kind]]} />
      <p className="files-page-hint">Loading…</p>
    </>
  );
  if ("binary" in text.data) return (
    <>
      <ViewerHead path={path} chips={["Binary", formatBytes(text.data.bytes)]} />
      <p className="files-page-hint" data-files-notice>binary file, {text.data.bytes} bytes, not shown</p>
    </>
  );
  const shown = text.data.text;
  const language = languageOf(path);
  const heavy = shown.length > HEAVY_TEXT;
  const chips = [
    kind === "markdown" ? KIND_LABEL.markdown : language === "text" ? KIND_LABEL.text : language.toUpperCase(),
    formatBytes(text.data.bytes),
    `${lineCount(shown)} ${lineCount(shown) === 1 ? "line" : "lines"}`,
  ];
  const actions = (
    <>
      {kind === "markdown" && !heavy && <ViewMode mode={mode} onChange={setMode} />}
      <CopyButton value={shown} label="Copy contents" text="Copy contents" className="files-copy" />
    </>
  );
  return (
    <>
      <ViewerHead path={path} chips={chips} actions={actions} />
      {text.data.truncated && (
        <p className="files-page-hint" data-files-notice>Showing the first {MAX_TEXT_BYTES / (1024 * 1024)} MiB of {text.data.bytes} bytes</p>
      )}
      {heavy && <p className="files-page-hint">Large file: shown without highlighting</p>}
      {kind === "markdown" && !heavy && mode === "preview"
        ? <div className="files-markdown"><Markdown>{shown}</Markdown></div>
        : <CodeBlock code={shown} language={heavy ? "text" : kind === "markdown" ? "md" : language} lineNumbers bare />}
    </>
  );
}

/**
 * The Files tab's page: the file the address names, read-only, in the whole main area. The tree lives in the second
 * column (`FilesNav`), and both read the one state `App` owns. The listing is the same git-aware view the agent's `@`
 * references use, so the two never disagree.
 */
export function FilesPage({ workspace, selected, files }: { workspace: string; selected: string; files: FilesState }) {
  const { data, error, tick, reload } = files;
  const gate = usePageGate({ ready: !!data, error, onRetry: () => void reload(), label: "Loading files" });
  if (gate || !data) return gate;
  return (
    <div className="files-page">
      <h1 className="sr-only">Files</h1>
      {data.total === 0 && !selected ? (
        <Empty title="This workspace has no files">
          The agent sees the same view through @ references, so there is nothing here to point it at.
        </Empty>
      ) : (
        <section className="files-viewer-pane" data-files-viewer aria-label={selected ? `File ${selected}` : "No file chosen"}>
          {selected ? (
            <>
              <FileView key={`${workspace}:${selected}`} workspace={workspace} path={selected} tick={tick} onRetry={() => void reload()} />
            </>
          ) : (
            <p className="files-page-hint">Choose a file to read it here.</p>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * The second column of the Files tab: the filter, Reload and the tree, in the same place the chat's session list and
 * the agents occupy. On a narrow window the same node is the menu drawer, so `onChosen` closes it after a choice.
 */
export function FilesNav({ files, selected, onOpen, onChosen }: { files: FilesState; selected: string; onOpen: (path: string) => void; onChosen: () => void }) {
  const { data, error, shown, matches, filtering, query, setQuery, open, toggle, reload } = files;
  if (!data) {
    return (
      <nav aria-label="Files" className="context-nav">
        <div className="group-label">Files</div>
        {error ? <ErrorMessage>{errorText(error)}</ErrorMessage> : <p className="files-page-hint">Loading…</p>}
      </nav>
    );
  }
  const choose = (path: string) => { onOpen(path); onChosen(); };
  return (
    <nav aria-label="Files" className="context-nav">
      <div className="files-nav-head">
        <span className="group-label">Files · {data.total}</span>
        <button type="button" className="files-reload" aria-label="Reload" onClick={() => void reload()} title="Read the listing and the open file again">
          <RotateCw size={14} aria-hidden="true" />
        </button>
      </div>
      <label className="search-input files-filter">
        <Search size={14} aria-hidden="true" />
        <input aria-label="Filter files" placeholder="Filter by path…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {filtering && (
        <p className="files-summary">
          {matches} of {data.entries.length} {data.truncated ? "files shown" : "files"}
        </p>
      )}
      {data.truncated && <p className="files-summary">Showing {data.entries.length} of {data.total} files</p>}
      {matches === 0 ? (
        <p className="files-page-hint">{data.total === 0 ? "No files are listed in this workspace" : "No file matches the filter"}</p>
      ) : (
        <div className="files-tree" data-files-tree>
          <FolderRows node={shown} open={open} toggle={toggle} selected={selected} onOpen={choose} />
        </div>
      )}
    </nav>
  );
}
