import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { EUROPE_STEPS, credentialStepComplete, purchaseStage, safeCheckoutOutcome } from "../src/europe-journey.ts";

async function loadPanel() {
  const source = await readFile(new URL("../src/components/StepPanel.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } });
  const code = compiled.outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")));
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)).StepPanel;
}

test("Europe distinguishes purchase operations and gates confirmation on issued credentials", () => {
  assert.equal(EUROPE_STEPS[3], "Create Purchase Request");
  assert.equal(EUROPE_STEPS[4], "Purchase Verification");
  assert.equal(EUROPE_STEPS[5], "Get Payment Credential");
  assert.equal(EUROPE_STEPS[6], "Confirm Transaction");
  assert.equal(purchaseStage("waiting_for_authentication"), 5);
  assert.equal(purchaseStage("awaiting_payment_outcome"), 7);
  assert.equal(purchaseStage("completed"), 8);
});

test("displayed outcomes cannot include auth evidence or full credentials", () => {
  const summary = safeCheckoutOutcome({ status: "awaiting_payment_outcome", intentId: "instruction", assuranceData: ["SECRET"],
    stepupauthcode: "SECRET", binding: { url: "SECRET" }, cryptogram: "SECRET", paymentCredential: {
      dpan: "SECRET", dpanLast4: "12345678", cryptogramValue: "SECRET", fidoBlob: "SECRET", expiry: "12/27", eci: "05",
    } });
  assert.deepEqual(summary, { status: "awaiting_payment_outcome", intentId: "instruction",
    paymentCredential: { dpanLast4: "5678", expiry: "12/27", eci: "05" } });
  assert.equal(JSON.stringify(summary).includes("SECRET"), false);
});

test("collapsed Europe panel retains mounted browser content; original closed step keeps its output", async () => {
  const StepPanel = await loadPanel();
  const props = { title: "Verification", num: 3, open: false, active: true, done: false, loading: false, disabled: false, onHeaderClick() {} };
  const children = createElement("div", { id: "sdk-container" });
  const original = renderToStaticMarkup(createElement(StepPanel, props, children));
  assert.equal(original.includes("sdk-container"), false);
  assert.equal(original.includes('aria-expanded="false"'), true);
  const retained = renderToStaticMarkup(createElement(StepPanel, { ...props, keepMounted: true }, children));
  assert.match(retained, /hidden=""/);
  assert.match(retained, /id="sdk-container"/);
  const expanded = renderToStaticMarkup(createElement(StepPanel, { ...props, open: true }, children));
  assert.match(expanded, /id="sdk-container"/);
  assert.equal(expanded.includes("hidden="), false);
});

test("credential completion survives later confirmation but never accepts registration or unavailable results", () => {
  const credentialSnapshot = { status: "awaiting_payment_outcome", cryptogramId: "credential-reference" };
  assert.equal(credentialStepComplete(credentialSnapshot), true);
  assert.equal(credentialStepComplete({ status: "registration_ready", cryptogramId: "registration" }), false);
  assert.equal(credentialStepComplete({ status: "credential_unavailable", intentId: "instruction" }), false);
  assert.equal(credentialStepComplete({ status: "awaiting_payment_outcome" }), false);
  assert.equal(credentialStepComplete(undefined), false);
  const confirmation = { status: "completed" };
  assert.equal(credentialStepComplete(confirmation), false);
  assert.equal(credentialStepComplete(credentialSnapshot), true);
});
