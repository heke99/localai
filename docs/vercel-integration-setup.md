# Vercel project authorization

DIV3RSA's Vercel resource connection uses a Vercel External / Connectable Integration installation, not Sign in with Vercel identity OAuth.

## Vercel-side configuration

Create an External / Connectable Integration in Vercel and configure:

- Redirect URL: `https://system.div3rsa.com/api/integrations/vercel/callback`
- Webhook URL: `https://system.div3rsa.com/api/integrations/vercel/webhook`
- URL slug: store as `VERCEL_INTEGRATION_SLUG`
- Client ID: store as `VERCEL_INTEGRATION_CLIENT_ID`
- Client secret / Integration Secret: store as `VERCEL_INTEGRATION_CLIENT_SECRET`
- **Log Drain Settings: Disabled. Do not enable Log Drains for this integration.** DIV3RSA reads deployment/runtime logs on demand and does not need a drain.

If Log Drain Settings were accidentally enabled in the Vercel Integration Console, disable them there. Enabling the setting only makes Log Drain configuration available to the integration user; DIV3RSA must not provision, update, test or delete Vercel drains. The application gateway also rejects Vercel tool names for Log Drain operations as a defense-in-depth control.

Integration webhook requests are verified with the raw request body, `x-vercel-signature`, and the Integration Secret. No customer-specific webhook secret is required.

Grant only permissions required by implemented DIV3RSA tools:

- User: Read (identity label; optional for team-scoped discovery)
- Team: Read (team label and scope)
- Project: Read (project discovery)
- Deployment: Read/Write (list/create/rollback deployments and deployment log access)

Do not grant environment-variable or domain write permissions unless corresponding DIV3RSA gateway tools are implemented and reviewed.

## Webhook events

Enable these Integration Console webhook events:

### Deployment
- `deployment.created`
- `deployment.build-requested`
- `deployment.error`
- `deployment.blocked`
- `deployment.canceled`
- `deployment.succeeded`
- `deployment.promoted`
- `deployment.rollback`
- `deployment.ready`

### Project/configuration synchronization
- `project.env-variable.created`
- `project.env-variable.updated`
- `project.env-variable.deleted`
- `project.created`
- `project.removed`
- `project.renamed`
- `integration-configuration.permission-upgraded`
- `integration-configuration.scope-change-confirmed`
- `integration-configuration.transferred`
- `integration-resource.project-connected`
- `integration-resource.project-disconnected`

Do not enable domain/certificate, rolling-release, firewall, alert, or checkrun events until DIV3RSA has a reviewed consumer for them.

Deployment events persist only operational metadata such as event ID, project ID, deployment ID, state, target and known Git commit/branch identifiers. Full build/runtime log bodies are not copied into Postgres. The agent uses the authorized Vercel token to fetch current build/runtime logs on demand for the relevant deployment.

## Expected user flow

1. User selects **Anslut** / **Starta om** for Vercel in DIV3RSA.
2. DIV3RSA creates a state-bound integration session.
3. Browser is redirected to `https://vercel.com/integrations/<slug>/new?state=...`.
4. Vercel asks the user to choose the account/team and project access and approve the installation.
5. Vercel redirects to the configured callback with `code`, `state`, `configurationId`, and team context when applicable.
6. DIV3RSA exchanges the code at `https://api.vercel.com/v2/oauth/access_token` for the long-lived installation token.
7. DIV3RSA validates the installation by listing accessible Vercel projects.
8. Only if at least one project is readable is the connection stored as usable and its project resources/capabilities exposed.
9. Vercel sends selected signed platform events to the Integration Console webhook endpoint.
10. DIV3RSA maps each event to the authorized connection by configuration/team/project, records it idempotently, and resynchronizes project scope after relevant configuration events.

Identity-only callbacks and zero-project installations must never be displayed as a completed Vercel resource connection.
