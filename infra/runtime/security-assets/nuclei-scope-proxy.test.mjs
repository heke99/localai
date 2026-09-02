import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createScopedProxy } from "./nuclei-scope-proxy.mjs";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function listenFixture() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`fixture:${req.headers.host}:${req.url}`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_bind_failed");
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  return address.port;
}

function proxyRequest(proxyPort, absoluteUrl, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "GET",
      path: absoluteUrl,
      headers: { host: hostHeader }
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectRequest(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.on("error", reject);
  });
}

describe("Nuclei target-locked HTTP proxy", () => {
  it("forwards only the authorized virtual host to the pinned IP and port", async () => {
    const fixturePort = await listenFixture();
    const proxy = await createScopedProxy({
      targetUrl: `http://127.0.0.1:${fixturePort}/`,
      virtualHost: `allowed.example:${fixturePort}`
    });
    cleanup.push(proxy.close);

    const allowed = await proxyRequest(
      proxy.port,
      `http://allowed.example:${fixturePort}/probe?x=1`,
      `allowed.example:${fixturePort}`
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body).toContain("fixture:allowed.example");
    expect(allowed.body).toContain("/probe?x=1");

    const denied = await proxyRequest(proxy.port, "http://evil.example/", "evil.example");
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("scope_denied");
  });

  it("rejects CONNECT tunnels to any host or port outside the authorized target", async () => {
    const fixturePort = await listenFixture();
    const proxy = await createScopedProxy({
      targetUrl: `https://127.0.0.1:${fixturePort}/`,
      virtualHost: `allowed.example:${fixturePort}`
    });
    cleanup.push(proxy.close);

    const deniedHost = await connectRequest(proxy.port, `evil.example:${fixturePort}`);
    expect(deniedHost).toContain("403 Forbidden");

    const deniedPort = await connectRequest(proxy.port, "allowed.example:443");
    expect(deniedPort).toContain("403 Forbidden");

    const allowed = await connectRequest(proxy.port, `allowed.example:${fixturePort}`);
    expect(allowed).toContain("200 Connection Established");
  });
});
