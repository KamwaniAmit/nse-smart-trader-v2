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
   * Phase 1B.1 (D1): send each leg's quote time (asOf). For manually typed prices that is the moment the user last
   * edited that leg's prices. The server checks it against its own clock and refuses quotes older than 60 s.
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
  const [enteredAt, setEnteredAt] = useState<Record<number, string>>({});
  const set = (k: string) => (v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    // The leg index is the trailing number of a leg field key (bid0, ask1, ...). Extra fields have no leg.
    const leg = /^(bid|ask|volume|oi|bidQty|askQty)(\d+)$/.exec(k);
    if (timestamped && leg) setEnteredAt((prev) => ({ ...prev, [Number(leg[2])]: new Date().toISOString() }));
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
      ...(timestamped && enteredAt[i] !== undefined ? { asOf: enteredAt[i] } : {}),
    }));

  return (
    <fieldset>
      <legend>{title}</legend>
      {legs.map((leg, i) => (
        <div key={leg.instrument.id}>
          {field(`bid${i}`, `${leg.label} bid`)}
          {extended ? (
            <>
              {field(`ask${i}`, `${leg.label} ask`)}
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
          Quote time = when you typed each leg&apos;s prices (manual data, not exchange-verified). The server refuses quotes older than 60 seconds, so enter them just before submitting.
        </p>
      ) : null}
      {beforeSubmit}
      <button type="button" disabled={disabled} onClick={() => onSubmit(build(), values)}>{submitLabel}</button>
    </fieldset>
  );
}
