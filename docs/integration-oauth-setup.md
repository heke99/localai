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
- Vercel callback: `https://system.div3rsa.com/api/integrations/vercel/callback`
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

### Vercel App

Vercel has two separate authorization layers and DIV3RSA must keep them separate:

1. **OAuth / Sign in with Vercel** proves the user's identity and issues the OAuth access/refresh token. Its scopes are identity scopes such as `openid email profile offline_access`.
2. **Vercel App installation** grants the app access to a team and to all or selected projects with explicit permissions. OAuth consent by itself does **not** grant team/project access.

Environment variables:

- `VERCEL_INTEGRATION_CLIENT_ID`
- `VERCEL_INTEGRATION_CLIENT_SECRET`
- optional `VERCEL_INTEGRATION_AUTHORIZE_URL` — defaults to `https://vercel.com/oauth/authorize`
- optional `VERCEL_INTEGRATION_TOKEN_URL` — defaults to `https://api.vercel.com/login/oauth/token`
- optional `VERCEL_INTEGRATION_OAUTH_SCOPES` — defaults to `openid email profile offline_access`
- optional `VERCEL_INTEGRATION_CAPABILITIES` comma-separated local capability override

Do not configure `VERCEL_INTEGRATION_SLUG` or `VERCEL_INTEGRATION_INSTALL_URL`; the legacy `/integrations/<slug>/new` Marketplace/External Integration route is not the Vercel App installation flow used by this product.

Vercel App requirements:

- register the Vercel App with callback URL exactly `https://system.div3rsa.com/api/integrations/vercel/callback`
- use the same App Client ID and Client Secret in production
- OAuth authorization uses PKCE S256
- install the App on each Vercel team that should expose projects to DIV3RSA
- grant only the Vercel App permissions needed by the supported tool surface
- scope the installation to selected project IDs when full-team project access is unnecessary

Verified Vercel CLI installation examples:

```bash
# Minimum useful read installation
vercel oauth-apps install \
  --client-id <client-id> \
  --permission read:project \
  --permission read:deployment \
  --projects '*'

# Restrict to selected projects instead
vercel oauth-apps install \
  --client-id <client-id> \
  --permission read:project \
  --permission read:deployment \
  --projects prj_a,prj_b
```

Use `vercel oauth-apps list-requests` to inspect pending installation requests when team-owner approval is required. Add write permissions only when the corresponding DIV3RSA write capability is intentionally enabled.

Connection flow:

1. DIV3RSA creates a hashed-state + PKCE authorization session.
2. `Connect Vercel` opens `https://vercel.com/oauth/authorize` with the Vercel App Client ID, exact callback URL, state and PKCE challenge.
3. Vercel returns an authorization code to the callback.
4. DIV3RSA validates state and exchanges the code at `https://api.vercel.com/login/oauth/token` using the stored PKCE verifier.
5. DIV3RSA verifies project access by querying the Vercel API. Identity-only authorization is never enough to mark the integration connected.
6. If project/team API calls are forbidden because the Vercel App is not installed with project permissions, the user is routed to `/integrations/vercel/setup`; no connection is finalized.
7. Once the Vercel App installation exists, DIV3RSA syncs only projects that the Vercel API makes visible to that installation/account context.
8. DIV3RSA project/resource grants narrow that provider access further.

Never fall back to a Marketplace `/integrations/<slug>/new` URL and never mark Vercel connected solely because OAuth identity authorization succeeded.

### Worker

No GitHub/Supabase/Vercel credential is installed on the GPU worker.

- optional `DIV3RSA_INTEGRATION_GATEWAY_URL` (defaults to `https://system.div3rsa.com/api/internal/integrations/execute`)

The worker only receives a short-lived one-time execution grant from Supabase.

## Security properties

- authorization state is stored hashed.
- Supabase and Vercel App OAuth use PKCE.
- GitHub uses the GitHub App installation + user authorization flow and server-held client secret.
- customer provider tokens are stored in Supabase Vault and referenced by UUID only.
- Vercel OAuth identity and Vercel App project permissions are verified separately; both must be valid before project resources are exposed.
- Vercel project visibility is provider-scoped first and then narrowed again by DIV3RSA resource/capability grants.
- execution grants are single use and expire after two minutes.
- relation discovery never grants capabilities.
- every provider execution is re-authorized JIT and audit logged.
- removing a resource/capability blocks subsequent agent calls even within an existing run.
- GitHub webhook payloads are HMAC-SHA256 verified before resource resync.
