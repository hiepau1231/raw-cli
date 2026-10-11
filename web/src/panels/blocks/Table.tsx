import { useLayoutEffect, useRef, useState } from "react";
import type { TableColumn, TableRow } from "../../../../src/panels/contract.js";
import { ItemActions, StatusControl, useOfferer } from "../actions.js";
import { Ref, StatusGlyph, type InsertRef } from "../status.js";

/** Below this container width a table is a list of cards (kvtable.png); from it, a compact table. */
const TABLE_MIN = 420;

export function Table({ block, title, columns, rows, onInsert }: { block: string; title: string; columns: TableColumn[]; rows: TableRow[]; onInsert: InsertRef }) {
  const offer = useOfferer();
  const actionable = rows.some((row) => offer("item", block, row).length > 0);
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setWide(element.clientWidth >= TABLE_MIN);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [first, ...rest] = columns;
  const nameOf = (row: TableRow) => row.cells[first?.id ?? ""] ?? row.id;
  const statuses = rows.some((row) => row.status);
  return (
    <div ref={box} className="panel-table-box">
      {wide ? (
        <div className="panel-table-wrap" tabIndex={0} role="region" aria-label={title}>
          <table className="panel-table">
            <thead>
              <tr>
                {statuses && <th scope="col" className="panel-table-glyph"><span className="sr-only">Status</span></th>}
                {columns.map((column) => <th key={column.id} scope="col" style={{ textAlign: column.align ?? "start" }} title={column.label}>{column.label}</th>)}
                {rows.some((row) => row.ref) && <th scope="col"><span className="sr-only">File</span></th>}
                {actionable && <th scope="col" className="panel-table-glyph"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {statuses && <td>{row.status ? <StatusControl block={block} item={row} name={nameOf(row)}><StatusGlyph status={row.status} /></StatusControl> : null}</td>}
                  {columns.map((column) => <td key={column.id} style={{ textAlign: column.align ?? "start" }} title={row.cells[column.id] ?? ""}>{row.cells[column.id] ?? ""}</td>)}
                  {rows.some((r) => r.ref) && <td>{row.ref ? <Ref value={row.ref} onInsert={onInsert} /> : null}</td>}
                  {actionable && <td><ItemActions block={block} item={row} name={nameOf(row)} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="panel-table-cards" aria-label={title}>
          {rows.map((row) => {
            const cells = rest.map((column) => [column.label, row.cells[column.id]] as const).filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join(" · ");
            return (
              <li key={row.id} className="panel-table-card" data-status={row.status}>
                <div className="panel-row panel-table-card-head">
                  {row.status && <StatusControl block={block} item={row} name={nameOf(row)}><StatusGlyph status={row.status} size={14} /></StatusControl>}
                  <span className="panel-table-card-title" title={nameOf(row)}>{nameOf(row)}</span>
                  <ItemActions block={block} item={row} name={nameOf(row)} />
                </div>
                {cells && <span className="panel-table-card-cells">{cells}</span>}
                {row.ref && <span className="panel-table-card-ref"><Ref value={row.ref} onInsert={onInsert} /></span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
