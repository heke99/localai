import "server-only";
import { configuredCapabilities, credentialExpiry, fetchJson, providerCallbackUrl, requiredProviderEnv, type StoredCredential } from "./oauth";
import type { DiscoveredResource } from "./github";

interface SupabaseTokenResponse { access_token: string; refresh_token?: string; token_type?: string; expires_in?: number; scope?: string; }
interface SupabaseProfile { id?: string; email?: string; username?: string; }
interface SupabaseProject { id?: string; ref?: string; name?: string; organization_id?: string; organization_slug?: string; region?: string; status?: string; database?: { host?: string }; }

export function supabaseAuthorizationUrl(state: string, codeChallenge: string) {
  const query = new URLSearchParams({
    client_id: requiredProviderEnv("supabase", "CLIENT_ID"),
    redirect_uri: providerCallbackUrl("supabase"),
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });
  return `https://api.supabase.com/v1/oauth/authorize?${query.toString()}`;
}

function basicAuth() {
  return `Basic ${Buffer.from(`${requiredProviderEnv("supabase", "CLIENT_ID")}:${requiredProviderEnv("supabase", "CLIENT_SECRET")}`).toString("base64")}`;
}

export async function exchangeSupabaseCode(code: string, codeVerifier: string) {
  const result = await fetchJson<SupabaseTokenResponse>("https://api.supabase.com/v1/oauth/token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: providerCallbackUrl("supabase"), code_verifier: codeVerifier })
  });
  return toStoredCredential(result);
}

function toStoredCredential(result: SupabaseTokenResponse): StoredCredential {
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    tokenType: result.token_type ?? "bearer",
    scope: result.scope ?? null,
    expiresAt: credentialExpiry(result.expires_in)
  };
}

function supabaseHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

export async function refreshSupabaseCredential(credential: StoredCredential) {
  if (!credential.refreshToken) throw new Error("supabase_refresh_token_missing");
  const result = await fetchJson<SupabaseTokenResponse>("https://api.supabase.com/v1/oauth/token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refreshToken })
  });
  const next = toStoredCredential(result);
  if (!next.refreshToken) next.refreshToken = credential.refreshToken;
  return next;
}

export async function discoverSupabase(credential: StoredCredential): Promise<{ externalAccountId: string; externalAccountName: string; metadata: Record<string,unknown>; capabilities: string[]; resources: DiscoveredResource[] }> {
  const [profile, projects] = await Promise.all([
    fetchJson<SupabaseProfile>("https://api.supabase.com/v1/profile", { headers: supabaseHeaders(credential.accessToken) }),
    fetchJson<SupabaseProject[]>("https://api.supabase.com/v1/projects", { headers: supabaseHeaders(credential.accessToken) })
  ]);
  const accountId = profile.id || profile.email || profile.username;
  if (!accountId) throw new Error("supabase_profile_identity_missing");
  const resources: DiscoveredResource[] = (Array.isArray(projects) ? projects : []).flatMap((project) => {
    const ref = project.ref || project.id;
    if (!ref) return [];
    const name = project.name || ref;
    return [{
      resourceType: "project" as const,
      externalId: ref,
      displayName: name,
      metadata: {
        projectRef: ref,
        projectId: project.id ?? ref,
        name,
        organizationId: project.organization_id ?? null,
        organizationSlug: project.organization_slug ?? null,
        region: project.region ?? null,
        status: project.status ?? null,
        apiUrl: `https://${ref}.supabase.co`,
        databaseHost: project.database?.host ?? `db.${ref}.supabase.co`
      },
      identifiers: [
        { kind: "supabase.project_ref", value: ref, confidence: 1, linkable: false },
        { kind: "service.hostname", value: `${ref}.supabase.co`, confidence: 1, linkable: true }
      ]
    }];
  });
  return {
    externalAccountId: String(accountId),
    externalAccountName: profile.email || profile.username || String(accountId),
    metadata: { email: profile.email ?? null },
    capabilities: configuredCapabilities("supabase"),
    resources
  };
}

async function supabaseApi<T>(credential: StoredCredential, path: string, init: RequestInit = {}) {
  return fetchJson<T>(`https://api.supabase.com${path}`, { ...init, headers: { ...supabaseHeaders(credential.accessToken), ...(init.headers ?? {}) } });
}

function projectRef(metadata: Record<string,unknown>, externalId: string) {
  const ref = typeof metadata.projectRef === "string" ? metadata.projectRef : externalId;
  if (!ref || !/^[a-z0-9]{10,40}$/i.test(ref)) throw new Error("supabase_project_ref_invalid");
  return ref;
}

function serviceLogSql(service: string) {
  const normalized = service.toLowerCase();
  if (normalized === "postgres" || normalized === "database") return "select timestamp,event_message,metadata from postgres_logs order by timestamp desc limit 100";
  if (normalized === "auth") return "select timestamp,event_message,metadata from auth_logs order by timestamp desc limit 100";
  if (normalized === "functions" || normalized === "edge") return "select timestamp,event_message,metadata from function_edge_logs order by timestamp desc limit 100";
  return "select timestamp,event_message,metadata from edge_logs order by timestamp desc limit 100";
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n=0;n<256;n++) { let c=n; for (let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; table[n]=c>>>0; }
  return table;
})();
function crc32(data: Buffer) { let c=0xffffffff; for (const byte of data) c=crcTable[(c^byte)&0xff]^(c>>>8); return (c^0xffffffff)>>>0; }
function zipFiles(files: Array<{ path: string; content: string }>) {
  const locals: Buffer[]=[]; const centrals: Buffer[]=[]; let offset=0;
  for (const file of files) {
    const name=Buffer.from(file.path.replace(/^\/+/,""),"utf8"); const data=Buffer.from(file.content,"utf8"); const crc=crc32(data);
    const local=Buffer.alloc(30); local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0,6); local.writeUInt16LE(0,8); local.writeUInt32LE(crc,14); local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(name.length,26);
    locals.push(local,name,data);
    const central=Buffer.alloc(46); central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt32LE(crc,16); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(name.length,28); central.writeUInt32LE(offset,42);
    centrals.push(central,name); offset += local.length+name.length+data.length;
  }
  const centralSize=centrals.reduce((sum,b)=>sum+b.length,0); const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(centralSize,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,...centrals,end]);
}

export async function executeSupabaseTool(toolName: string, args: Record<string,unknown>, metadata: Record<string,unknown>, externalId: string, credential: StoredCredential) {
  const ref = projectRef(metadata, externalId);
  if (toolName === "supabase_read_database") return supabaseApi(credential, `/v1/projects/${ref}/database/query/read-only`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: String(args.query ?? "") }) });
  if (toolName === "supabase_write_database") return supabaseApi(credential, `/v1/projects/${ref}/database/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: String(args.query ?? "") }) });
  if (toolName === "supabase_apply_migration") return supabaseApi(credential, `/v1/projects/${ref}/database/migrations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: String(args.name ?? "DIV3RSA migration").slice(0,200), query: String(args.sql ?? "") }) });
  if (toolName === "supabase_read_logs") {
    const end = new Date(); const start = new Date(end.getTime()-60*60*1000);
    const params = new URLSearchParams({ sql: serviceLogSql(String(args.service ?? "edge")), iso_timestamp_start: start.toISOString(), iso_timestamp_end: end.toISOString() });
    return supabaseApi(credential, `/v1/projects/${ref}/analytics/endpoints/logs.all?${params.toString()}`);
  }
  if (toolName === "supabase_deploy_function") {
    const name = String(args.name ?? "").trim();
    const rawFiles = Array.isArray(args.files) ? args.files : [];
    const files = rawFiles.flatMap((item) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as {path?:unknown}).path === "string" && typeof (item as {content?:unknown}).content === "string" ? [{ path: String((item as {path:string}).path), content: String((item as {content:string}).content) }] : []);
    if (!name || !files.length || files.length>100) throw new Error("supabase_function_files_invalid");
    const entrypoint = files.find((file) => /(^|\/)index\.(ts|js|tsx|jsx)$/.test(file.path))?.path ?? files[0].path;
    const form = new FormData();
    form.append("file", new Blob([zipFiles(files)], { type: "application/zip" }), `${name}.zip`);
    form.append("metadata", JSON.stringify({ name, entrypoint_path: entrypoint, verify_jwt: args.verifyJwt !== false }));
    return supabaseApi(credential, `/v1/projects/${ref}/functions/deploy?slug=${encodeURIComponent(name)}`, { method: "POST", body: form });
  }
  throw new Error("supabase_tool_not_supported");
}
