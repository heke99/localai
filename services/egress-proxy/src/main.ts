import { createServer, request as requestHttp, type IncomingHttpHeaders } from "node:http";
import { request as requestHttps } from "node:https";
import { connect, type Socket } from "node:net";
import {
  resolvePublicEgressTarget,
  resolvePublicEgressTargets,
  type ResolvedEgressTarget
} from "./policy";

const host = process.env.DIV3RSA_EGRESS_PROXY_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.DIV3RSA_EGRESS_PROXY_PORT?.trim() || "3128");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_egress_proxy_port");

const hopByHop = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function forwardedHeaders(headers: IncomingHttpHeaders, authority: string): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || hopByHop.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  result.host = authority;
  return result;
}

function closeSocket(socket: Socket, status = "502 Bad Gateway"): void {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
}

function connectPinnedTarget(
  targets: ResolvedEgressTarget[],
  clientSocket: Socket,
  head: Buffer
): void {
  let index = 0;

  const attempt = (): void => {
    if (clientSocket.destroyed) return;
    const target = targets[index++];
    if (!target) {
      closeSocket(clientSocket);
      return;
    }

    const upstream = connect({ host: target.address, family: target.family, port: target.port });
    let connected = false;

    const retry = (error?: Error & { code?: string }): void => {
      if (connected) {
        if (!clientSocket.destroyed) clientSocket.destroy(error);
        return;
      }
      upstream.destroy();
      console.warn(
        `[egress-proxy] CONNECT candidate failed host=${target.host} address=${target.address} family=${target.family} code=${error?.code || "unknown"}; trying_next=${index < targets.length}`
      );
      attempt();
    };

    upstream.setTimeout(10_000, () => {
      const timeout = Object.assign(new Error("egress_connect_timeout"), { code: "ETIMEDOUT" });
      retry(timeout);
    });
    upstream.once("error", retry);
    upstream.once("connect", () => {
      connected = true;
      upstream.removeListener("error", retry);
      upstream.setTimeout(30_000, () => upstream.destroy(new Error("egress_tunnel_idle_timeout")));
      upstream.on("error", () => {
        if (!clientSocket.destroyed) clientSocket.destroy();
      });
      clientSocket.on("error", () => upstream.destroy());
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: div3rsa-egress\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  };

  attempt();
}

const server = createServer(async (request, response) => {
  if (request.url === "/_div3rsa_health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true, service: "egress-proxy", policy: "public-web-only-dns-pinned" }));
    return;
  }

  try {
    if (!request.url || !/^https?:\/\//i.test(request.url)) throw new Error("egress_absolute_url_required");
    const url = new URL(request.url);
    if (url.username || url.password) throw new Error("egress_url_userinfo_blocked");
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("egress_protocol_not_allowed");
    const targetPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const target = await resolvePublicEgressTarget(url.hostname, targetPort);
    const transport = url.protocol === "https:" ? requestHttps : requestHttp;
    const upstream = transport({
      hostname: target.address,
      family: target.family,
      port: target.port,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: forwardedHeaders(request.headers, url.host),
      ...(url.protocol === "https:" ? { servername: target.host } : {})
    }, (upstreamResponse) => {
      const headers = forwardedHeaders(upstreamResponse.headers, url.host);
      delete headers.host;
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("egress_upstream_timeout")));
    upstream.on("error", (error: Error & { code?: string }) => {
      console.warn(
        `[egress-proxy] request candidate failed host=${target.host} address=${target.address} family=${target.family} code=${error.code || "unknown"}`
      );
      if (!response.headersSent) response.writeHead(502, { "content-length": "0", "cache-control": "no-store" });
      response.end();
    });
    request.pipe(upstream);
  } catch (error) {
    const message = error instanceof Error ? error.message : "egress_proxy_failed";
    response.writeHead(/blocked|not_allowed|required|userinfo|port/.test(message) ? 403 : 502, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify({ error: message.slice(0, 160) }));
  }
});

server.on("connect", async (request, clientSocket, head) => {
  try {
    const authority = request.url?.trim() || "";
    const parsed = new URL(`http://${authority}`);
    const targetPort = Number(parsed.port || 443);
    const targets = await resolvePublicEgressTargets(parsed.hostname, targetPort);
    connectPinnedTarget(targets, clientSocket as Socket, head);
  } catch (error) {
    const message = error instanceof Error ? error.message : "egress_connect_failed";
    closeSocket(clientSocket as Socket, /blocked|not_allowed|port/.test(message) ? "403 Forbidden" : "502 Bad Gateway");
  }
});

server.requestTimeout = 35_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.listen(port, host, () => console.info(`[egress-proxy] listening host=${host} port=${port}`));

function stop() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
