import { Field } from "./ui";

const CURRENCIES = [
  { code: "USD", numeric: "840", name: "US Dollar" },
  { code: "EUR", numeric: "978", name: "Euro" },
  { code: "GBP", numeric: "826", name: "British Pound" },
  { code: "JPY", numeric: "392", name: "Japanese Yen" },
  { code: "AUD", numeric: "036", name: "Australian Dollar" },
  { code: "CAD", numeric: "124", name: "Canadian Dollar" },
] as const;

export function CurrencyField({ value, onChange, disabled, numeric = false, europe = false, ariaLabel = "Currency" }: {
  value: string; onChange: (value: string) => void; disabled?: boolean;
  numeric?: boolean; europe?: boolean; ariaLabel?: string;
}) {
  const knownCurrency = CURRENCIES.some((currency) => currency.code === value);
  const custom = !numeric && !europe;
  return <Field label="Currency">
    <select className="input" aria-label={ariaLabel} value={custom && !knownCurrency ? "" : value} disabled={disabled}
      onChange={(event) => onChange(event.target.value)}>
      {CURRENCIES.filter((currency) => !europe || ["EUR", "USD", "GBP"].includes(currency.code)).map((currency) => (
        <option key={currency.code} value={numeric ? currency.numeric : currency.code}>{numeric ? `${currency.numeric} — ${currency.code}` : currency.code}</option>
      ))}
      {custom && <option value="">Other currency…</option>}
    </select>
    {custom && !knownCurrency && <input className="input mt-1" aria-label={`${ariaLabel} code`} value={value}
      placeholder="Three-letter currency code" maxLength={3} disabled={disabled}
      onChange={(event) => onChange(event.target.value.toUpperCase())} />}
  </Field>;
}
