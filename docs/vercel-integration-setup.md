# Vercel project authorization

DIV3RSA's Vercel resource connection uses a Vercel External Integration installation, not Sign in with Vercel identity OAuth.

## Vercel-side configuration

Create an External / Connectable Integration in Vercel and configure:

- Redirect URL: `https://system.div3rsa.com/api/integrations/vercel/callback`
- URL slug: store as `VERCEL_INTEGRATION_SLUG`
- Client ID: store as `VERCEL_INTEGRATION_CLIENT_ID`
- Client secret: store as `VERCEL_INTEGRATION_CLIENT_SECRET`

Grant only permissions required by implemented DIV3RSA tools:

- User: Read (identity label; optional for team-scoped discovery)
- Team: Read (team label and scope)
- Project: Read (project discovery)
- Deployment: Read/Write (list/create/rollback deployments and deployment log access)

Do not grant environment-variable or domain write permissions unless corresponding DIV3RSA gateway tools are implemented and reviewed.

## Expected user flow

1. User selects **Anslut** / **Starta om** for Vercel in DIV3RSA.
2. DIV3RSA creates a state-bound integration session.
3. Browser is redirected to `https://vercel.com/integrations/<slug>/new?state=...`.
4. Vercel asks the user to choose the account/team and project access and approve the installation.
5. Vercel redirects to the configured callback with `code`, `state`, `configurationId`, and team context when applicable.
6. DIV3RSA exchanges the code at `https://api.vercel.com/v2/oauth/access_token` for the long-lived installation token.
7. DIV3RSA validates the installation by listing accessible Vercel projects.
8. Only if at least one project is readable is the connection stored as usable and its project resources/capabilities exposed.

Identity-only callbacks and zero-project installations must never be displayed as a completed Vercel resource connection.
