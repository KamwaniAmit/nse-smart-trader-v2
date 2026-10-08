import type { RiskLevel } from "@nsest/core/contracts";

/** Always shows the level as TEXT. Colour is decoration only. */
export function RiskBadge({ level }: { level: RiskLevel | null }) {
  if (level === null) {
    return (
      <span className="badge badge-muted" data-risk="insufficient">
        Insufficient risk data
      </span>
    );
  }
  return (
    <span className="badge" data-risk={level.toLowerCase()} title={`Risk level: ${level}`}>
      {level}
    </span>
  );
}
