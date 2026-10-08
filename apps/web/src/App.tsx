import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { BestOpportunities } from "./pages/BestOpportunities";
import { Broker } from "./pages/Broker";
import { LongVol } from "./pages/LongVol";
import { Markets } from "./pages/Markets";
import { Overview } from "./pages/Overview";
import { PaperTrading } from "./pages/PaperTrading";

/** Routes only. The router itself is supplied by main.tsx (or by tests). */
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="markets" element={<Markets />} />
        <Route path="long-vol" element={<LongVol />} />
        <Route path="best-opportunities" element={<BestOpportunities />} />
        <Route path="paper-trading" element={<PaperTrading />} />
        <Route path="broker" element={<Broker />} />
      </Route>
    </Routes>
  );
}
