# Agentic Tokens — Sample App

Reference app demonstrating VGS Agentic Tokens API integration flows for Visa, Mastercard, and Amex.

## Prerequisites

You need a VGS **Client ID** and **Client Secret** to run this app. Follow the [Authentication guide](https://docs.verygoodsecurity.com/cmp/platform/authentication) to generate your credentials.

## Quick Start

```bash
cp .env.example .env
# Set VGS_CLIENT_ID and VGS_CLIENT_SECRET (see Prerequisites)

docker compose up --build
```

Open https://localhost:4200 (accept the self-signed certificate warning).

Frontend source changes reload through the development volume. Server routes are
baked into the image; after changing `server/`, rebuild and recreate that service:

```bash
docker compose up -d --no-deps --build server
```

## Architecture

- **Caddy** (port 4200) — serves the static frontend over HTTPS
- **Server** (port 3000) — Node.js API proxy that authenticates with VGS and forwards requests

## Flow

How the cardholder is verified depends on your vault's configuration, and **the app finds out
from the API**: the enroll response (step 2) reports `cardholder_verification` and
`agentic_enrollment_required`, and the remaining steps follow from those two fields. Nothing to
configure — the header shows which flow was detected.

**Passkey (FIDO)** — `cardholder_verification: "passkey"`:

1. **Create Card** — creates a sandbox test card
2. **Enroll Token** — provisions the card for agentic payments
3. **Device Binding** — FIDO/OTP authentication via the VgsAgenticAuth library (Visa iframe)
4. **Create Intent** — creates a spending authorization with mandates, using the `assurance_data` from step 3
5. **Get Cryptogram** — retrieves DPAN + cryptogram for payment
6. **Confirm Transaction** — reports the payment outcome back to the intent

**Cardholder ID&V** — `cardholder_verification: "otp"`, for passkey-exempt vaults. No iframe, no passkey, no `assurance_data`:

1. **Create Card**
2. **Enroll Token**
3. **Cardholder Verification (ID&V)** — fetch verification options, send a one-time code, submit it
4. **Complete Enrollment** — finishes enrolling the token; required after verification and before any intent
5. **Create Intent** — no `assurance_data` field
6. **Get Cryptogram**
7. **Confirm Transaction**

A vault may also report `cardholder_verification: "none"` — no verification step at all — in
which case the app goes straight from enrollment to creating an intent.

Both flows above are Visa. Mastercard now uses the same simple verification panel
as Amex, with one extra step to retrieve the available OTP methods:

- Mastercard: Create Card → Enroll Token → Get Verification Options → Cardholder
  Verification → Checkout Cryptogram.
- Amex: Create Card → Enroll Token → Cardholder Verification (when enrollment asks
  for OTP) → Get Payment Credential. Amex supplies its options during enrollment.

Both use the shared `/agentic-tokens/{token_id}/otp/{identifier}` and
`/agentic-tokens/{token_id}/otp` endpoints. Mastercard lookup uses
`GET /agentic-tokens/{token_id}/step-up-options?client_ref_id=vgs:ms:v1:<uuid>`.
The demo generates that marker automatically. It treats method identifiers and
references as opaque: the original lookup reference is used to send/resend a code,
while the latest `client_ref_id` returned by delivery or pending verification is
used to check the code. No customer-facing correlation, affinity, locale or session
fields are needed. The old Mastercard-only Start/Complete panels and proxy routes
have been removed. Maranui exposes OTP through the common endpoints; credential
issuance uses the shared card-scoped `/cryptograms` endpoint.

Choose SMS or email, press **Send Code**, then **Verify Code**. Mastercard starts
with an empty code field; no sandbox code is assumed. Only `status: VALIDATED`
completes Mastercard verification. `PENDING`, rejection, malformed responses and
HTTP errors do not enable checkout. New lookup, changing channels, resending,
changing the card and re-enrollment invalidate previous verification. Expired
context errors offer **Get New Verification Options**. There are no automatic
OTP retries. Verification state lives only in browser memory.

The same verification UI preserves Amex/Visa references when the API doesn't
return a replacement. Visa's separate enrollment/passkey flows and Amex payment
credential OTP challenges remain available. Mastercard shared OTP verifies the
cardholder; it does not perform FIDO registration/binding or turn issuer proof into
payment proof. The SCOF checkout remains separate.

Deploy the updated Maranui shared OTP implementation before using this demo flow.
No additional OTP secret or environment variable is required. Continuation
references use Base64url-encoded JSON, not encryption or a signature; clients
should return them unchanged. Restart existing OTP flows from lookup when moving
from the encrypted format. The demo displays complete API response bodies, including error envelopes,
metadata and continuation references, without additional client-side redaction.
The shared proxy still omits OTP payloads from server logs, including sandbox debug
mode.

To exercise both channels against a local simulated Maranui through Express and
Netlify, without sending real codes:

```sh
node --experimental-strip-types --test server/tests/mastercard-otp-flow.test.mjs
cd client-react && npm test && npm run build
```

The tests cover lookup, delivery, rejection, pending reference rotation, successful
verification and resend. They do not validate real issuer delivery.

For Visa v2 Europe, open `?flow=visa-v2-europe` on the demo URL.
Create a Visa sandbox card and enroll it with a consumer email.
Enter the authentication amount, currency, merchant name, and HTTPS merchant URL.
Use **Prepare browser verification**, then complete each action that Visa requests.
Create a purchase request and complete its separate PAYMENT authentication before requesting a credential.
The first credential request also creates the Visa instruction.
The demo reports a selected sandbox outcome. It does not charge the card or establish settlement.

Set `AGENTIC_VISA_EU_CALLBACK_URL` on the demo server to the HTTPS callback URL approved for your integration.
Without this setting, the demo uses `/visa-3ds-callback.html` on its HTTPS origin.
Configure exact frontend origins in the deployed callback handler before testing.
Device-binding currency fields show numeric codes, such as `840 — USD`.
Purchase currency fields show letter codes, such as `USD`.

Each step auto-populates IDs into the next step.

After a successful Amex enrollment, a separate **Unenrollment (Amex)** block is
available below the payment step, without requesting a payment credential first.
It starts collapsed and opens only when its header is clicked; enrollment still
advances to OTP verification or payment credentials as usual. The editable ID defaults
to the latest enrollment. Open the block and click **Unenroll** to delete it, or paste
another ID. The block shows the HTTP status and response body, which remain visible
after deletion. Once the API confirms `deleted` for the current enrollment, the demo
clears its dependent flow state and returns to Enroll so the same stored card can be
enrolled again. A failed deletion preserves the enrollment. Each new enrollment resets
and collapses the Unenrollment block.
Docker and Netlify proxy this action to `DELETE /agentic-tokens/{token_id}`,
where `token_id` is the Amex enrollment ID returned as `data.id` during enrollment.

If Amex enrollment returns HTTP `409` with `detail: "Enrollment already exists."`,
the Enroll step also offers an editable enrollment ID and **Delete Enrollment**.
The error does not include the existing ID, so the field starts with the latest ID
from the current flow if available, or stays empty for manual entry. After a
confirmed deletion, click **Enroll** to retry; deletion does not complete enrollment.

The entire client side of the ID&V flow lives in one file — **`client-react/src/idv.ts`** — as four
plain `fetch` calls with no library dependency. If you're implementing this flow yourself, read
that file; the components around it are just forms.

> **Sandbox OTP:** Cardholder ID&V and Amex payment verification prefill `111111` when the server has `VGS_VAULT_ENV=sandbox`. The code remains editable; other environments start empty. The Visa device-binding demo uses its separate `456789` code.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VGS_CLIENT_ID` | (required) | OAuth client ID ([how to get one](https://docs.verygoodsecurity.com/cmp/platform/authentication)) |
| `VGS_CLIENT_SECRET` | (required) | OAuth client secret |
| `VGS_API_URL` | `https://gw-01-sandbox.vgsapi.com` | Agentic Tokens API base URL |
| `VGS_CMP_API_URL` | `https://sandbox.vgsapi.com` | Card Management Platform (CMP) API base URL |
| `VGS_VAULT_ENV` | `sandbox` | Vault environment; enables the sandbox OTP prefill |
| `PORT` | `3000` | Server port |

### API URLs by environment

| | Sandbox | Live |
|---|---|---|
| `VGS_API_URL` | `https://gw-01-sandbox.vgsapi.com` | `https://gw-01-live.vgsapi.com` |
| `VGS_CMP_API_URL` | `https://sandbox.vgsapi.com` | `https://vgsapi.com` |

## Deploy to Netlify

The repo is set up to deploy as a Netlify site: the React build is served as static assets and the Express proxy is replaced by Netlify Functions that share the same VGS client (`server/vgs.js`).

### Setup (one-time)

1. In Netlify, **Add new site → Import from Git** and connect this repo.
2. Build settings are picked up from `netlify.toml` — no overrides needed.
3. Set **Site settings → Environment variables**: `VGS_CLIENT_ID`, `VGS_CLIENT_SECRET` (required), plus any optional VGS URLs / vault settings.
4. **Branches → Production branch** = `main`. Every push to `main` triggers a fresh deploy.

### Local development with Netlify Functions

Docker (`docker compose up`) still works as before. To run the Netlify build locally instead:

```bash
npm install -g netlify-cli
netlify dev
```

`netlify dev` serves the Vite frontend and emulates the Functions, so the local environment matches production.

## Vellum — agentic SaaS demo

On top of the Agentic Tokens building blocks, the repo ships a quick-start demo of a fictional dev-tool startup called **Vellum**. It lets any AI agent connected via MCP:

1. render a marketing landing page preview from a small JSON params object,
2. attempt to publish — the server returns `payment_required` for a one-time $5 hosting charge,
3. on approval, run the existing VGS device-binding flow (TouchID / FIDO / OTP) and capture a cryptogram-backed payment,
4. retry `publish_site` with the same params — site becomes live at `https://<your-site>/s/<siteId>`.

The HTML is rendered by the MCP server from a fixed template. The LLM only supplies the structured params that fill the page.

Two transports ship together:

- **HTTP** — deployed at `/mcp` via `netlify/functions/mcp.js`. Connect a remote MCP client to `https://<your-site>/mcp` — no local install.
- **stdio** — `node mcp-server/src/index.js` for desktop MCP clients. Desktop mode can auto-open browser tabs at the right moments.
- **Codex CLI stdio** — `npm run mcp:codex` starts the same MCP server with URL handoff: it writes local previews to `/tmp`, opens the preview when possible, returns browser-flow URLs, and does not block waiting for GUI browser steps.

Codex CLI users can install the GitHub-hosted server directly:

```bash
codex mcp add vellum \
  --env AGENTIC_CLIENT_MODE=codex-cli \
  --env AGENTIC_APP_BASE_URL=https://vgs-agentic-tokens.netlify.app \
  -- npx -y github:vgs-samples/agentic-tokens
```

Recommended test prompt:

```text
Use the Vellum MCP server for this. Create a marketing landing page for Acme Coffee Co — premium coffee with a subscription. Call create_marketing_site first and show me the preview URL.
```

See `mcp-server/README.md` for the demo script, the tool contract, and copy-paste configs.

## Amex ACE 1.1

Use this demo branch with the matching ACE 1.1 API branch and deployment setting
`AMEX_SPEC_VERSION=1.1-20260618`. Enrollment fields are prefilled from the
`decryptedEnrollmentRequestPayload` example in `ACE-OAI-1.1_v6.yaml`: Jane Jones,
account `user-12345`, device `565266`, IP `192.168.1.1`, form factor `MOBILE`,
distinct billing last-name count `2`, and agent NexusAI (`gpt-4.1`). These are editable
demo values. The example's unsupported `AI_PLATFORM` placeholder is omitted;
select a supported platform at checkout. Browser language and user agent come from the browser and reuse the
Visa `browser_data` field vocabulary. Email and the checkout amount/currency/merchant
fields remain shared with the existing flows.

At checkout, explicitly select the agent platform, purchase approval and partner
verification outcome. This demo does not perform partner SMS/device/passkey authentication;
it only offers no partner step-up or unsuccessful partner step-up. It never invents a successful
verification or automatically consents. The API supports the full delegated-signoff metadata
for integrating applications that perform their own authentication.

A payment OTP challenge stays in the payment step, using the existing delivery/verification
API helpers. ACE 1.1's Verify OTP schema documents an enrollment result only. If that is what
the server returns, the demo reports that no credential was returned and leaves payment
incomplete. It does not automatically issue a second credential request.
