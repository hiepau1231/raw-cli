import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileListing } from "../../../src/dashboard/files.js";
import { api } from "../api.js";
import { keys } from "../data/keys.js";
import { useWorkspaceFiles } from "../data/queries.js";
import { ancestorFolders, buildTree, countFiles, filterTree, type TreeFolder } from "./tree.js";

export interface FilesState {
  data: WorkspaceFileListing | undefined;
  error: unknown;
  /** The whole tree, the part the filter keeps, how many files that is, and whether a filter is typed. */
  shown: TreeFolder;
  matches: number;
  filtering: boolean;
  query: string;
  setQuery: (query: string) => void;
  open: ReadonlySet<string>;
  toggle: (folder: string) => void;
  /** Bumped by Reload (and by choosing the open file again) so the viewer reads the file once more. */
  tick: number;
  bump: () => void;
  /** Reads the listing past the host's short cache, and the open file again. */
  reload: () => Promise<void>;
}

/**
 * Everything the Files tab's navigation and its viewer share: the listing, the filter, the opened folders and the
 * reload tick. `App` calls it once, so the second column and the narrow-window drawer show one state. `enabled` is
 * true only while the Files page is showing: the listing is never requested from another page, and the folders that
 * lead to the open file or to the filter's matches are opened only then. A different workspace starts clean.
 */
export function useFilesState({ workspace, enabled, selected }: { workspace: string; enabled: boolean; selected: string }): FilesState {
  const { data, error, mutate } = useWorkspaceFiles(enabled ? workspace : "");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [tick, setTick] = useState(0);
  const previousWorkspace = useRef(workspace);
  const tree = useMemo(() => buildTree((data?.entries ?? []).map((entry) => entry.path)), [data]);
  const shown = useMemo(() => filterTree(tree, query), [tree, query]);
  const filtering = query.trim() !== "";
  const matches = countFiles(shown);
  const bump = useCallback(() => setTick((value) => value + 1), []);
  const toggle = useCallback((folder: string) => setOpen((old) => {
    const next = new Set(old);
    if (!next.delete(folder)) next.add(folder);
    return next;
  }), []);
  const reload = useCallback(async () => {
    setTick((value) => value + 1);
    if (!workspace) return;
    try {
      await mutate(api<WorkspaceFileListing>(keys.workspaceFiles(workspace, true)), { revalidate: false });
    } catch {
      // SWR stores the failure on the current key; the page gate and the viewer render it on the next pass.
    }
  }, [workspace, mutate]);
  useEffect(() => {
    const previous = previousWorkspace.current;
    previousWorkspace.current = workspace;
    if (!previous || !workspace || previous === workspace) return;
    setQuery("");
    setOpen(new Set());
    setTick(0);
  }, [workspace]);
  // The file in the address opens the folders leading to it, without closing what the reader opened.
  useEffect(() => {
    if (!enabled || !selected) return;
    const ancestors = ancestorFolders(selected);
    if (!ancestors.length) return;
    setOpen((old) => new Set([...old, ...ancestors]));
  }, [enabled, selected]);
  // A filter really opens the folders that lead to its matches, rather than claiming to: the disclosure buttons
  // keep telling the truth about what a click would do.
  useEffect(() => {
    if (!enabled || !filtering) return;
    const folders: string[] = [];
    const walk = (node: TreeFolder) => {
      for (const child of node.folders) { folders.push(child.path); walk(child); }
    };
    walk(shown);
    if (!folders.length) return;
    setOpen((old) => (folders.some((folder) => !old.has(folder)) ? new Set([...old, ...folders]) : old));
  }, [enabled, shown, filtering]);
  return { data, error, shown, matches, filtering, query, setQuery, open, toggle, tick, bump, reload };
}
