# Plugin resource and permission model

DIV3RSA treats every connected provider as a set of explicit resources and capabilities. A connected account never gives the agent blanket access.

## Authorization layers

1. **Provider ceiling** — OAuth/GitHub App/Vercel Connect determines the maximum permissions the provider can issue.
2. **Organization connection** — the external account is connected to one DIV3RSA organization.
3. **Resource discovery** — repositories, Supabase projects, Vercel projects and future plugin resources are synchronized as `internal.integration_resources`.
4. **Project binding** — a resource must be enabled for a DIV3RSA project.
5. **Capability grant** — the user chooses explicit read/write/destructive capabilities for that resource.
6. **Conversation selection** — a chat chooses which project resources are active for that conversation.
7. **Run snapshot** — an agent run records the selected resources and capabilities for observability.
8. **JIT authorization** — before each provider tool call, the worker must call `worker_authorize_tool_call`. Current connection status, project binding, conversation selection, provider ceiling and capability grant are checked again. Revoking a capability therefore takes effect immediately.
9. **Scoped credential** — write/destructive provider calls receive a short-lived credential scoped to the selected resource and capability. Credentials are never put in prompts or browser storage.
10. **Audit** — run/tool steps and resource configuration changes are recorded without credential values.

## Resource examples

- GitHub: `repository`
- Supabase: `project`
- Vercel: `project`
- Future providers: define a resource type and capability catalog, then reuse the same project/chat model.

## Tool execution

The model sees only tool definitions that correspond to selected resources and granted capabilities. Tool arguments contain the internal `resourceId`; the worker resolves the real external identifier server-side. Provider executors are registered separately, so adding an OAuth connection never activates write access by itself.

Destructive actions such as PR merge, production migrations, rollback and secret/environment mutation remain distinct capabilities and can be withheld independently from normal writes.
