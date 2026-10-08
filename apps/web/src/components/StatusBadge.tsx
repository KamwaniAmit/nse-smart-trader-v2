/** Shows a status as plain text (e.g. QUALIFIED, NOT_CONFIGURED, NOT_CONNECTED). */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="badge badge-status" data-status={status.toLowerCase()}>
      {status}
    </span>
  );
}
