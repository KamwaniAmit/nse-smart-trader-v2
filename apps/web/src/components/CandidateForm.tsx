import { useState } from "react";
import { MARKET_DISPLAY_NAMES, MARKET_IDS } from "@nsest/core/contracts";
import type { CandidateInputDTO, PaperSource, PaperStructure } from "@nsest/core/contracts";

interface Props {
  source: PaperSource;
  busy: boolean;
  onAssess: (input: CandidateInputDTO) => void;
}

const STRUCTURES: Record<PaperSource, readonly PaperStructure[]> = {
  LONG_VOL: ["STRADDLE", "STRANGLE"],
  BEST_OPPORTUNITY: ["SINGLE_CALL", "SINGLE_PUT"],
};

interface LegText {
  strike: string; bid: string; ask: string; volume: string; oi: string; bidQty: string; askQty: string;
}
const emptyLeg = (): LegText => ({ strike: "", bid: "", ask: "", volume: "", oi: "", bidQty: "", askQty: "" });

interface FormText {
  marketId: string; structure: string; expiry: string; lotSize: string;
  ce: LegText; pe: LegText;
  spot: string; tradingDaysToExpiry: string;
  score: string; expectedMove: string; impliedMove: string; expectedNetEdge: string; iv: string; rv20: string; rvRegime: string;
  maxCapitalAllocation: string; entryCosts: string; requestedLots: string;
}

const blank = (source: PaperSource): FormText => ({
  marketId: "NIFTY", structure: STRUCTURES[source][0] as string, expiry: "", lotSize: "",
  ce: emptyLeg(), pe: emptyLeg(), spot: "", tradingDaysToExpiry: "",
  score: "", expectedMove: "", impliedMove: "", expectedNetEdge: "", iv: "", rv20: "", rvRegime: "",
  maxCapitalAllocation: "", entryCosts: "", requestedLots: "",
});

/** Illustration only: the legacy example numbers. The user must press the button; nothing is pre-filled. */
function example(source: PaperSource): FormText {
  const depth = { volume: "6000", oi: "12000", bidQty: "6500", askQty: "6500" };
  const f = blank(source);
  return {
    ...f, expiry: "2026-10-06", lotSize: "65", spot: "22831.15", tradingDaysToExpiry: "8",
    ce: { strike: "22900", bid: "69", ask: "69.8", ...depth }, pe: { strike: source === "LONG_VOL" ? "22800" : "", bid: source === "LONG_VOL" ? "50.2" : "", ask: source === "LONG_VOL" ? "50.95" : "", ...depth },
    score: "62", expectedMove: "230", impliedMove: "180", expectedNetEdge: "700", iv: "0.15", rv20: "0.12", rvRegime: "RV_ACCELERATING",
    maxCapitalAllocation: "100000", entryCosts: "250", requestedLots: "1",
  };
}

/** Blank -> null. A value that is not a number is sent as typed, so the server rejects it clearly (never silently dropped). */
const n = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : (t as unknown as number);
};

function buildInput(source: PaperSource, f: FormText): CandidateInputDTO {
  const quote = (l: LegText) => ({ bid: n(l.bid), ask: n(l.ask), volume: n(l.volume), oi: n(l.oi), bidQty: n(l.bidQty), askQty: n(l.askQty) });
  const legs: CandidateInputDTO["legs"] = [];
  if (f.structure !== "SINGLE_PUT") legs.push({ optionType: "CE", strike: n(f.ce.strike) as number, quote: quote(f.ce) });
  if (f.structure !== "SINGLE_CALL") legs.push({ optionType: "PE", strike: n(f.pe.strike) as number, quote: quote(f.pe) });
  return {
    source,
    marketId: f.marketId as CandidateInputDTO["marketId"],
    structure: f.structure as PaperStructure,
    expiry: f.expiry,
    lotSize: n(f.lotSize) as number,
    legs,
    dataSource: "MANUAL",
    spot: n(f.spot), tradingDaysToExpiry: n(f.tradingDaysToExpiry),
    score: n(f.score), expectedMove: n(f.expectedMove), impliedMove: n(f.impliedMove), expectedNetEdge: n(f.expectedNetEdge),
    iv: n(f.iv), rv20: n(f.rv20), rvRegime: f.rvRegime === "" ? null : f.rvRegime,
    maxCapitalAllocation: n(f.maxCapitalAllocation), entryCosts: n(f.entryCosts), requestedLots: n(f.requestedLots),
  };
}

function Field({ label, value, onChange, type = "text", hint }: { label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string }) {
  return (
    <div className="field">
      <label>
        {label}
        <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

function LegFields({ name, value, onChange }: { name: "CE" | "PE"; value: LegText; onChange: (v: LegText) => void }) {
  const set = (k: keyof LegText) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <fieldset>
      <legend>{name} leg</legend>
      <Field label={`${name} strike`} value={value.strike} onChange={set("strike")} />
      <Field label={`${name} bid`} value={value.bid} onChange={set("bid")} />
      <Field label={`${name} ask`} value={value.ask} onChange={set("ask")} />
      <Field label={`${name} volume`} value={value.volume} onChange={set("volume")} />
      <Field label={`${name} open interest`} value={value.oi} onChange={set("oi")} />
      <Field label={`${name} bid quantity`} value={value.bidQty} onChange={set("bidQty")} />
      <Field label={`${name} ask quantity`} value={value.askQty} onChange={set("askQty")} />
    </fieldset>
  );
}

export function CandidateForm({ source, busy, onAssess }: Props) {
  const [f, setF] = useState<FormText>(() => blank(source));
  const set = (k: keyof FormText) => (v: string) => setF((prev) => ({ ...prev, [k]: v }));

  return (
    <section aria-label="Manual candidate entry">
      <h3>Enter a candidate manually</h3>
      <p className="hint">
        These numbers are typed by you. They are <strong>not live market data</strong>, and no broker is involved. Entry uses the asks you enter
        ({source === "LONG_VOL" ? "CE Ask + PE Ask" : "the option's ask"}); exit uses bids only.
      </p>
      <div className="field">
        <label>
          Candidate market
          <select value={f.marketId} onChange={(e) => set("marketId")(e.target.value)}>
            {MARKET_IDS.map((id) => (
              <option key={id} value={id}>{MARKET_DISPLAY_NAMES[id]}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <label>
          Structure
          <select value={f.structure} onChange={(e) => set("structure")(e.target.value)}>
            {STRUCTURES[source].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      <Field label="Expiry" type="date" value={f.expiry} onChange={set("expiry")} />
      <Field label="Lot size" value={f.lotSize} onChange={set("lotSize")} hint="Required. No lot size is assumed." />
      {f.structure !== "SINGLE_PUT" ? <LegFields name="CE" value={f.ce} onChange={(v) => setF((p) => ({ ...p, ce: v }))} /> : null}
      {f.structure !== "SINGLE_CALL" ? <LegFields name="PE" value={f.pe} onChange={(v) => setF((p) => ({ ...p, pe: v }))} /> : null}
      <Field label="Spot" value={f.spot} onChange={set("spot")} />
      <Field label="Trading days to expiry" value={f.tradingDaysToExpiry} onChange={set("tradingDaysToExpiry")} hint="No trading calendar exists yet, so you supply this." />
      <fieldset>
        <legend>Strategy outputs (optional; recorded as typed, never recalculated)</legend>
        <Field label="Score" value={f.score} onChange={set("score")} />
        <Field label="Expected move (₹)" value={f.expectedMove} onChange={set("expectedMove")} />
        <Field label="Implied move (₹)" value={f.impliedMove} onChange={set("impliedMove")} />
        <Field label="Expected net edge (₹)" value={f.expectedNetEdge} onChange={set("expectedNetEdge")} />
        <Field label="IV (decimal, 0.15 = 15%)" value={f.iv} onChange={set("iv")} />
        <Field label="RV20 (decimal)" value={f.rv20} onChange={set("rv20")} />
        <div className="field">
          <label>
            RV regime
            <select value={f.rvRegime} onChange={(e) => set("rvRegime")(e.target.value)}>
              <option value="">unknown</option>
              <option value="RV_ACCELERATING">RV_ACCELERATING</option>
              <option value="RV_DECELERATING">RV_DECELERATING</option>
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Capital</legend>
        <Field label="Max capital allocation (₹)" value={f.maxCapitalAllocation} onChange={set("maxCapitalAllocation")} />
        <Field label="Entry costs (₹)" value={f.entryCosts} onChange={set("entryCosts")} hint="Enter 0 yourself if there are none; it is never assumed." />
        <Field label="Lots (optional)" value={f.requestedLots} onChange={set("requestedLots")} hint="Blank = floor(allocation / capital requirement)." />
      </fieldset>
      <button type="button" disabled={busy} onClick={() => onAssess(buildInput(source, f))}>Assess candidate</button>{" "}
      <button type="button" onClick={() => setF(example(source))}>Fill with example numbers (illustration only)</button>
    </section>
  );
}
