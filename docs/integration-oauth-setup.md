# Provider OAuth setup

DIV3RSA uses one provider-independent connection surface with provider-specific authorization mechanisms:

1. authenticated user starts `/api/integrations/{provider}/connect`
2. the server creates a 15-minute authorization session with hashed state; PKCE is used where the provider requires it
3. provider redirects back to `/api/integrations/{provider}/callback`
4. credentials are stored server-side in Supabase Vault; the browser and model never receive them
5. provider resources are synced into `internal.integration_resources`
6. projects bind resources and explicit capabilities through the existing permission engine
7. agent workers execute external tools through a two-minute, single-use gateway grant

## Common production URLs

- GitHub callback: `https://system.div3rsa.com/api/integrations/github/callback`
- GitHub webhook: `https://system.div3rsa.com/api/integrations/github/webhook`
- Supabase callback: `https://system.div3rsa.com/api/integrations/supabase/callback`
- Vercel Redirect URL: `https://system.div3rsa.com/api/integrations/vercel/callback`
- Agent tool gateway: `https://system.div3rsa.com/api/internal/integrations/execute`

## Vercel environment variables

After adding or changing provider environment variables in Vercel, redeploy production before testing a connection so the new server-side configuration is loaded.

### GitHub App

- `GITHUB_INTEGRATION_APP_ID`
- `GITHUB_INTEGRATION_APP_SLUG`
- `GITHUB_INTEGRATION_CLIENT_ID`
- `GITHUB_INTEGRATION_CLIENT_SECRET`
- `GITHUB_INTEGRATION_PRIVATE_KEY` (PEM; escaped `\\n` is accepted)
- `GITHUB_INTEGRATION_WEBHOOK_SECRET`
- optional `GITHUB_INTEGRATION_CAPABILITIES` comma-separated override

GitHub App registration requirements:

- enable **Request user authorization (OAuth) during installation**
- set the callback URL exactly to `https://system.div3rsa.com/api/integrations/github/callback`
- keep wildcard callback matching disabled
- set the webhook URL exactly to `https://system.div3rsa.com/api/integrations/github/webhook`
- use the same strong webhook secret as `GITHUB_INTEGRATION_WEBHOOK_SECRET`
- subscribe to `installation` and `installation_repositories`

Recommended GitHub App repository permissions: Metadata read, Contents read/write, Pull requests read/write, Actions read/write, Workflows read/write. Add other provider permissions only when the corresponding DIV3RSA capability is intentionally supported. Runtime capability derivation is fail-closed: if GitHub does not report a permission, DIV3RSA does not expose its matching capability.

### Supabase OAuth App

- `SUPABASE_INTEGRATION_CLIENT_ID`
- `SUPABASE_INTEGRATION_CLIENT_SECRET`
- optional `SUPABASE_INTEGRATION_CAPABILITIES` comma-separated override

Configure the Supabase OAuth App itself with the maximum scopes DIV3RSA should ever be able to use. For the tools currently implemented, enable:

- Projects: Read
- Organizations: Read (recommended for account/project display metadata)
- Database: Read + Write
- Analytics: Read
- Edge Functions: Read + Write

The database migration Management API endpoint is restricted by Supabase to selected partner OAuth apps. DIV3RSA can expose migration execution only when the Supabase OAuth app is entitled to that endpoint.

Supabase's Management API `/v1/profile` endpoint currently rejects OAuth access tokens. DIV3RSA therefore identifies a Supabase connection by the authenticated DIV3RSA actor and uses provider-owned organization/project IDs for discovery and resource authorization. This avoids depending on an unsupported profile call while keeping provider credentials isolated in Vault.

The per-project DIV3RSA grants remain a second, narrower authorization layer.

### Vercel External Integration

Vercel resource access must use an **External Integration installation**, not the **Sign in with Vercel** OIDC flow. `openid email profile offline_access` only identifies the user and does not grant access to teams/projects.

Environment variables:

- `VERCEL_INTEGRATION_CLIENT_ID`
- `VERCEL_INTEGRATION_CLIENT_SECRET`
- `VERCEL_INTEGRATION_SLUG` — the URL Slug from Vercel Integration Console
- optional `VERCEL_INTEGRATION_INSTALL_URL` — defaults to `https://vercel.com/integrations/<slug>/new`
- optional `VERCEL_INTEGRATION_TOKEN_URL` — defaults to `https://api.vercel.com/v2/oauth/access_token`
- optional `VERCEL_INTEGRATION_CAPABILITIES` comma-separated local capability override

Vercel Integration Console requirements:

- Integration type: External / connectable account integration with Vercel REST API access
- Redirect URL exactly: `https://system.div3rsa.com/api/integrations/vercel/callback`
- use the Integration's Client ID and Client Secret in the environment variables above
- configure API scopes for what DIV3RSA may perform; for the current tool surface use at minimum:
  - `project`: Read + Write
  - `deployment`: Read + Write
  - `team`: Read
  - `user`: Read
  - `global-project-env-vars`: Read + Write when environment-variable tools are enabled
  - `domain`: Read + Write when domain tools are enabled
  - `integration-configuration`: Read (recommended for installation metadata/configuration management)

Connection flow:

1. DIV3RSA creates a hashed-state authorization session.
2. `Connect Vercel` opens `https://vercel.com/integrations/<slug>/new?state=...`.
3. Vercel asks the user to choose a team/personal account and which projects the integration may access.
4. Vercel redirects to the configured Redirect URL with `code`, `configurationId`, optional `teamId`, `source`, and the original `state`.
5. DIV3RSA validates `state` and exchanges `code` at `POST /v2/oauth/access_token` using the Integration Client ID/Secret and exact Redirect URL.
6. The returned installation credential is long-lived and stored only in Supabase Vault. It is not a Sign in with Vercel refresh-token credential.
7. DIV3RSA lists projects with the installation token and `teamId` when present. Vercel's installation scope determines which projects are visible.
8. Only those visible projects are synchronized to DIV3RSA. Local project/resource grants narrow access further.

If Vercel permissions or project selection are changed, reconnect/reinstall as required by Vercel and resync the connection. Never fall back to `/oauth/authorize` to obtain project access.

### Worker

No GitHub/Supabase/Vercel credential is installed on the GPU worker.

- optional `DIV3RSA_INTEGRATION_GATEWAY_URL` (defaults to `https://system.div3rsa.com/api/internal/integrations/execute`)

The worker only receives a short-lived one-time execution grant from Supabase.

## Security properties

- authorization state is stored hashed.
- Supabase uses PKCE; Vercel External Integration installation uses state and a one-time installation code.
- GitHub uses the GitHub App installation + user authorization flow and server-held client secret.
- customer provider tokens are stored in Supabase Vault and referenced by UUID only.
- Vercel team/project scope is enforced first by the Vercel installation and then narrowed again by DIV3RSA resource/capability grants.
- execution grants are single use and expire after two minutes.
- relation discovery never grants capabilities.
- every provider execution is re-authorized JIT and audit logged.
- removing a resource/capability blocks subsequent agent calls even within an existing run.
- GitHub webhook payloads are HMAC-SHA256 verified before resource resync.
