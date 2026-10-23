import { useState } from "react";
import type { ReactNode } from "react";
import type { EntryQuoteDTO, InstrumentRefDTO } from "@nsest/core/contracts";

export interface QuoteLeg {
  label: string;
  instrument: InstrumentRefDTO;
}
export interface ExtraField {
  key: string;
  label: string;
  hint?: string;
}

interface Props {
  title: string;
  legs: readonly QuoteLeg[];
  /** Also ask for ask, volume, open interest and depth (used by monitoring, to assess current risk). */
  extended?: boolean;
  /**
   * Phase 1B.1 (D1, review correction R1): send each leg's quote time (asOf). For manually typed prices the form records a
   * user-entry time per PRICE (bid and ask separately); volume, open interest and depth never change it. The time sent is
   * the OLDER of the leg's bid and ask entry times, so a quote is never presented as newer than its stalest price. If
   * either price has no entry time, no asOf is sent and the server refuses the quote. The server checks the time against
   * its own clock and refuses quotes older than 60 s.
   */
  timestamped?: boolean;
  /** Optional content shown above the submit button (for example the confirmation checkbox). */
  beforeSubmit?: ReactNode;
  extra: readonly ExtraField[];
  submitLabel: string;
  disabled: boolean;
  onSubmit: (quotes: EntryQuoteDTO[], extra: Record<string, string>) => void;
}

const num = (s: string | undefined): number | null => {
  const t = (s ?? "").trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : (t as unknown as number);
};

/** Prices for the EXACT stored legs. A leg left blank is sent as no price, never as zero and never as an LTP. */
export function QuoteForm({ title, legs, extended = false, timestamped = false, beforeSubmit, extra, submitLabel, disabled, onSubmit }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  /** User-entry time per PRICE field ("bid0", "ask0", ...). Only bid and ask have one; depth fields never do. */
  const [priceEnteredAt, setPriceEnteredAt] = useState<Record<string, string>>({});
  const set = (k: string) => (v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    if (!timestamped || !/^(bid|ask)\d+$/.test(k)) return;
    setPriceEnteredAt((prev) => {
      const next = { ...prev };
      // A cleared price has no entry time (so the quote is sent without one and refused); otherwise record "now".
      if (v.trim() === "") delete next[k];
      else next[k] = new Date().toISOString();
      return next;
    });
  };
  /** The older of the leg's bid and ask entry times, or undefined if either price has none. */
  const quoteTimeOf = (i: number): string | undefined => {
    const bidAt = priceEnteredAt[`bid${i}`];
    const askAt = priceEnteredAt[`ask${i}`];
    if (bidAt === undefined || askAt === undefined) return undefined;
    return Date.parse(bidAt) <= Date.parse(askAt) ? bidAt : askAt;
  };
  const field = (k: string, label: string, hint?: string) => (
    <div className="field" key={k}>
      <label>
        {`${title}: ${label}`}
        <input value={values[k] ?? ""} onChange={(e) => set(k)(e.target.value)} />
      </label>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );

  const build = (): EntryQuoteDTO[] =>
    legs.map((leg, i) => ({
      instrument: leg.instrument,
      bid: num(values[`bid${i}`]),
      ...(extended ? { ask: num(values[`ask${i}`]), volume: num(values[`volume${i}`]), oi: num(values[`oi${i}`]), bidQty: num(values[`bidQty${i}`]), askQty: num(values[`askQty${i}`]) } : {}),
      ...(timestamped && quoteTimeOf(i) !== undefined ? { asOf: quoteTimeOf(i) } : {}),
    }));

  return (
    <fieldset>
      <legend>{title}</legend>
      {legs.map((leg, i) => (
        <div key={leg.instrument.id}>
          {field(`bid${i}`, `${leg.label} bid`)}
          {timestamped && priceEnteredAt[`bid${i}`] ? <span className="hint">{`${leg.label} bid entered at ${priceEnteredAt[`bid${i}`]}`}</span> : null}
          {extended ? (
            <>
              {field(`ask${i}`, `${leg.label} ask`)}
              {timestamped && priceEnteredAt[`ask${i}`] ? <span className="hint">{`${leg.label} ask entered at ${priceEnteredAt[`ask${i}`]}`}</span> : null}
              {field(`volume${i}`, `${leg.label} volume`)}
              {field(`oi${i}`, `${leg.label} open interest`)}
              {field(`bidQty${i}`, `${leg.label} bid quantity`)}
              {field(`askQty${i}`, `${leg.label} ask quantity`)}
            </>
          ) : null}
        </div>
      ))}
      {extra.map((e) => field(e.key, e.label, e.hint))}
      {timestamped ? (
        <p className="hint">
          Times shown are user-entry times, not exchange timestamps: the moment you typed each bid and ask. Each leg is sent with the older of its two
          price times; editing volume, open interest or depth does not change it. The server refuses quotes older than 60 seconds, so enter prices
          just before confirming. These times do not prove that the prices were current market prices.
        </p>
      ) : null}
      {beforeSubmit}
      <button type="button" disabled={disabled} onClick={() => onSubmit(build(), values)}>{submitLabel}</button>
    </fieldset>
  );
}
