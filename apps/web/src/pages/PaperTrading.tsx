import { useState } from "react";
import { NotAvailable } from "../components/NotAvailable";

type Tab = "active" | "archived";

export function PaperTrading() {
  const [tab, setTab] = useState<Tab>("active");
  return (
    <section>
      <h2>Paper Trading</h2>
      <div role="tablist" aria-label="Paper trades">
        <button role="tab" aria-selected={tab === "active"} onClick={() => setTab("active")}>
          Active
        </button>
        <button role="tab" aria-selected={tab === "archived"} onClick={() => setTab("archived")}>
          Archived (Legacy)
        </button>
      </div>
      <div role="tabpanel">
        {tab === "active" ? (
          <p>No active paper trades.</p>
        ) : (
          <p>No archived legacy trades. V2 does not import or read any legacy trade records.</p>
        )}
      </div>
      <NotAvailable>Paper trade creation and monitoring are not implemented yet.</NotAvailable>
    </section>
  );
}
