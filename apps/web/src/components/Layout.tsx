import { NavLink, Outlet } from "react-router-dom";

export const NAV_ITEMS = [
  { to: "/", label: "Overview" },
  { to: "/markets", label: "Markets" },
  { to: "/long-vol", label: "LONG VOL" },
  { to: "/best-opportunities", label: "Best Opportunities" },
  { to: "/paper-trading", label: "Paper Trading" },
  { to: "/broker", label: "Broker" },
] as const;

export function Layout() {
  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Main navigation">
        <h1 className="brand">NSE Smart Trader V2</h1>
        <ul>
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.to === "/"}>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <p className="phase-tag">Phase 1A · foundation only</p>
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
