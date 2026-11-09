import assert from "node:assert/strict";
import { test } from "node:test";
import { europeBrowserConfig } from "../europe-config.js";

test("Europe browser verification uses the same environment as token enrollment", () => {
  for (const [VGS_API_URL, expected] of [
    ["https://gw-01-sandbox.vgsapi.io", "dev"],
    ["https://gw-01-sandbox.vgsapi.com", "sandbox"],
    ["http://localhost:8081", "local"],
    ["http://127.0.0.1:8081", "local"],
    ["http://host.docker.internal:8081", "local"],
    ["https://gw-01-live.vgsapi.com", null],
    ["https://unrecognized.example.test", null],
  ]) {
    assert.equal(europeBrowserConfig({ VGS_API_URL }).visaEnvironment, expected);
  }
});
