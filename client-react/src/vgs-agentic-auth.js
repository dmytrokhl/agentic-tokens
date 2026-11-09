/**
 * VgsAgenticAuth — client-side library for Visa device binding.
 *
 * Wraps the iframe lifecycle, postMessage flow, API calls, and assuranceData
 * transformation into a simple step-by-step API:
 *
 *   const flow = new VgsAgenticAuth({ tokenId, environment, consumerEmail });
 *   const session = await flow.startSession(container);
 *   if (session.needsOtp) {
 *     // integrator picks one of session.otpMethods (e.g. via UI)
 *     await session.requestOtp(chosenMethod);
 *     await session.submitOtp("456789");
 *   }
 *   if (session.needsPasskey) {
 *     // reveal session.iframe for the passkey ceremony
 *   }
 *   const assuranceData = await session.authenticate();
 *
 * The flow (OTP and/or passkey) is driven by the server: `needsOtp` and `needsPasskey`
 * come from the device-attestation response. A passkey-exempt tenant reports
 * `needsPasskey === false`; authenticate() then resolves without a passkey ceremony.
 *
 * @module vgs-agentic-auth
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENVIRONMENTS = {
  // Internal only — for local development. Not publicly documented.
  local: {
    apiBase: "http://localhost:8081",
    iframeOrigin: "https://sbx.vts.auth.visa.com",
    // public api key
    apiKey: "WJHJ5RL6IHGG1OIRKWML21B9ihFOrGC-unbUUwYmPqRPF3YGs",
  },
  // Internal only. Not publicly documented.
  dev: {
    apiBase: "https://gw-01-sandbox.vgsapi.io",
    iframeOrigin: "https://sbx.vts.auth.visa.com",
    // public api key
    apiKey: "WJHJ5RL6IHGG1OIRKWML21B9ihFOrGC-unbUUwYmPqRPF3YGs",
  },
  sandbox: {
    apiBase: "https://gw-01-sandbox.vgsapi.com",
    iframeOrigin: "https://sbx.vts.auth.visa.com",
    // public api key
    apiKey: "WJHJ5RL6IHGG1OIRKWML21B9ihFOrGC-unbUUwYmPqRPF3YGs",
  },
  live: {
    apiBase: "https://gw-01-live.vgsapi.com",
    iframeOrigin: "https://vts.auth.visa.com",
    // public api key
    apiKey: "G908GCRYXDB09PTM2UCE21sH3cY2Sw4R2xovFpG5JDF57i-FQ"
  },
};

// const CLIENT_APP_ID = "VGSVicProvisionToken";
const CLIENT_APP_ID = "VGS";

// The demo shows the Visa passkey prompt inline. Preparation keeps the iframe hidden.
const VISA_IFRAME_WIDTH = "390";
const VISA_IFRAME_HEIGHT = "400";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

class VgsAgenticAuthError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status]  HTTP status (when error originates from API)
   * @param {string} [opts.code]    Machine-readable error code from API
   */
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "VgsAgenticAuthError";
    this.status = status ?? null;
    this.code = code ?? null;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _verificationError(code, message) {
  return new VgsAgenticAuthError(message, { code });
}

function _browserWait({ source, origin, type, requestID, timeout, assertCurrent, checkClosed = false }) {
  let cancel;
  let deliverManual;
  const promise = new Promise((resolve, reject) => {
    let timer;
    let poll;
    let active = true;
    const cleanup = () => {
      active = false;
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener("message", handler);
    };
    const fail = (error) => { cleanup(); reject(error); };
    cancel = () => fail(_verificationError("verification_cancelled", "Verification was cancelled"));
    deliverManual = (data) => {
      if (!active) throw _verificationError("verification_expired", "Verification attempt has ended");
      assertCurrent();
      cleanup();
      resolve(data);
    };
    function handler(event) {
      if (event.origin !== origin || event.source !== source) return;
      if (requestID && event.data?.requestID !== requestID) return;
      if (![type, "AUTH_FAILED", "AUTH_CANCELLED", "AUTH_NOT_SUPPORTED", "AUTH_NOT_PERFORMED"].includes(event.data?.type)) return;
      try {
        assertCurrent();
        if (event.data.type !== type) {
          throw _verificationError(event.data.type.toLowerCase(), "Visa verification did not complete");
        }
        cleanup();
        resolve(event.data);
      } catch (error) { fail(error); }
    }
    window.addEventListener("message", handler);
    if (timeout != null) {
      timer = setTimeout(() => fail(_verificationError("verification_timeout", "Verification timed out")), timeout);
    }
    poll = setInterval(() => {
      try {
        assertCurrent();
        if (checkClosed && source.closed) throw _verificationError("verification_cancelled", "Verification window was closed");
      } catch (error) { fail(error); }
    }, 100);
  });
  return { promise, cancel, deliverManual };
}

function _callbackAddress(value, mock) {
  let url;
  try { url = new URL(value); } catch {
    throw _verificationError("callback_configuration_required", "A callback URL is required");
  }
  if (url.username || url.password || url.hash || url.search || url.protocol !== "https:") {
    throw _verificationError("callback_configuration_required", "Use an HTTPS callback URL without query parameters");
  }
  if (mock) _localOrigin(url.origin);
  return url;
}

function _localOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new VgsAgenticAuthError("Mock configuration requires an exact loopback origin");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new VgsAgenticAuthError("Mock configuration requires an exact loopback origin");
  }
}

async function _postJson(apiBase, path, body, accessToken) {
  const url = `${apiBase}${path}`;
  const headers = { "Content-Type": "application/vnd.api+json" };
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new VgsAgenticAuthError(`Network error: ${err.message}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg = data?.detail || data?.error || res.statusText;
    throw new VgsAgenticAuthError(`API ${res.status}: ${msg}`, {
      status: res.status,
      code: data?.error,
    });
  }
  return data;
}

function _sendIframeCommand(iframeEl, origin, requestID, extra) {
  const command = {
    requestID,
    version: "1",
    contentType: "application/json",
    ...extra,
  };
  iframeEl.contentWindow.postMessage(command, origin);
}

/**
 * Listen for a single iframe postMessage of a given type.
 * Resolves with event.data. Rejects on timeout. Cleans up automatically.
 */
function _waitForIframeMessage(origin, expectedType, timeoutMs, context) {
  return new Promise((resolve, reject) => {
    let timer;

    function handler(event) {
      if (event.origin !== origin) return;
      if (context && event.source !== context.source()) return;
      if (context?.requestID && event.data?.requestID !== context.requestID) return;
      if (event.data?.type !== expectedType) return;
      cleanup();
      resolve(event.data);
    }

    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", handler);
    }

    window.addEventListener("message", handler);
    timer = setTimeout(() => {
      cleanup();
      reject(
        new VgsAgenticAuthError(
          `Timeout waiting for iframe message "${expectedType}" (${timeoutMs}ms)`,
        ),
      );
    }, timeoutMs);
  });
}

function _transformAssuranceData(rawAssurance, dfpSessionID) {
  return [
    {
      methodResults: {
        identifier: rawAssurance.identifier || "",
        dfpSessionId: dfpSessionID,
        fidoAssertionData: { code: rawAssurance.fidoBlob || "" },
      },
      verificationType: "DEVICE",
      verificationResults: "01",
      verificationMethod: "23",
      verificationTimestamp: String(Math.floor(Date.now() / 1000)),
    },
  ];
}

/**
 * Create a Visa VTS auth iframe and append it to a container.
 * Returns the iframe element once it has been added to the DOM.
 */
function _createIframe(container, origin, apiKey, preparationMode) {
  const src = `${origin}/vts-auth/authenticate?apiKey=${apiKey}&clientAppID=${CLIENT_APP_ID}`;
  const iframe = document.createElement("iframe");
  iframe.src = src;
  iframe.title = "Visa authentication";
  iframe.width = preparationMode ? "0" : VISA_IFRAME_WIDTH;
  iframe.height = preparationMode ? "0" : VISA_IFRAME_HEIGHT;
  iframe.style.display = "block";
  iframe.style.width = preparationMode ? "0" : "100%";
  iframe.style.maxWidth = `${VISA_IFRAME_WIDTH}px`;
  iframe.style.height = preparationMode ? "0" : `${VISA_IFRAME_HEIGHT}px`;
  iframe.style.border = "none";
  iframe.allow = `${preparationMode ? "payment *; " : ""}publickey-credentials-get *; publickey-credentials-create *`;
  container.appendChild(iframe);
  return iframe;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const STATE_PREPARED = "prepared";
const STATE_OTP_METHOD_PENDING = "otp_method_pending";
const STATE_OTP_PENDING = "otp_pending";
const STATE_READY = "ready";
const STATE_AUTHENTICATING = "authenticating";
const STATE_COMPLETE = "complete";
const STATE_DESTROYED = "destroyed";

class Session {
  /**
   * @param {object} config        VgsAgenticAuth config
   * @param {HTMLIFrameElement} iframeEl
   * @param {string} requestID     From AUTH_READY
   * @param {object} sessionContext From AUTH_SESSION_CREATED (Visa pass-through)
   * @param {object} browserData   From AUTH_SESSION_CREATED (Visa pass-through)
   * @param {string} dfpSessionID  From AUTH_SESSION_CREATED
   * @param {object} attestationResult  Response from /device-attestations
   */
  constructor(
    config,
    iframeEl,
    requestID,
    sessionContext,
    browserData,
    dfpSessionID,
    attestationResult,
  ) {
    this._config = config;
    this._iframeEl = iframeEl;
    this._requestID = requestID;
    this._sessionContext = sessionContext;
    this._browserData = browserData;
    this._dfpSessionID = dfpSessionID;
    this._authContext = null;
    this._sessionClosed = false;
    this._contextSnapshot = this._currentContext();
    this._pendingCancel = null;
    this._manualWebCallback = null;
    this._popup = null;

    const attrs = attestationResult.data.attributes;

    // Server-driven flow selection: the attestation response tells us whether the
    // passkey ceremony is required for this tenant. Defaults to true when the field is
    // absent, so older backends and default tenants keep the full-FIDO behavior.
    this.needsPasskey = attrs.passkey_required !== false;

    if (config.preparationMode) {
      this._setPreparationResult(attrs);
      return;
    }

    if (
      attrs.status === "CHALLENGE" &&
      Array.isArray(attrs.stepUpRequest)
    ) {
      this._state = STATE_OTP_METHOD_PENDING;
      this.needsOtp = true;
      this.otpMethods = attrs.stepUpRequest;
    } else {
      this._state = STATE_READY;
      this.needsOtp = false;
      this.otpMethods = [];
      this._authContext = attrs.authenticationContext;
    }
  }

  /**
   * The library-managed iframe element.
   * Useful for showing/hiding during the FIDO ceremony (e.g. iframe.width = 300).
   * @type {HTMLIFrameElement}
   */
  get iframe() {
    return this._iframeEl;
  }

  /**
   * Request OTP delivery via the chosen method.
   *
   * Only callable when `needsOtp` is true. The integrator must pick one of
   * `session.otpMethods` (the list returned from device attestation) and pass
   * the full method object here.
   *
   * Re-callable: while OTP is pending, call this again to resend, or pass a
   * different method to switch channel (e.g. SMS → email).
   *
   * @param {object} method  One of `session.otpMethods` — must include `identifier`
   */
  async requestOtp(method) {
    this._guardState(
      [STATE_OTP_METHOD_PENDING, STATE_OTP_PENDING],
      "requestOtp",
    );

    if (!method || !method.identifier) {
      throw new VgsAgenticAuthError(
        "requestOtp requires a method object with an identifier (use one of session.otpMethods)",
      );
    }

    const known = this.otpMethods.some(
      (m) => m.identifier === method.identifier,
    );
    if (!known) {
      throw new VgsAgenticAuthError(
        "Unknown OTP method (not in session.otpMethods)",
      );
    }

    await _postJson(
      this._config.apiBase,
      `/agentic-tokens/${this._config.tokenId}/otp/${method.identifier}`,
      {
        data: {
          type: "otp_methods",
          attributes: { client_ref_id: this._config.clientRefId },
        },
      },
      this._config.accessToken,
    );

    this._state = STATE_OTP_PENDING;
  }

  /**
   * Submit an OTP code. Must be called after `requestOtp` has triggered delivery.
   * @param {string} code  The OTP code entered by the cardholder
   */
  async submitOtp(code) {
    this._guardState(STATE_OTP_PENDING, "submitOtp");

    if (!code || typeof code !== "string") {
      throw new VgsAgenticAuthError("OTP code must be a non-empty string");
    }

    const result = await _postJson(this._config.apiBase, `/agentic-tokens/${this._config.tokenId}/otp`, {
      data: {
        type: "otp_submissions",
        attributes: {
          otp: code,
          client_ref_id: this._config.clientRefId,
          consumer_email: this._config.consumerEmail,
          session_context: this._sessionContext,
          browser_data: this._browserData,
        },
      },
    }, this._config.accessToken);

    this._authContext = result.data.attributes.authenticationContext;
    this._state = STATE_READY;
  }

  /**
   * Continue user verification. Europe sessions separate registration from payment authentication.
   * @returns {Promise<Array|object>} PAYMENT assurance data or the next pending verification phase.
   */
  async authenticate() {
    if (this._config.preparationMode && this._state !== STATE_DESTROYED) {
      if (!this._config.getCheckoutContext) {
        throw _verificationError("preparation_continuation_unavailable", "Current checkout context is required to continue");
      }
      return this._continueEurope();
    }
    this._guardState(STATE_READY, "authenticate");

    // Passkey-exempt tenants skip the FIDO ceremony entirely. The backend supplies the
    // assuranceData waiver for these tenants, so we return an empty array — safe to send
    // as-is. Calling authenticate() here stays valid so existing integrations that always
    // call it keep working without code changes.
    if (!this.needsPasskey) {
      this._closeSession();
      this._state = STATE_COMPLETE;
      return [];
    }

    if (!this._authContext) {
      throw new VgsAgenticAuthError(
        "No authenticationContext available. Was attestation successful?",
      );
    }

    this._state = STATE_AUTHENTICATING;

    // Start listening before sending the command to avoid race
    const authCompletePromise = _waitForIframeMessage(
      this._config._iframeOrigin,
      "AUTH_COMPLETE",
      this._config.timeout,
    );

    _sendIframeCommand(
      this._iframeEl,
      this._config._iframeOrigin,
      this._requestID,
      {
        type: "AUTHENTICATE",
        authenticationContext: this._authContext,
      },
    );

    const data = await authCompletePromise;

    // Close the iframe session
    this._closeSession();

    const assuranceData = _transformAssuranceData(
      data.assuranceData,
      this._dfpSessionID,
    );

    this._state = STATE_COMPLETE;
    return assuranceData;
  }

  /**
   * Clean up the session. Closes the iframe auth session and removes the
   * iframe from the DOM. Safe to call multiple times.
   */
  destroy() {
    if (this._state === STATE_DESTROYED) return;
    if (this._pendingCancel) this._pendingCancel();
    this._manualWebCallback = null;
    if (this._popup && !this._popup.closed) this._popup.close();
    this._closeSession();
    try {
      this._iframeEl.remove();
    } catch {
      /* ignore */
    }
    this._state = STATE_DESTROYED;
  }

  // -- internal --

  _currentContext() {
    return JSON.stringify([
      this._config.tokenId, this._config.clientRefId, this._config.consumerEmail,
      this._config.checkoutContext, this._config.authenticationAmount,
      this._config.currencyCode, this._config.merchantName, this._config.merchantUrl, this._config.consumerLocale, this._config.callbackUrl,
      this._config.apiBase, this._config._iframeOrigin,
      this._requestID, this._sessionContext, this._browserData, this._dfpSessionID,
      this._authContext, this.webChallenge,
    ]);
  }

  _assertCurrent() {
    if (this._state === STATE_DESTROYED) throw _verificationError("verification_cancelled", "Session has been destroyed");
    if (typeof this._config.checkoutContext !== "string" || !this._config.checkoutContext ||
        typeof this._config.getCheckoutContext !== "function") {
      throw _verificationError("checkout_context_required", "Current checkout context is required for verification");
    }
    if (this._config.getCheckoutContext() !== this._config.checkoutContext || this._currentContext() !== this._contextSnapshot) {
      throw _verificationError("checkout_context_changed", "Checkout context changed. Start a new session");
    }
  }

  // Local sandbox recovery while the allowlisted callback host has no page.
  submitSandboxCallbackUrl(value) {
    _localOrigin(window.location.origin);
    const pending = this._manualWebCallback;
    if (!pending || this._state !== STATE_AUTHENTICATING) {
      throw _verificationError("verification_not_pending", "Open 3DS verification before entering its return URL");
    }
    let returned;
    try { returned = new URL(value); } catch {
      throw _verificationError("invalid_callback", "Enter the complete Visa return URL");
    }
    const expected = pending.callback;
    if (returned.origin !== expected.origin || returned.pathname !== expected.pathname || returned.hash ||
        returned.username || returned.password ||
        [...returned.searchParams.keys()].some((key) => !["attempt_id", "frontend_origin", "stepupresponse", "stepupauthcode"].includes(key)) ||
        ["attempt_id", "frontend_origin", "stepupresponse", "stepupauthcode"].some((key) => returned.searchParams.getAll(key).length > 1) ||
        returned.searchParams.get("attempt_id") !== pending.attempt ||
        returned.searchParams.get("frontend_origin") !== window.location.origin) {
      throw _verificationError("invalid_callback", "Return URL does not match this verification attempt");
    }
    const result = returned.searchParams.get("stepupresponse")?.toLowerCase();
    if (!["approved", "declined", "failure"].includes(result)) {
      throw _verificationError("invalid_callback", "Return URL has no valid verification result");
    }
    pending.deliver({ attempt_id: pending.attempt, stepupresponse: result,
      ...(returned.searchParams.has("stepupauthcode") ? { stepupauthcode: returned.searchParams.get("stepupauthcode") } : {}) });
  }

  async _continueEurope() {
    this._guardState(STATE_PREPARED, "authenticate");
    this._assertCurrent();
    const phase = this.preparationState;
    if (!["web_challenge_pending", "registration_ready", "authentication_ready", "awaiting_payment"].includes(phase)) {
      throw _verificationError("unsupported_context", "Visa did not return a supported verification context");
    }
    this._state = STATE_AUTHENTICATING;
    try {
      if (phase === "web_challenge_pending") return await this._verifyWebChallenge();
      if (phase === "registration_ready") {
        await this._runEuropeCeremony(false);
        if (this._config.registrationOnly) {
          this._state = STATE_COMPLETE;
          this.preparationState = "registration_complete";
          this._closeSession();
          return { status: "registration_complete" };
        }
        const attrs = await this._continuationOptions("registration_complete", "AUTHENTICATE", "PAYMENT");
        this._setPreparationResult(attrs);
        if (this.preparationState !== "authentication_ready") {
          throw _verificationError("unsupported_context", "Visa did not return PAYMENT authentication context");
        }
        this.preparationState = "awaiting_payment";
        return { status: "awaiting_payment" };
      }
      const completed = await this._runEuropeCeremony(true);
      const raw = completed.assuranceData;
      const identifier = raw?.identifier ?? this._authContext.identifier;
      if (!raw?.fidoBlob || !identifier) throw _verificationError("payment_evidence_unavailable", "Visa returned no PAYMENT evidence");
      const assurance = _transformAssuranceData({ ...raw, identifier }, this._dfpSessionID);
      assurance[0].verificationEntity = "10";
      this._state = STATE_COMPLETE;
      this.preparationState = "complete";
      this._closeSession();
      return assurance;
    } catch (error) {
      if (this._state !== STATE_DESTROYED) this._state = "failed";
      this.preparationState = "failed";
      throw error;
    } finally {
      this._pendingCancel = null;
      this._manualWebCallback = null;
      if (this._popup && !this._popup.closed) this._popup.close();
      this._popup = null;
      this._iframeEl.width = "0";
      this._iframeEl.height = "0";
      this._iframeEl.style.width = "0";
      this._iframeEl.style.height = "0";
    }
  }

  async _verifyWebChallenge() {
    const callback = _callbackAddress(this._config.callbackUrl, this._config._mock);
    const source = new URL(this.webChallenge.source);
    if (source.protocol !== "https:" || source.username || source.password) {
      throw _verificationError("unsupported_context", "Visa returned an unsupported challenge URL");
    }
    if (this._config._mock) _localOrigin(source.origin);
    const attempt = crypto.randomUUID();
    callback.searchParams.set("attempt_id", attempt);
    callback.searchParams.set("frontend_origin", window.location.origin);
    source.searchParams.set("wpcallback", callback.href);
    this._popup = window.open("about:blank", "_blank", "popup,width=500,height=650");
    if (!this._popup) throw _verificationError("popup_blocked", "Allow popups to continue verification");
    const wait = _browserWait({ source: this._popup, origin: callback.origin, type: "vgs:3ds-result",
      timeout: this._config.verificationTimeout, assertCurrent: () => this._assertCurrent(), checkClosed: true });
    this._pendingCancel = wait.cancel;
    if (["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) {
      this._manualWebCallback = { callback, attempt, deliver: wait.deliverManual };
    }
    // The callback attempt is local correlation data. It contains no card or Visa session data.
    this._popup.location.href = source.href;
    let result;
    try {
      result = await wait.promise;
    } finally { this._pendingCancel = null; }
    if (result.attempt_id !== attempt) throw _verificationError("callback_attempt_mismatch", "Verification attempt does not match");
    if (result.stepupresponse === "declined") throw _verificationError("verification_declined", "Issuer declined verification");
    if (result.stepupresponse === "failure") throw _verificationError("verification_failed", "Issuer verification failed");
    if (result.stepupresponse !== "approved") throw _verificationError("invalid_callback", "Invalid verification result");
    if (result.stepupauthcode != null && (typeof result.stepupauthcode !== "string" || !result.stepupauthcode)) {
      throw _verificationError("invalid_callback", "Invalid issuer authentication code");
    }
    const attrs = await this._continuationOptions("web_challenge", "REGISTER", "DEVICE_BINDING", result.stepupauthcode);
    this._setPreparationResult(attrs);
    if (this.preparationState !== "registration_ready") throw _verificationError("unsupported_context", "Visa did not return REGISTER context");
    return { status: "registration_ready" };
  }

  async _continuationOptions(continuation, authType, reasonCode, issuerAuthCode) {
    this._assertCurrent();
    const result = await _postJson(this._config.apiBase,
      `/agentic-tokens/${this._config.tokenId}/device-attestations`, {
        data: { type: "device_attestations", attributes: {
          browserData: this._browserData, sessionContext: this._sessionContext,
          client_ref_id: this._config.clientRefId, consumer_email: this._config.consumerEmail,
          preparation: true, continuation, auth_type: authType, reason_code: reasonCode,
          ...(issuerAuthCode ? { issuer_auth_code: issuerAuthCode } : {}),
          ...(this._config.authenticationAmount != null ? { authentication_amount: this._config.authenticationAmount } : {}),
          ...(this._config.currencyCode != null ? { currency_code: this._config.currencyCode } : {}),
          ...(this._config.merchantName ? { merchant_name: this._config.merchantName } : {}),
          ...(this._config.merchantUrl ? { merchant_url: this._config.merchantUrl } : {}),
          consumer_locale: this._config.consumerLocale,
        } },
      }, this._config.accessToken);
    this._assertCurrent();
    return result.data.attributes;
  }

  async _runEuropeCeremony(payment) {
    this._assertCurrent();
    if (this._authContext?.action !== (payment ? "AUTHENTICATE" : "REGISTER")) {
      throw _verificationError("unsupported_context", "Visa verification phase does not match");
    }
    let target = this._iframeEl.contentWindow;
    let requestID = this._requestID;
    if (payment) {
      this._popup = window.open("about:blank", "_blank", "popup,width=400,height=480");
      if (!this._popup) throw _verificationError("popup_blocked", "Allow popups to authenticate payment");
      const ready = _browserWait({ source: this._popup, origin: this._config._iframeOrigin, type: "AUTH_READY",
        timeout: this._config.timeout, assertCurrent: () => this._assertCurrent(), checkClosed: true });
      this._pendingCancel = ready.cancel;
      this._popup.location.href = this._iframeEl.src;
      requestID = (await ready.promise).requestID;
      if (typeof requestID !== "string" || !requestID) throw _verificationError("unsupported_context", "Missing popup requestID");
      target = this._popup;
    } else {
      this._iframeEl.width = "350";
      this._iframeEl.height = "450";
      this._iframeEl.style.width = "350px";
      this._iframeEl.style.height = "450px";
    }
    const complete = _browserWait({ source: target, origin: this._config._iframeOrigin, type: "AUTH_COMPLETE", requestID,
      timeout: this._config.verificationTimeout, assertCurrent: () => this._assertCurrent(), checkClosed: payment });
    this._pendingCancel = complete.cancel;
    target.postMessage({ requestID, version: "1", contentType: "application/json", type: "AUTHENTICATE",
      authenticationContext: this._authContext }, this._config._iframeOrigin);
    const result = await complete.promise;
    this._assertCurrent();
    if (result.result !== "COMPLETE") throw _verificationError("verification_incomplete", "Visa verification did not complete");
    return result;
  }

  _setPreparationResult(attrs) {
    this._state = STATE_PREPARED;
    this.needsOtp = false;
    this.otpMethods = [];
    this._authContext = attrs.authenticationContext;
    this.authenticationAction = this._authContext?.action || null;
    this.needsWebChallenge = false;
    this.webChallenge = null;
    if (attrs.status === "CHALLENGE" || attrs.result === "CHALLENGE") {
      const methods = Array.isArray(attrs.stepUpRequest) ? attrs.stepUpRequest : [];
      this.webChallenge = methods.find(
        (method) => method.method === "APP-TO-APP" && method.platformType === "WEB",
      ) || null;
      this.needsWebChallenge = this.webChallenge !== null;
      this.otpMethods = methods.filter(
        (method) => ["OTPSMS", "OTPEMAIL", "OTPONLINEBANKING"].includes(method.method),
      );
      this.needsOtp = !this.needsWebChallenge && this.otpMethods.length > 0;
      this.preparationState = this.needsWebChallenge ? "web_challenge_pending"
        : this.needsOtp ? "otp_challenge_pending" : "unsupported_challenge";
    } else {
      const completeContext = ["endpoint", "identifier", "payload"].every(
        (field) => typeof this._authContext?.[field] === "string" && this._authContext[field].length > 0,
      );
      this.preparationState = !completeContext ? "unsupported_context"
        : this.authenticationAction === "AUTHENTICATE" ? "authentication_ready"
        : this.authenticationAction === "REGISTER" ? "registration_ready" : "unsupported_context";
    }
    this._contextSnapshot = this._currentContext();
  }

  _guardState(expected, method) {
    if (this._state === STATE_DESTROYED) {
      throw new VgsAgenticAuthError("Session has been destroyed");
    }
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(this._state)) {
      throw new VgsAgenticAuthError(
        `Cannot call ${method}() in state "${this._state}" (expected ${allowed.map((s) => `"${s}"`).join(" or ")})`,
      );
    }
  }

  _closeSession() {
    if (this._sessionClosed) return;
    try {
      _sendIframeCommand(
        this._iframeEl,
        this._config._iframeOrigin,
        this._requestID,
        { type: "CLOSE_AUTH_SESSION" },
      );
    } catch {
      // iframe may already be gone — ignore
    }
    this._sessionClosed = true;
  }
}

// ---------------------------------------------------------------------------
// VgsAgenticAuth
// ---------------------------------------------------------------------------

class VgsAgenticAuth {
  /**
   * @param {object} options
   * @param {string} options.tokenId       Provisioned token ID from card enrollment
   * @param {string} options.environment   "sandbox" or "live"
   * @param {string} options.consumerEmail Consumer email address for identity verification
   * @param {string} [options.accessToken] Bearer token for API authentication
   * @param {string} [options.clientRefId] Unique trace ID (auto-generated if omitted)
   * @param {string} [options.preparationMode] Use "vic-v2-europe" to stop before user verification.
   * @param {boolean} [options.registrationOnly] Finish after registration. Authenticate a purchase in a separate session.
   * @param {string} [options.authenticationAmount] Amount in major currency units for verification.
   * @param {string} [options.currencyCode] Currency code for the current purchase.
   * @param {string} [options.merchantName] Merchant name for verification.
   * @param {string} [options.merchantUrl] HTTPS merchant application URL for verification.
   * @param {string} [options.consumerLocale] Consumer language and country, such as en_US.
   * @param {string} [options.callbackUrl] HTTPS return page for browser verification.
   * @param {string} [options.checkoutContext] Current buyer, card, and checkout key.
   * @param {Function} [options.getCheckoutContext] Read the current checkout key before continuation.
   * @param {string} [options.mockVppOrigin] Exact loopback provider origin for local simulation.
   * @param {string} [options.mockApiBase] Exact loopback API origin for local simulation.
   * @param {number} [options.timeout] Timeout in ms for iframe setup and browser verification.
   * Europe verification has no default time limit. Iframe setup and legacy verification default to 30000 ms.
   */
  constructor({ tokenId, environment, consumerEmail, accessToken, clientRefId, timeout,
                authenticationAmount, currencyCode, merchantName, merchantUrl, consumerLocale = "en_US", preparationMode,
                mockVppOrigin, mockApiBase, callbackUrl, checkoutContext, getCheckoutContext, startDeviceBinding = false, registrationOnly = false } = {}) {
    if (!tokenId) throw new VgsAgenticAuthError("tokenId is required");
    if (!environment) throw new VgsAgenticAuthError("environment is required");
    if (!consumerEmail) throw new VgsAgenticAuthError("consumerEmail is required");

    const env = ENVIRONMENTS[environment];
    if (!env) {
      throw new VgsAgenticAuthError(
        `Unknown environment "${environment}". Use "sandbox" or "live".`,
      );
    }

    if (preparationMode !== undefined && preparationMode !== "vic-v2-europe") {
      throw new VgsAgenticAuthError("Unknown preparationMode");
    }
    if (startDeviceBinding && preparationMode !== "vic-v2-europe") {
      throw new VgsAgenticAuthError("New device binding requires Europe preparation");
    }
    if (typeof registrationOnly !== "boolean" || (registrationOnly && preparationMode !== "vic-v2-europe")) {
      throw new VgsAgenticAuthError("Registration-only sessions require Europe preparation and a boolean option");
    }
    this.registrationOnly = registrationOnly;
    this.startDeviceBinding = startDeviceBinding;
    this.preparationMode = preparationMode || null;
    if (mockVppOrigin !== undefined || mockApiBase !== undefined) {
      if (environment !== "local" || !mockVppOrigin) {
        throw new VgsAgenticAuthError("Mock origins require the local environment and mockVppOrigin");
      }
      _localOrigin(window.location.origin);
      _localOrigin(mockVppOrigin);
      _localOrigin(mockApiBase === undefined ? env.apiBase : mockApiBase);
    }

    this.callbackUrl = callbackUrl;
    this.checkoutContext = checkoutContext;
    this.getCheckoutContext = getCheckoutContext;
    this._mock = Boolean(mockVppOrigin);
    this.tokenId = tokenId;
    this.consumerEmail = consumerEmail;
    this.apiBase = mockApiBase || env.apiBase;
    this.accessToken = accessToken || null;
    this.clientRefId = clientRefId || crypto.randomUUID();
    this.timeout = timeout ?? 30_000;
    this.verificationTimeout = timeout;
    this._iframeOrigin = mockVppOrigin || env.iframeOrigin;
    this._apiKey = env.apiKey;
    this.authenticationAmount = this.preparationMode ? authenticationAmount : authenticationAmount || "100";
    this.currencyCode = this.preparationMode ? currencyCode : currencyCode || "840";
    this.merchantName = merchantName || null;
    this.merchantUrl = merchantUrl || null;
    this.consumerLocale = consumerLocale;
  }

  /**
   * Start a device binding session.
   *
   * Creates the Visa iframe, waits for it to be ready, creates an auth session,
   * calls /device-attestations, and returns a Session object.
   *
   * The iframe is appended to `container` (defaults to document.body).
   * Access it via `session.iframe` to show/hide during the FIDO ceremony.
   *
   * @param {HTMLElement} [container=document.body]  Element to append the iframe to
   * @returns {Promise<Session>}
   */
  async startSession(container) {
    container = container || document.body;

    // Create iframe and start listening for AUTH_READY before it loads
    let iframeEl;
    const readyPromise = _waitForIframeMessage(
      this._iframeOrigin,
      "AUTH_READY",
      this.timeout,
      this.preparationMode ? { source: () => iframeEl?.contentWindow } : undefined,
    );

    iframeEl = _createIframe(container, this._iframeOrigin, this._apiKey, this.preparationMode);

    let requestID;
    try {
      const readyData = await readyPromise;
      requestID = readyData.requestID;
      if (this.preparationMode && (typeof requestID !== "string" || !requestID)) {
        throw new VgsAgenticAuthError("Missing browser session requestID");
      }
    } catch (err) {
      iframeEl.remove();
      throw err;
    }

    let sessionData;
    try {
      const sessionPromise = _waitForIframeMessage(
        this._iframeOrigin,
        "AUTH_SESSION_CREATED",
        this.timeout,
        this.preparationMode ? { source: () => iframeEl.contentWindow, requestID } : undefined,
      );
      _sendIframeCommand(iframeEl, this._iframeOrigin, requestID, {
        type: "CREATE_AUTH_SESSION",
        ...(this.preparationMode ? { client: { id: this._apiKey } } : {}),
      });
      sessionData = await sessionPromise;
      if (this.preparationMode && (
        sessionData.result !== "COMPLETE" || !sessionData.sessionContext?.secureToken ||
        !sessionData.browserData || !sessionData.dfpSessionID
      )) {
        throw new VgsAgenticAuthError("Incomplete browser session context");
      }
    } catch (err) {
      try {
        _sendIframeCommand(iframeEl, this._iframeOrigin, requestID, {
          type: "CLOSE_AUTH_SESSION",
        });
      } catch {
        /* ignore */
      }
      iframeEl.remove();
      throw err;
    }

    const { sessionContext, browserData, dfpSessionID } = sessionData;

    // Call device attestation API
    let attestationResult;
    try {
      attestationResult = await _postJson(
        this.apiBase,
        `/agentic-tokens/${this.tokenId}/device-attestations`,
        {
          data: {
            type: "device_attestations",
            attributes: {
              browserData,
              sessionContext,
              client_ref_id: this.clientRefId,
              consumer_email: this.consumerEmail,
              auth_type: "AUTHENTICATE",
              reason_code: "PAYMENT",
              ...(this.preparationMode ? { preparation: true, consumer_locale: this.consumerLocale, ...(this.startDeviceBinding ? { start_device_binding: true } : {}) } : {}),
              ...(this.authenticationAmount != null ? { authentication_amount: this.authenticationAmount } : {}),
              ...(this.currencyCode != null ? { currency_code: this.currencyCode } : {}),
              ...(this.merchantName ? { merchant_name: this.merchantName } : {}),
              ...(this.preparationMode && this.merchantUrl ? { merchant_url: this.merchantUrl } : {}),
            },
          },
        },
        this.accessToken,
      );
    } catch (err) {
      try {
        _sendIframeCommand(iframeEl, this._iframeOrigin, requestID, {
          type: "CLOSE_AUTH_SESSION",
        });
      } catch {
        /* ignore */
      }
      iframeEl.remove();
      throw err;
    }

    const session = new Session(
      this,
      iframeEl,
      requestID,
      sessionContext,
      browserData,
      dfpSessionID || "",
      attestationResult,
    );

    return session;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { VgsAgenticAuth, VgsAgenticAuthError };
