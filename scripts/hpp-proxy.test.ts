import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { createHppHandler } from "../spike/hpp-server.ts";
import { HppGate, HppService } from "../spike/hpp.ts";

test("proxy templates match backend budgets and disable status interception and retries", async () => {
  const [publicProxy, localProxy, backend] = await Promise.all([
    readFile(new URL("../deployment/nginx-hpp.conf.template", import.meta.url), "utf8"),
    readFile(new URL("../deployment/nginx-hpp-localhost.conf.template", import.meta.url), "utf8"),
    readFile(new URL("../src/airwallex.ts", import.meta.url), "utf8"),
  ]);
  assert.equal((backend.match(/AbortSignal\.timeout\(30_000\)/g) ?? []).length, 2);
  for (const source of [publicProxy, localProxy]) {
    assert.match(source, /proxy_connect_timeout (?:5|2)s;/);
    assert.match(source, /proxy_send_timeout 10s;/);
    assert.match(source, /proxy_read_timeout 70s;/);
    assert.match(source, /proxy_intercept_errors off;/);
    assert.match(source, /proxy_next_upstream off;/);
    assert.match(source, /proxy_pass http:\/\/127\.0\.0\.1:4242;/);
    assert.match(source, /proxy_set_header Host \$http_host;/);
  }
  assert.match(publicProxy, /__OWNER_BIND_ADDRESS__:__OWNER_HTTPS_PORT__/);
  assert.match(localProxy, /listen 127\.0\.0\.1:8443 ssl;/);
  assert.match(localProxy, /listen \[::1\]:8443 ssl;/);
  assert.match(localProxy, /allow 127\.0\.0\.1;/);
  assert.match(localProxy, /allow ::1;/);
  assert.doesNotMatch(localProxy, /listen\s+(?:443|8443)\s/);
  assert.match(localProxy, /__TRUSTED_LOCALHOST_CERTIFICATE_PATH__/);
});

test("HPP exact Host validation accepts and requires the configured non-default HTTPS port", async () => {
  const origin = "https://localhost:8443";
  const handler = createHppHandler({ gate: new HppGate("synthetic-long-operator-token-for-port-test"),
    service: new HppService(async () => { throw new Error("not used"); }), publicOrigin: origin, w1Only: true });
  const call = async (host: string) => {
    const req = Readable.from([]) as unknown as IncomingMessage;
    Object.assign(req, { method: "GET", url: "/", headers: { host } });
    let status = 0, body = ""; const headers: Record<string, string> = {};
    const res = { writeHead(code: number, fields: Record<string, string> = {}) { status = code; Object.assign(headers, fields); return this; }, end(value?: string) { body = String(value ?? ""); } } as unknown as ServerResponse;
    await handler(req, res);
    return { status, body, headers };
  };
  assert.equal((await call("localhost:8443")).status, 200);
  assert.equal((await call("localhost")).status, 400);
  assert.equal((await call("localhost:9443")).status, 400);
});
