/** An 18 px ring filled to the share of the context used (docs/chat-design.md §8); empty before the first measurement. */
export function ContextRing({ percent, tone }: { percent: number | undefined; tone: "accent" | "warning" | "error" }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const used = percent === undefined ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <svg className="context-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle className="ring-track" cx="9" cy="9" r={radius} />
      {percent !== undefined && (
        <circle
          className={`ring-fill tone-${tone}`}
          cx="9"
          cy="9"
          r={radius}
          strokeDasharray={`${(circumference * used) / 100} ${circumference}`}
          transform="rotate(-90 9 9)"
        />
      )}
    </svg>
  );
}
