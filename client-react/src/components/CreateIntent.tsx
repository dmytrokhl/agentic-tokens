import { useState } from "react";
import { api } from "../api";
import { useAppState, useStepStatus } from "../useAppState";
import { Step } from "./Step";
import { Field, Row, Button } from "./ui";
import { CurrencyField } from "./CurrencyField";

export function CreateIntent() {
  const { state, setState, log, setLoading, completeStep } = useAppState();
  const { loading, num } = useStepStatus("intent");
  const [consumerPrompt, setConsumerPrompt] = useState("Allow monthly purchase up to $5.33 at Best Buy");
  const [mandateDesc, setMandateDesc] = useState("Monthly subscription");
  const [merchantName, setMerchantName] = useState("Best Buy");
  const [mcc, setMcc] = useState("1234");
  const [amount, setAmount] = useState("5.33");
  const [currency, setCurrency] = useState("USD");
  const [quantity, setQuantity] = useState("1");
  const [effectiveUntil, setEffectiveUntil] = useState(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 10);
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  });
  const [response, setResponse] = useState<unknown>(null);

  // The flows without a passkey ceremony produce no assurance data — ID&V leaves it null and a
  // passkey-exempt device binding resolves to []. Both mean "nothing to send", so normalise once
  // and let the payload and the label below agree. Under the passkey flow it carries the FIDO result.
  const assuranceData = state.assuranceData?.length ? state.assuranceData : null;
  const assuranceJson = assuranceData ? JSON.stringify(assuranceData, null, 2) : "";

  async function handleCreate() {
    setLoading("intent", true);
    log(`Step ${num}: Creating intent...`);
    try {
      const data = await api("POST", `/intents?tokenId=${encodeURIComponent(state.tokenId!)}`, {
        data: {
          type: "intents",
          attributes: {
            consumer_prompt: consumerPrompt,
            ...(assuranceData ? { assurance_data: assuranceData } : {}),
            mandates: [{
              description: mandateDesc,
              merchant_category: "Electronics",
              preferred_merchant_name: merchantName,
              merchant_category_code: mcc,
              decline_threshold: {
                amount: parseFloat(amount),
                currency_code: currency,
              },
              effective_until: effectiveUntil,
              quantity: parseInt(quantity),
            }],
          },
        },
      });
      setResponse(data);
      if (data?.data?.id) {
        setState((s) => ({ ...s, intentId: data.data.id }));
        log(`Step ${num}: Intent created — ${data.data.id}`);
        completeStep("intent");
      } else {
        log(`Step ${num}: Failed — ` + JSON.stringify(data));
        setLoading("intent", false);
      }
    } catch (err) {
      log(`Step ${num}: Error — ` + (err as Error).message);
      setLoading("intent", false);
    }
  }

  return (
    <Step stepKey="intent" title="Create Intent" response={response}>
      <Field label={assuranceData ? "Assurance Data" : "Assurance Data (not used in this flow)"}>
        <textarea className="input min-h-[60px] resize-y" readOnly rows={3} value={assuranceJson} />
      </Field>
      <Field label="Consumer Prompt">
        <input className="input" value={consumerPrompt} onChange={(e) => setConsumerPrompt(e.target.value)} />
      </Field>
      <Field label="Mandate — Description">
        <input className="input" value={mandateDesc} onChange={(e) => setMandateDesc(e.target.value)} />
      </Field>
      <Row>
        <Field label="Merchant Name">
          <input className="input" value={merchantName} onChange={(e) => setMerchantName(e.target.value)} />
        </Field>
        <Field label="MCC">
          <input className="input" value={mcc} onChange={(e) => setMcc(e.target.value)} />
        </Field>
      </Row>
      <Row>
        <Field label="Amount">
          <input className="input" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <CurrencyField value={currency} onChange={setCurrency} />
      </Row>
      <Row>
        <Field label="Quantity">
          <input className="input" type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Effective Until">
          <input className="input" value={effectiveUntil} onChange={(e) => setEffectiveUntil(e.target.value)} />
        </Field>
      </Row>
      <Button onClick={handleCreate} disabled={loading}>Create Intent</Button>
    </Step>
  );
}
