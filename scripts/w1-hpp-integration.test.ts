import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HppGate, HppService } from "../spike/hpp.ts";
import { createHppHandler } from "../spike/hpp-server.ts";
import { W1Journal, type W1CreateRequest, type W1Provider } from "./w1-safe-path.ts";

const now = new Date("2026-10-29T12:00:00.000Z");
const origin = "https://checkout.example.test";
const op = "synthetic-operator-token-long-enough-for-test";

test("W1 fake-provider intent survives journal restart and HPP hands off same intent once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ft-w1-hpp-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(dir, { recursive: true, force: true }); });
  const journalPath = join(dir, "w1.sqlite");
  const statePath = join(dir, "fake-provider.json");
  const childCode = `
    import { writeFileSync } from 'node:fs';
    import { W1Journal, runW1Once } from './scripts/w1-safe-path.ts';
    const journal = await W1Journal.open(process.argv[1]);
    let creates = 0, gets = 0, body;
    const provider = {
      providerKind: 'FAKE',
      async create(input, options) {
        if (options.retry !== false) throw new Error('retry enabled');
        creates++; body = { id: 'int_fake_w1_123', ...input, status: 'REQUIRES_PAYMENT_METHOD', client_secret: 'fake-secret-not-persisted', created_at: '2026-10-29T12:00:00.000Z' };
        return { httpStatus: 201, body };
      },
      async retrieve(id) { gets++; if (id !== body.id) throw new Error('wrong ID'); return { httpStatus: 200, body: { ...body } }; }
    };
    try {
      const receipt = await runW1Once({ provider, journal, now: () => new Date('2026-10-29T12:00:00.000Z') });
      writeFileSync(process.argv[2], JSON.stringify({ creates, gets, body }));
      process.stdout.write(JSON.stringify({ phase: receipt.phase, postCount: receipt.postCount, retrieveCount: receipt.retrieveCount }));
    } finally { journal.close(); }
  `;
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "--input-type=module", "-e", childCode, journalPath, statePath], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { phase:"READBACK_VERIFIED", postCount:1, retrieveCount:1 });
  const durableFake = JSON.parse(await readFile(statePath, "utf8")) as { creates:number; gets:number; body:Record<string,unknown> };
  let creates = durableFake.creates, gets = durableFake.gets;
  const intentBody = durableFake.body;
  const provider: W1Provider = {
    providerKind: "FAKE",
    async create(_input: W1CreateRequest) { creates++; throw new Error("second create forbidden"); },
    async retrieve(id) { gets++; assert.equal(id, "int_fake_w1_123"); return { httpStatus: 200, body: { ...intentBody } }; },
  };
  // A new process opens the durable journal and can only continue the recorded attempt.
  const journal = await W1Journal.open(journalPath);
  const attempt = journal.readHandoffAttempt(); assert.ok(attempt);
  const gate = new HppGate(op, { sessions: [] }, async () => {}, () => now.getTime());
  const handler = createHppHandler({ gate, service: new HppService(async (method) => {
    assert.equal(method, "GET"); gets++; return { ...intentBody };
  }), publicOrigin: origin, now: () => now.getTime(), w1Journal: journal, w1Provider: provider });
  const call = async (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const req = Readable.from(options.body ? [Buffer.from(options.body)] : []) as unknown as IncomingMessage;
    const requestHeaders = Object.fromEntries(Object.entries(options.headers ?? {}).map(([k,v]) => [k.toLowerCase(), v]));
    requestHeaders.host ??= "checkout.example.test";
    Object.assign(req, { method: options.method ?? "GET", url: path, headers: requestHeaders });
    let status = 0, body = ""; const headers: Record<string,string> = {};
    const res = { writeHead(code: number, h: Record<string,string> = {}) { status=code; Object.assign(headers,h); return this; }, end(value?: string) { body=String(value ?? ""); } } as unknown as ServerResponse;
    await handler(req,res); return { status, body, headers };
  };
  const bootstrap = "synthetic-bootstrap-csrf-token-01234567890123456789";
  // Handler uses its own bootstrap token; recover it from page source for the local fake session.
  const page = await call("/");
  const token = page.body.match(/csrfBootstrap="([^"]+)"/)?.[1] ?? bootstrap;
  const login = await call("/api/session", { method:"POST", headers:{ origin, "content-type":"application/json", "x-csrf-token": token }, body:JSON.stringify({operatorToken:op}) });
  assert.equal(login.status,200);
  const cookie = login.headers["set-cookie"]!.split(";")[0]!;
  const session = await call("/api/session", { headers:{ cookie } });
  const csrf = (JSON.parse(session.body) as {csrfToken:string}).csrfToken;
  const headers = { cookie, origin, "content-type":"application/json", "x-csrf-token":csrf };
  const handoff = await call("/api/checkout/w1-handoff", {method:"POST", headers, body:"{}"});
  assert.equal(handoff.status,200);
  const data = JSON.parse(handoff.body) as Record<string,unknown>;
  assert.equal(data.id, "int_fake_w1_123");
  assert.equal(data.client_secret, "fake-secret-not-persisted");
  assert.equal(creates,1,"handoff must not create another PaymentIntent");
  assert.equal(gets,2,"one initial W1 read-back and one fresh handoff read-back");
  assert.doesNotMatch(JSON.stringify(journal.read()), /fake-secret-not-persisted/);
  assert.doesNotMatch(JSON.stringify(gate.state), /fake-secret-not-persisted/);
  assert.equal((await call("/api/checkout/w1-handoff", {method:"POST",headers,body:"{}"})).status,409,"launch is one-use");
  assert.equal((await call("/api/checkout", {method:"POST",headers,body:"{}"})).status,409,"old create route cannot create for this W1 attempt");
  const postCheckout = await call("/api/checkout", {headers:{cookie}});
  assert.equal(postCheckout.status,200);
  assert.equal((JSON.parse(postCheckout.body) as {status:string}).status,"REQUIRES_PAYMENT_METHOD","status is confirmed only through a server-side read-back");
  assert.equal(gets,3,"initial W1 GET, fresh handoff GET, and post-checkout GET");
  assert.equal(creates,1);
  assert.equal((await call("/api/checkout/w1-handoff", {method:"POST",headers:{...headers,origin:"https://evil.test"},body:"{}"})).status,403);
  journal.close();
});

test("W1 and HPP launch fences remain consumed after provider timeout or a dropped handoff response", async (t) => {
  for (const failureMode of ["provider-timeout", "response-dropped"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `ft-w1-hpp-${failureMode}-`));
    t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(dir, { recursive: true, force: true }); });
    const createdAt = "2026-10-29T12:00:00.000Z";
    const attempt = { id: "int_fake_handoff_123", request_id: "req_fake_handoff", merchant_order_id: "order_fake_handoff", amount: 1, currency: "USD", createdAt, phase: "READBACK_VERIFIED" as const };
    const journal = await W1Journal.open(join(dir, "w1.sqlite"));
    journal.dispatch({ requestId: attempt.request_id, merchantOrderId: attempt.merchant_order_id, createdAt });
    journal.transition("DISPATCHED", "CREATE_VERIFIED", { intentId: attempt.id, providerCreatedAt: createdAt, httpStatus: 201 });
    journal.transition("CREATE_VERIFIED", "READBACK_VERIFIED", { providerStatus: "REQUIRES_PAYMENT_METHOD", retrieveHttpStatus: 200 });
    let createCalls = 0, getCalls = 0;
    const provider: W1Provider = {
      providerKind: "FAKE",
      async create() { createCalls++; throw new Error("W1 create forbidden in handoff test"); },
      async retrieve(id) {
        getCalls++; assert.equal(id, attempt.id);
        if (failureMode === "provider-timeout") throw new Error("synthetic GET timeout");
        return { httpStatus: 200, body: { ...attempt, created_at: createdAt, status: "REQUIRES_PAYMENT_METHOD", client_secret: "synthetic-secret-long-enough-for-test" } };
      },
    };
    const gate = new HppGate(op);
    const session = await gate.createSession(op);
    const sessionHash = gate.authenticate(session.sessionToken);
    const csrf = await gate.rotateCsrf(sessionHash);
    const handler = createHppHandler({ gate, service: new HppService(async () => { throw new Error("legacy create forbidden"); }),
      publicOrigin: origin, w1Journal: journal, w1Provider: provider, w1Only: true,
      now: () => Date.parse(createdAt) + 5_000 });
    const call = async (dropResponse = false) => {
      const req = Readable.from([Buffer.from("{}")]) as unknown as IncomingMessage;
      Object.assign(req, { method: "POST", url: "/api/checkout/w1-handoff", headers: {
        host: "checkout.example.test", origin, cookie: `__Host-fairtrial_session=${session.sessionToken}`,
        "content-type": "application/json", "content-length": "2", "x-csrf-token": csrf,
      } });
      let status = 0, body = "";
      const res = { writeHead(code: number) { status = code; return this; }, end(value?: string) { body = String(value ?? ""); } } as unknown as ServerResponse;
      await handler(req, res);
      return dropResponse ? { status: 0, body: "" } : { status, body };
    };
    const first = await call(failureMode === "response-dropped");
    if (failureMode === "provider-timeout") {
      assert.equal(first.status, 503);
      assert.equal(JSON.parse(first.body).error, "provider_read_failed");
    } else {
      assert.equal(first.status, 0, "simulate a proxy/client that loses the completed response");
      assert.equal(first.body, "");
    }
    const replay = await call();
    assert.equal(replay.status, 409);
    assert.equal(JSON.parse(replay.body).error, "launch_permission_consumed");
    assert.equal(getCalls, 1);
    assert.equal(createCalls, 0);
    assert.equal(journal.claimW2Launch(attempt), false, "durable W1 fence remains consumed");
    journal.close();
  }
});
