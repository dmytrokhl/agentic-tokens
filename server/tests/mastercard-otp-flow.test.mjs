import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStepUpOptions, requestOtp, submitOtp, readOtpDelivery, readOtpVerification } from "../../client-react/src/idv.ts";

// Real demo HTTP routes plus frontend builders/parsers; only Maranui is simulated.
// All URLs and credentials are local test fixtures.
test("SMS and email through Express and Netlify: lookup, delivery, rejected code, pending, verification and resend", async (t) => {
  const calls = [];
  const token = "synthetic-token";
  const originalRef = "vgs:ms:v1:test-attempt";
  let verificationRef;
  let revision = 0;
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/auth") return res.end(JSON.stringify({ access_token: "test-only", expires_in: 300 }));
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: req.url, method: req.method, body });
    const attrs = body?.data?.attributes;
    const root = `/agentic-tokens/${token}`;
    const reply = (type, id, attributes) => res.end(JSON.stringify({ data: { id, type, attributes } }));
    if (req.url.startsWith(`${root}/step-up-options?`)) {
      assert.equal(req.method, "GET");
      assert.equal(new URL(req.url, "http://test").searchParams.get("client_ref_id"), originalRef);
      return reply("device_attestations", token, { status: "CHALLENGE", passkey_required: false, stepUpRequest: [
        { method: "OTPSMS", identifier: "vgs:ms:v1:sms/protected==", value: "***2671" },
        { method: "OTPEMAIL", identifier: "vgs:ms:v1:email/protected==", value: "b***@example.test" },
      ] });
    }
    if (req.url.startsWith(`${root}/otp/`)) {
      assert.equal(attrs.client_ref_id, originalRef, "Delivery and resend must use the lookup reference");
      assert.equal(body.data.type, "otp_methods");
      verificationRef = `vgs:ms:v1:session-${++revision}`;
      const identifier = decodeURIComponent(req.url.slice(`${root}/otp/`.length));
      return reply("otp_methods", identifier, { method: "SMS", client_ref_id: verificationRef });
    }
    if (req.url === `${root}/otp`) {
      assert.equal(attrs.client_ref_id, verificationRef, "Verification must use the newest session reference");
      assert.equal(body.data.type, "otp_submissions");
      if (attrs.otp === "000000") {
        res.statusCode = 409;
        return res.end(JSON.stringify({ error: "mastercard_upstream_error", detail: "Verification failed" }));
      }
      if (attrs.otp === "111111") {
        verificationRef = `vgs:ms:v1:session-${++revision}`;
        return reply("otp_submissions", token, { status: "PENDING", client_ref_id: verificationRef });
      }
      assert.equal(attrs.otp, "012345");
      return reply("otp_submissions", token, { status: "VALIDATED", authenticationContext: null });
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Unexpected upstream route" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const env = { ...process.env, VGS_API_URL: origin, VGS_AUTH_URL: `${origin}/auth`, VGS_CMP_API_URL: origin,
    VGS_CLIENT_ID: "test-only", VGS_CLIENT_SECRET: "test-only", VGS_VAULT_ENV: "sandbox", PORT: "0" };
  const cwd = await mkdtemp(join(tmpdir(), "mastercard-otp-proxy-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bootstrap = `import net from 'node:net';
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
      this.once('listening', () => console.log('TEST_PORT=' + this.address().port));
      return listen.apply(this, args);
    };
    await import(${JSON.stringify(new URL("../server.js", import.meta.url).href)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", bootstrap], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Demo server did not start")), 10000);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/TEST_PORT=(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once("error", (err) => { clearTimeout(timeout); reject(err); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Demo server exited: ${code}`)); });
  });
  Object.assign(process.env, env);
  const handlers = Object.fromEntries(await Promise.all(["step-up-options", "otp"]
    .map(async (name) => [name, (await import(`../../netlify/functions/${name}.js`)).default])));
  const nativeFetch = globalThis.fetch;
  for (const adapter of ["Express", "Netlify"]) {
    for (const method of ["OTPSMS", "OTPEMAIL"]) {
      await t.test(`${adapter} ${method}`, async (t) => {
        t.mock.method(globalThis, "fetch", (url, options) => {
          if (typeof url !== "string" || !url.startsWith("/api/")) return nativeFetch(url, options);
          if (adapter === "Express") return nativeFetch(`http://127.0.0.1:${port}${url}`, options);
          const handler = url.startsWith("/api/step-up-options") ? handlers["step-up-options"] : handlers.otp;
          return handler(new Request(`http://demo.test${url}`, options));
        });
        const before = calls.length;
        const options = await getStepUpOptions(token, originalRef);
        const selected = options.methods.find((item) => item.method === method);
        const delivery = await requestOtp(token, originalRef, selected.identifier);
        let reference = readOtpDelivery(delivery, selected.identifier, originalRef);
        await assert.rejects(submitOtp(token, reference, "buyer@example.test", "000000"));
        const pending = readOtpVerification(await submitOtp(token, reference, "buyer@example.test", "111111"), token, reference);
        assert.equal(pending.status, "pending");
        reference = pending.clientRefId;
        assert.equal(readOtpVerification(await submitOtp(token, reference, "buyer@example.test", "012345"), token, reference).status, "verified");
        const resend = await requestOtp(token, originalRef, selected.identifier);
        assert.notEqual(readOtpDelivery(resend, selected.identifier, originalRef), reference);
        assert.equal(calls.length - before, 6, "No implicit retries or duplicate sends");
      });
    }
  }
});
