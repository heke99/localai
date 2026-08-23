type ConnectionLike = {
  id: string;
  provider: string;
  external_account_id?: string | null;
  external_account_name?: string | null;
  metadata?: Record<string, unknown> | null;
};

type ResourceLike = {
  connection_id: string;
  metadata?: Record<string, unknown> | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectLabel(value: unknown) {
  const item = record(value);
  if (!item) return text(value);
  return text(item.name) || text(item.login) || text(item.slug) || text(item.email) || text(item.id);
}

function labels(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return value.map(objectLabel).filter((item): item is string => Boolean(item));
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function IntegrationIdentityDetails({ connection, resources }: { connection: ConnectionLike; resources: ResourceLike[] }) {
  const metadata = record(connection.metadata) ?? {};
  const identity = record(metadata.identity) ?? {};
  const account = record(identity.account);
  const projectAccess = text(metadata.projectAccess);
  const accountLabel = text(connection.external_account_name)
    || text(account?.name)
    || text(account?.email)
    || text(metadata.login)
    || text(metadata.username)
    || text(metadata.email)
    || (connection.external_account_id && !connection.external_account_id.startsWith("pending:") && !connection.external_account_id.startsWith("disconnected:") ? connection.external_account_id : null)
    || "Auktoriserat konto";

  const scoped = resources.filter((resource) => resource.connection_id === connection.id);
  const scopeLabels = unique([
    ...labels(identity.scopes),
    ...labels(metadata.teams),
    ...labels(metadata.organizations),
    ...labels(metadata.installationAccounts),
    ...scoped.flatMap((resource) => {
      const resourceMetadata = record(resource.metadata) ?? {};
      return [
        text(resourceMetadata.teamName),
        text(resourceMetadata.teamSlug),
        text(resourceMetadata.organizationName),
        text(resourceMetadata.organizationSlug),
        text(resourceMetadata.installationAccount),
        text(resourceMetadata.owner)
      ];
    })
  ]);

  return <div aria-label="Ansluten identitet">
    <small>Konto: {accountLabel}</small><br />
    <small>Team/organisation: {scopeLabels.length ? scopeLabels.join(", ") : "Ingen scope rapporterad"}</small><br />
    <small>Åtkomst: {scoped.length} {scoped.length === 1 ? "resurs" : "resurser"}</small>
    {connection.provider === "vercel" && projectAccess === "installation_required" ? <><br /><small>Projektåtkomst: Vercel App-behörighet krävs för projekt och deployments.</small></> : null}
  </div>;
}
