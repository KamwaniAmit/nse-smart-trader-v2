export function NotAvailable({ children }: { children?: React.ReactNode }) {
  return (
    <div className="notice" role="note">
      <strong>Not available in Phase 1A</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
