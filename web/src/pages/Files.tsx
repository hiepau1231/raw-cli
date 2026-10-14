/**
 * The Files tab (docs/files-tab-spec.md): a read-only view of the selected workspace, reached from the rail. This
 * is the shell the tree pane and the viewer fill in; it exists so the rail, a deep link and the context panel have
 * something to show, and so the page is a page the server serves rather than a 404.
 */
export function FilesPage({ workspace }: { workspace: string }) {
  return (
    <div className="files-page">
      <header className="page-header">
        <h1>Files</h1>
        <span className="workspace-path" title={workspace}>
          {workspace}
        </span>
      </header>
      <p className="files-page-hint">Choose a file in this workspace to read it here.</p>
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
