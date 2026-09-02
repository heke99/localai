import http from "node:http";
import net, { isIP } from "node:net";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function normalizeHost(value) {
  return String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function defaultPort(protocol) {
  return protocol === "https:" ? 443 : 80;
}

function parseAuthority(value, fallbackPort) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("scope_proxy_authority_required");
  const parsed = new URL(`http://${text}`);
  const port = parsed.port ? Number(parsed.port) : fallbackPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("scope_proxy_invalid_port");
  return { host: normalizeHost(parsed.hostname), port };
}

function parseTarget(targetUrl, virtualHost) {
  const target = new URL(targetUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("scope_proxy_http_target_required");
  const pinnedAddress = normalizeHost(target.hostname);
  if (!isIP(pinnedAddress)) throw new Error("scope_proxy_pinned_ip_required");
  const port = target.port ? Number(target.port) : defaultPort(target.protocol);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("scope_proxy_invalid_port");
  const authority = parseAuthority(virtualHost || target.host, port);
  return {
    protocol: target.protocol,
    pinnedAddress,
    port,
    virtualHost: authority.host,
    allowedHosts: new Set([pinnedAddress, authority.host])
  };
}

function destinationFromRequest(req, fallbackPort) {
  const raw = req.url ?? "/";
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return {
      host: normalizeHost(url.hostname),
      port: url.port ? Number(url.port) : defaultPort(url.protocol),
      path: `${url.pathname}${url.search}` || "/"
    };
  }
  const authority = parseAuthority(req.headers.host ?? "", fallbackPort);
  return { host: authority.host, port: authority.port, path: raw || "/" };
}

function destinationAllowed(scope, host, port) {
  return scope.allowedHosts.has(normalizeHost(host)) && Number(port) === scope.port;
}

function denyHttp(res, reason = "scope_denied") {
  res.writeHead(403, { "content-type": "text/plain", connection: "close" });
  res.end(`${reason}\n`);
}

function denySocket(socket, reason = "scope_denied") {
  socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason) + 1}\r\n\r\n${reason}\n`);
}

export async function createScopedProxy({ targetUrl, virtualHost, listenHost = "127.0.0.1" }) {
  const scope = parseTarget(targetUrl, virtualHost);
  const server = http.createServer((req, res) => {
    let destination;
    try {
      destination = destinationFromRequest(req, scope.port);
    } catch {
      return denyHttp(res, "invalid_proxy_request");
    }
    if (!destinationAllowed(scope, destination.host, destination.port)) return denyHttp(res);

    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    if (!headers.host || normalizeHost(parseAuthority(headers.host, scope.port).host) === scope.pinnedAddress) {
      headers.host = scope.virtualHost === scope.pinnedAddress
        ? `${scope.pinnedAddress}${scope.port === 80 ? "" : `:${scope.port}`}`
        : `${scope.virtualHost}${scope.port === 80 ? "" : `:${scope.port}`}`;
    }

    const upstream = http.request({
      host: scope.pinnedAddress,
      port: scope.port,
      method: req.method,
      path: destination.path,
      headers,
      agent: false
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { connection: "close" });
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("connect", (req, clientSocket, head) => {
    let destination;
    try {
      destination = parseAuthority(req.url ?? "", scope.port);
    } catch {
      return denySocket(clientSocket, "invalid_proxy_connect");
    }
    if (!destinationAllowed(scope, destination.host, destination.port)) return denySocket(clientSocket);

    const upstream = net.connect({ host: scope.pinnedAddress, port: scope.port });
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: div3rsa-scope-proxy\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  server.on("upgrade", (_req, socket) => denySocket(socket, "proxy_upgrade_denied"));
  server.on("clientError", (_error, socket) => denySocket(socket, "invalid_proxy_client"));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scope_proxy_bind_failed");
  const url = `http://${listenHost}:${address.port}`;
  return {
    url,
    port: address.port,
    scope,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function cliArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`scope_proxy_missing_value:${key}`);
    values.set(key, value);
    index += 1;
  }
  return values;
}

async function main() {
  const args = cliArgs(process.argv.slice(2));
  const targetUrl = args.get("--target-url");
  const virtualHost = args.get("--virtual-host") ?? "";
  const readyFile = args.get("--ready-file");
  if (!targetUrl || !readyFile) throw new Error("scope_proxy_cli_arguments_required");
  const proxy = await createScopedProxy({ targetUrl, virtualHost });
  await writeFile(readyFile, `${JSON.stringify({ url: proxy.url, port: proxy.port })}\n`, { mode: 0o600 });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await proxy.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[nuclei-scope-proxy] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
