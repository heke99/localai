# Vercel integration validation

A Vercel resource connection is complete only when all of the following are true:

1. Vercel returned an installation `configurationId` to the callback.
2. The installation code was exchanged using the Vercel Integration token endpoint.
3. The token can list at least one authorized Vercel project.
4. Those projects are synchronized into `internal.integration_resources`.
5. Only capabilities backed by implemented gateway tools are granted.

A Sign in with Vercel identity token is not sufficient for project access and must not be shown as a completed connection.
