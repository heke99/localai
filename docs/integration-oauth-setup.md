# Provider OAuth setup

DIV3RSA uses one provider-independent connection flow:

1. authenticated user starts `/api/integrations/{provider}/connect`
2. the server creates a 15-minute OAuth session with hashed state and PKCE where supported
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

Configure the Supabase OAuth App itself with the maximum scopes DIV3RSA should ever be able to use. The per-project DIV3RSA grants remain a second, narrower authorization layer.

### Vercel App / OAuth

- `VERCEL_INTEGRATION_CLIENT_ID`
- `VERCEL_INTEGRATION_CLIENT_SECRET`
- optional `VERCEL_INTEGRATION_CAPABILITIES` comma-separated override
- optional `VERCEL_INTEGRATION_AUTHORIZE_URL` (default `https://vercel.com/oauth/authorize`)
- optional `VERCEL_INTEGRATION_TOKEN_URL` (connector has current-token endpoint fallback when unset)
- optional `VERCEL_INTEGRATION_OAUTH_SCOPES` (default `openid email profile offline_access`)

Configure the Vercel App installation with project/deployment/log permissions and restrict project access at Vercel when appropriate. DIV3RSA then narrows access again per local project/resource capability.

### Worker

No GitHub/Supabase/Vercel credential is installed on the GPU worker.

- optional `DIV3RSA_INTEGRATION_GATEWAY_URL` (defaults to `https://system.div3rsa.com/api/internal/integrations/execute`)

The worker only receives a short-lived one-time execution grant from Supabase.

## Security properties

- OAuth state is stored hashed.
- Supabase and Vercel use PKCE.
- GitHub uses the GitHub App installation + user authorization flow and server-held client secret.
- customer OAuth tokens are stored in Supabase Vault and referenced by UUID only.
- execution grants are single use and expire after two minutes.
- relation discovery never grants capabilities.
- every provider execution is re-authorized JIT and audit logged.
- removing a resource/capability blocks subsequent agent calls even within an existing run.
- GitHub webhook payloads are HMAC-SHA256 verified before resource resync.
