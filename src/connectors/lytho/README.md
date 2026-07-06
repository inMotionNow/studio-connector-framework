# Lytho Media Connector

A read-only [CHILI GraFx Studio media connector](https://docs.chili-publish.com/GraFx-Studio/concepts/connectors/) that lets Studio users browse, search, and use images from the Lytho DAM directly inside template editing.

**Implemented interface methods:** `query`, `detail`, `download`, `getConfigurationOptions`, `getCapabilities`

**Upload/write is out of scope** — this connector is read-only.

> **Placeholders:** commands below use angle-bracket placeholders. Substitute the values for the realm/environment you're deploying to (a concrete `dev-us / dragon` set is in [Appendix: worked example](#appendix-worked-example--dev-us--dragon)):
>
> | Placeholder | Meaning |
> |---|---|
> | `<grafx-env>` | CHILI GraFx environment ID |
> | `<grafx-base>` | CHILI GraFx base URL — `https://<grafx-env>.chili-publish.online/grafx` |
> | `<connector-id>` | The connector's ID (minted by the CLI on first publish) |
> | `<connector-name>` | Display name — convention: `Lytho — <realm> (<env>)` |
> | `<base-url>` | What the connector calls at runtime — the proxy Function URL in DEV, or the Lytho API host directly where reachable |
> | `<allowed-domains>` | CHILI sandbox allowlist glob for `<base-url>`'s domain |
> | `<realm>` | Keycloak realm (1:1 with a Lytho tenant) |
> | `<keycloak-host>` | Keycloak host for that realm |

---

## How it works (auth model)

The connector never sees the auth token — CHILI's runtime injects the `Authorization` header on every `runtime.fetch`. There are **two auth contexts**, configured separately via `connector-cli set-auth`:

- **Browser** — interactive browse/search. Configured as **`oAuth2AuthorizationCode`**: the Studio user logs into the connector's realm (Keycloak) and their **own** token is used, so results are filtered to the assets *that user* is permitted to see.
- **Server** — GraFx's rendering/export server fetching assets during output (no user present). Configured as **`oAuth2ClientCredentials`** (service account).

Connector calls route through a single `BASE_URL` (a proxy in DEV — see [Connectivity](#connectivity)). The gateway keys on the first path segment, so the connector calls `/search/...` (search service) and `/assets/...` (assets service).

Keycloak client setup (flows, the required `tenant` claim mapper, service-account roles, redirect URIs) is documented here — **read it before configuring a realm**:
**[Keycloak Client Setup — Lytho Media Connector (CHILI GraFx)](https://lytho.atlassian.net/wiki/spaces/DEV/pages/29707534338)**

---

## Deploy pipeline (order matters)

1. Create the two `auth-data` files (Step 1)
2. Build (Step 2)
3. Log in to the CLI (Step 3)
4. Publish — new connector, or update an existing one (Step 4)
5. **Enable** the connector so it's Available (Step 5) — new connectors publish disabled
6. Configure both auth contexts (Step 6) — re-run after **every** publish
7. Register the connector's redirect URI in Keycloak (Step 7)

---

## Prerequisites

- Node.js with Yarn
- `@chili-publish/connector-cli` (in `devDependencies`)
- Access to the target CHILI GraFx environment (`<grafx-env>`)
- The target Keycloak realm and the `chili-media-connector` client secret
- The Keycloak client configured per the [Confluence doc](https://lytho.atlassian.net/wiki/spaces/DEV/pages/29707534338)

---

## Step 1 — Create the auth-data files

Both files live in `src/connectors/lytho/` and are **gitignored — never commit them (they contain the client secret).** Get the secret from Keycloak → Clients → `chili-media-connector` → Credentials.

`auth-data.json` (browser / authorization code):
```json
{
  "authorizationServerMetadata": {
    "authorization_endpoint": "https://<keycloak-host>/auth/realms/<realm>/protocol/openid-connect/auth",
    "token_endpoint": "https://<keycloak-host>/auth/realms/<realm>/protocol/openid-connect/token",
    "token_endpoint_auth_methods_supported": ["client_secret_basic"]
  },
  "clientId": "chili-media-connector",
  "clientSecret": "<SECRET>",
  "scope": "openid"
}
```

`auth-data-dev-server.json` (server / client credentials — note the flat `tokenEndpoint`):
```json
{
  "clientId": "chili-media-connector",
  "clientSecret": "<SECRET>",
  "tokenEndpoint": "https://<keycloak-host>/auth/realms/<realm>/protocol/openid-connect/token",
  "scope": "openid"
}
```

> The two formats differ — authorization code uses the nested `authorizationServerMetadata`, client credentials uses the flat `tokenEndpoint`; the CLI rejects the wrong shape.

---

## Step 2 — Build

```bash
cd src/connectors/lytho
yarn install
# first time only, to build the vendored connector-cli workspace:
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
The CLI prints a short URL and a code; open the URL, enter the code, and it stores your access token locally.

---

## Step 4 — Publish

The display name is applied via `-n` at publish time — **not** baked into `package.json` (its `connectorName` stays generic). **Always pass `-n`**; omitting it falls back to `package.json` and would silently rename the connector.

**First publish of a new connector** — omit `--connectorId`; the CLI mints a new one and prints it:
```bash
yarn connector-cli publish \
  -b <grafx-base> \
  -e <grafx-env> \
  -n "<connector-name>" \
  -ro BASE_URL=<base-url> \
  --proxyOption.allowedDomains "<allowed-domains>"
```

**Re-deploy an existing connector** — include `--connectorId` to update in place:
```bash
yarn connector-cli publish \
  -b <grafx-base> \
  -e <grafx-env> \
  -n "<connector-name>" \
  --connectorId <connector-id> \
  -ro BASE_URL=<base-url> \
  --proxyOption.allowedDomains "<allowed-domains>"
```

| Flag | Value | Notes |
|---|---|---|
| `-b` | `<grafx-base>` | CLI appends `api/v1/...` itself — don't include it |
| `-e` | `<grafx-env>` | CHILI GraFx environment ID |
| `-n` | `"<connector-name>"` | Convention: `Lytho — <realm> (<env>)`. Always pass it |
| `--connectorId` | `<connector-id>` | Omit on first publish; include to re-deploy |
| `-ro BASE_URL` | `<base-url>` | All connector calls go through this — the DEV proxy, not the Lytho API directly |
| `--proxyOption.allowedDomains` | `"<allowed-domains>"` | CHILI sandbox allowlist — the `<base-url>` domain |

---

## Step 5 — Make the connector Available (enable)

`publish` installs a connector with `enabled: false`, so it appears in the environment's Connectors list but its **Available** toggle is off. The UI toggle is **locked** for CLI-managed connectors (hover shows "installed using Connector CLI tool"). Enable it via the CLI:

```bash
yarn connector-cli update \
  -b <grafx-base> \
  -e <grafx-env> \
  --connectorId <connector-id> \
  --enabled true
```

---

## Step 6 — Configure auth

Run **both** commands after **every** publish — GraFx does not preserve auth config across publishes.

```bash
# Browser → authorization code (per-user login)
yarn connector-cli set-auth \
  -b <grafx-base> -e <grafx-env> \
  --connectorId <connector-id> \
  -au browser -at oAuth2AuthorizationCode --auth-data-file ./auth-data.json

# Server → client credentials (render/export)
yarn connector-cli set-auth \
  -b <grafx-base> -e <grafx-env> \
  --connectorId <connector-id> \
  -au server -at oAuth2ClientCredentials --auth-data-file ./auth-data-dev-server.json
```

---

## Step 7 — Register the connector's redirect URI in Keycloak

The browser (authorization code) flow needs the connector's redirect URI registered in the Keycloak client's **Valid redirect URIs**. **The redirect URI contains the connector ID**, so each connector needs its own:

```
<grafx-base>/api/v1/environment/<grafx-env>/connectors/<connector-id>/auth/oauth-authorization-code/redirect
```

> **Trap:** the Valid redirect URIs field truncates, hiding the connector-ID segment at the end — an existing entry for a *different* connector looks like it covers the new one but doesn't. If login fails with `Invalid Parameter: redirect_uri`, copy the exact `redirect_uri` query param out of the Keycloak URL you were sent to and register that. For DEV convenience, a path wildcard covers all connectors in the env: `.../connectors/*/auth/oauth-authorization-code/redirect` (prefer exact-match for production).

Verify: in Studio, add a media variable sourced from `<connector-name>`, open the asset browser, and complete the realm login — the asset browser should load.

---

## Connectivity

The connector calls whatever `BASE_URL` points at. In DEV the Lytho API isn't publicly reachable from CHILI's cloud, so `BASE_URL` points at a **proxy** (an AWS Lambda in `dam-service-chili`, `lambdas/lytho-proxy/`) that forwards allowlisted paths — with the caller's bearer token — to the DEV API host. Where the API is directly reachable, `BASE_URL` can point at it directly and the proxy drops out. Either way the connector code is unaffected.

When `BASE_URL` is a proxy Function URL, `--proxyOption.allowedDomains` must match that host's domain; when it points at the API directly, match the API host's domain instead.

---

## Appendix: worked example — dev-us / dragon

Concrete values for the DEV-US / `dragon` deployment, to sanity-check the placeholders above. Other realms/environments follow the same steps with their own values.

| Placeholder | Value |
|---|---|
| `<grafx-env>` | `cp-qbs-960` |
| `<grafx-base>` | `https://cp-qbs-960.chili-publish.online/grafx` |
| `<connector-name>` | `Lytho — dragon (dev-us)` |
| `<connector-id>` | `81092dea-6d2c-4be7-91b4-b8a9cc07417d` |
| `<base-url>` (proxy Function URL) | `https://ehr62lw6xfwkl65itf7t6qlijq0fdngd.lambda-url.us-east-1.on.aws` |
| `<allowed-domains>` | `*.us-east-1.on.aws` |
| `<realm>` | `dragon` (tenant `970`) |
| `<keycloak-host>` | `login.dev1-cluster.p.golytho.com` |
| Keycloak client | `chili-media-connector` |
| Keycloak setup doc | https://lytho.atlassian.net/wiki/spaces/DEV/pages/29707534338 |
