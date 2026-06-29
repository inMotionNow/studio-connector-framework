# Lytho Media Connector

A read-only [Chili Grafx Studio media connector](https://docs.chili-publish.com/GraFx-Studio/concepts/connectors/) that lets Studio users browse, search, and use images from the Lytho DAM directly inside template editing.

**Implemented interface methods:** `query`, `detail`, `download`, `getConfigurationOptions`, `getCapabilities`

**Upload/write is out of scope** — this connector is read-only.

---

## Prerequisites

- Node.js with Yarn
- `@chili-publish/connector-cli` (already in `devDependencies`)
- Access to the Chili Grafx "Lytho Production" environment (`cp-qbs-960`)
- The name of the Keycloak realm you will authenticate with (`<REALM>`)
- The Keycloak client secret for the target realm (`<SECRET>`)

---

## Step 1 — Create auth-data.json

Create `src/connectors/lytho/auth-data.json`. **This file is in `.gitignore` and must never be committed — it contains a client secret.**

```json
{
  "authorizationServerMetadata": {
    "authorization_endpoint": "https://login.us-1.golytho.us/auth/realms/<REALM>/protocol/openid-connect/auth",
    "token_endpoint": "https://login.us-1.golytho.us/auth/realms/<REALM>/protocol/openid-connect/token",
    "token_endpoint_auth_methods_supported": ["client_secret_basic"]
  },
  "clientId": "api-client",
  "clientSecret": "<SECRET>",
  "scope": "openid"
}
```

| Field | What to put there |
|---|---|
| `<REALM>` | The Keycloak realm for the target Lytho environment (e.g. `coreystaging` for the staging realm) |
| `clientId` | In staging I used `api-client`, but it required adding openid. May be better to create a dedicated client for your realm just for GraFx |
| `<SECRET>` | The client secret from Keycloak admin: **Clients → api-client → Credentials tab** |
| `scope` | Always `openid` — required for Keycloak to issue a proper OIDC token. Omitting it causes a `invalid_scope` error |
| `token_endpoint_auth_methods_supported` | Always `["client_secret_basic"]` — this is how `api-client` expects credentials (sent in the Authorization header). `client_secret_post` does not work |

---

## Step 2 — Build

```bash
cd src/connectors/lytho
yarn install

if this is your first time, run this to set up the workspace:
yarn workspace @chili-publish/connector-cli run build

yarn build
```

Output is written to `out/connector.js`.

---

## Step 3 — Log in to the CLI

```bash
cd src/connectors/lytho
yarn connector-cli login
```

The CLI prints a short URL and a code. Open the URL in a browser, enter the code, and the CLI stores your access token locally.

---

## Step 4 — Publish

```bash
yarn connector-cli publish \
  -b https://cp-qbs-960.chili-publish.online/grafx \
  -e cp-qbs-960 \
  -n Lytho \
  --connectorId c6d52e56-7772-41c6-be28-d20a7d75c7e7 \
  -ro BASE_URL=https://gcawifhrmwwmpw6mr2sco57p2a0txevm.lambda-url.us-east-1.on.aws \
  --proxyOption.allowedDomains "*.us-east-1.on.aws"
```

| Flag | Value | Notes |
|---|---|---|
| `-b` | `https://cp-qbs-960.chili-publish.online/grafx` | CLI appends `api/v1/...` itself — do **not** include it here |
| `-e` | `cp-qbs-960` | Chili Grafx environment ID |
| `--connectorId` | `c6d52e56-...` | Omit on first publish; include on re-deploys to update the existing connector |
| `-ro BASE_URL` | Lambda proxy URL | All connector endpoints go through this URL — point at the proxy, not the Lytho API directly |
| `--proxyOption.allowedDomains` | proxy domain only | Chili sandbox allowlist — only the proxy domain is needed now |

---

## Step 5 — Configure auth

Run **both** commands after every publish. Auth config is not preserved across publishes.

Two separate auth contexts are required because the connector is used in two different runtime modes:

- **Browser auth** — used when a Studio user browses or searches assets interactively. Currently configured with a client credentials flow (service account), same as server auth.
- **Server auth** — used when GraFx's rendering/export server fetches assets during document output. There is no user present, so it uses an OAuth2 client credentials flow (service account).

### Browser auth

```bash
yarn connector-cli set-auth \
  -b https://cp-qbs-960.chili-publish.online/grafx \
  -e cp-qbs-960 \
  --connectorId c6d52e56-7772-41c6-be28-d20a7d75c7e7 \
  -au browser \
  -at oAuth2ClientCredentials \
  --auth-data-file ./auth-data-dev-server.json
```

> **Note:** Browser auth now uses the same service account credentials as server auth (`auth-data-dev-server.json`). If you need to authenticate as a real individual user (e.g., to test the authorization code / user-login flow), use the command below with `auth-data.json` instead:
> ```bash
> yarn connector-cli set-auth \
>   -b https://cp-qbs-960.chili-publish.online/grafx \
>   -e cp-qbs-960 \
>   --connectorId c6d52e56-7772-41c6-be28-d20a7d75c7e7 \
>   -au browser \
>   -at oAuth2AuthorizationCode \
>   --auth-data-file ./auth-data.json
> ```

### Server auth

```bash
yarn connector-cli set-auth \
  -b https://cp-qbs-960.chili-publish.online/grafx \
  -e cp-qbs-960 \
  --connectorId c6d52e56-7772-41c6-be28-d20a7d75c7e7 \
  -au server \
  -at oAuth2ClientCredentials \
  --auth-data-file ./auth-data-dev-server.json
```

> Both auth data files use different formats — `auth-data.json` uses a nested `authorizationServerMetadata` object (authorization code flow); `auth-data-dev-server.json` uses a flat `tokenEndpoint` field (client credentials flow). See [KEYCLOAK-AUTH.md](../../temp-proxy/KEYCLOAK-AUTH.md) for the file formats and Keycloak setup details.

---

## Proxy Service

### Why it exists

**Reason 1 — S3 signed URL conflicts**

The Chili Grafx runtime proxy injects `Authorization: Bearer <token>` into **every** `runtime.fetch()` call made by the connector. Lytho serves all binary image data (thumbnails, previews, downloads) via pre-signed AWS S3 URLs. S3 rejects any request that carries both its own query-parameter auth signature (`X-Amz-Algorithm`, `X-Amz-Signature`) **and** an `Authorization` header — it returns HTTP 400 "Only one auth mechanism allowed."

There is no Lytho API endpoint that streams binary bytes directly; all binary delivery is delegated to S3.

**Reason 2 — Dev API is not publicly accessible**

When development moved from the Staging environment to the Dev environment, it became apparent that the Dev Lytho API is not publicly accessible. GraFx Studio runs in Chili's cloud and cannot reach a private API directly. The proxy was expanded to cover every API endpoint the connector needs — not just image downloads — so that GraFx has a single publicly-reachable URL to call, and the proxy forwards those calls to the private Dev API from within the network where it is accessible.

### How the proxy solves it

The connector routes all image download requests through the proxy instead of calling the Lytho API directly. The proxy:

1. Accepts `GET /preview/:id` or `GET /hrpreview/:id` with the `Authorization: Bearer` header
2. Uses the token to call the Lytho API and retrieve the S3 pre-signed URL
3. Fetches the S3 URL **without** the `Authorization` header
4. Streams the binary bytes back to the connector

### Source and endpoints

**Source:** `\src\temp-proxy\proxy.js`

| Proxy endpoint | Lytho API call | Used for |
|---|---|---|
| `GET /preview/:id` | `GET /assets/assets/:id/preview/link` → S3 | Thumbnails, low-res previews |
| `GET /hrpreview/:id` | `GET /assets/assets/:id/hrpreview/link` → S3 | High-res previews |
| `POST /grafx/api/v1/search` | `POST /grafx/api/v1/search` (passthrough) | Asset search / query (tenant resolved server-side) |
| `GET /assets/assets/:id` | `GET /assets/assets/:id` (passthrough) | Asset detail metadata |
| `GET /assets/assets/:id/content` | `GET /assets/assets/:id/content` (passthrough) | Asset content / original |

### Configuration

The Lambda reads one environment variable:

| Variable | Default | Purpose |
|---|---|---|
| `LYTHO_BASE_URL` | `https://api.us-1.golytho.us` | Lytho API base URL to forward requests to |

---

## Environment Reference for initial setup

| Item | Value |
|---|---|
| Chili environment ID | `cp-qbs-960` |
| Chili environment base URL | `https://cp-qbs-960.chili-publish.online/grafx` |
| Deployed connector ID | `c6d52e56-7772-41c6-be28-d20a7d75c7e7` |
| Lytho API base (production US-1) | `https://api.us-1.golytho.us` |
| Keycloak auth URL (staging realm) | `https://login.us-1.golytho.us/auth/realms/coreystaging/protocol/openid-connect/auth` |
| Keycloak token URL (staging realm) | `https://login.us-1.golytho.us/auth/realms/coreystaging/protocol/openid-connect/token` |
| Staging realm name | `coreystaging` |
| Keycloak client ID | `api-client` |
