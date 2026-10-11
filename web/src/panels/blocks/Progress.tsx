/** A label and `value / max` on one line over a thin bar (steps.png); an unknown value animates the bar. */
export function Progress({ label, value, max, indeterminate }: { label?: string | undefined; value?: number | undefined; max?: number | undefined; indeterminate?: boolean | undefined }) {
  const total = max && max > 0 ? max : 100;
  const known = !indeterminate && typeof value === "number";
  const share = known ? Math.min(1, Math.max(0, value / total)) : 0;
  return (
    <div className="panel-progress-block">
      {(label || known) && (
        <div className="panel-progress-head">
          {label && <span className="panel-progress-label" title={label}>{label}</span>}
          {known && <span className="panel-progress-value">{value} / {total}</span>}
        </div>
      )}
      <span className={`sp-bar panel-progress-bar${known ? "" : " indeterminate"}`} role="progressbar" aria-label={label ?? "Progress"}
        aria-valuemin={0} aria-valuemax={total} {...(known ? { "aria-valuenow": value } : {})}>
        <i style={known ? { width: `${share * 100}%` } : undefined} />
      </span>
    </div>
  );
}
