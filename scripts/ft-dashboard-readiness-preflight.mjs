import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `ft-dashboard-readiness-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${process.pid}`;
const output = path.join(root, 'out', runId);
await mkdir(output, { recursive: true });

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function tcpConnect(port, timeoutMs = 2500) {
  const started = performance.now();
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ...result, elapsedMs: Number((performance.now() - started).toFixed(2)) });
    };
    socket.setTimeout(timeoutMs, () => finish({ connected: false, error: 'TIMEOUT' }));
    socket.once('connect', () => finish({ connected: true }));
    socket.once('error', (error) => finish({ connected: false, error: error.code ?? error.name }));
  });
}

async function rawHttp(port, timeoutMs = 3500) {
  const started = performance.now();
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ...result, elapsedMs: Number((performance.now() - started).toFixed(2)) });
    };
    socket.setTimeout(timeoutMs, () => finish({ status: null, error: 'TIMEOUT' }));
    socket.once('connect', () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk) => { response += chunk.toString('latin1'); });
    socket.once('error', (error) => finish({ status: null, error: error.code ?? error.name }));
    socket.once('end', () => finish({ status: Number(response.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/m)?.[1] ?? 0) || null }));
  });
}

function listenerOwner(port) {
  const command = `$ErrorActionPreference='Stop'; Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 4000, windowsHide: true });
  if (result.status === 0) {
    try {
      const parsed = JSON.parse(result.stdout.trim() || '[]');
      const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      return { source: 'Get-NetTCPConnection', rows: rows.map((row) => ({ localAddress: row.LocalAddress, localPort: row.LocalPort, owningProcess: row.OwningProcess })) };
    } catch { return { source: 'Get-NetTCPConnection', error: 'INVALID_OUTPUT' }; }
  }
  const fallback = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
  const rows = (fallback.stdout ?? '').split(/\r?\n/).filter((line) => {
    const parts = line.trim().split(/\s+/);
    return parts[1]?.endsWith(`:${port}`) && /LISTENING/i.test(line);
  }).map((line) => {
    const parts = line.trim().split(/\s+/);
    return { localAddress: parts[1], localPort: port, owningProcess: Number(parts.at(-1)) };
  });
  return { source: 'netstat', rows, exitCode: fallback.status, commandErrorCode: fallback.error?.code ?? null,
    getTcpConnectionExitCode: result.status, getTcpConnectionErrorCode: result.error?.code ?? null };
}

const port = await reservePort();
const startedAt = new Date().toISOString();
const startClock = performance.now();
let appOutput = '';
let childExit = null;
const env = { ...process.env, DISPUTE_PROVIDER_MODE: 'MOCK', DISPUTE_REVIEW_PORT: String(port),
  DISPUTE_REVIEW_DB: path.join(output, 'preflight.sqlite'), FAIR_TRIAL_MODEL_MODE: 'OFFLINE_MOCK',
  DISPUTE_REVIEW_TOKEN: randomBytes(32).toString('base64url') };
for (const key of ['AIRWALLEX_CLIENT_ID', 'AIRWALLEX_API_KEY']) delete env[key];
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'spike/dispute-review-server.ts'],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { appOutput += chunk; });
child.stderr.on('data', (chunk) => { appOutput += chunk; });
child.once('exit', (code, signal) => { childExit = { code, signal, elapsedMs: Number((performance.now() - startClock).toFixed(2)) }; });

let listenObserved = false;
while (performance.now() - startClock < 12_000 && !childExit) {
  if (/listening at http:\/\/127\.0\.0\.1:/i.test(appOutput)) { listenObserved = true; break; }
  await delay(100);
}
const startupElapsedMs = Number((performance.now() - startClock).toFixed(2));
let tcp = { connected: false, error: childExit ? 'CHILD_EXITED' : 'NO_LISTENER_LOG' };
let raw = { status: null, error: childExit ? 'CHILD_EXITED' : 'NO_LISTENER_LOG' };
let nodeFetch = { status: null, error: childExit ? 'CHILD_EXITED' : 'NO_LISTENER_LOG' };
let curl = { status: null, error: childExit ? 'CHILD_EXITED' : 'NO_LISTENER_LOG' };
let owners = listenerOwner(port);
if (listenObserved && !childExit) {
  tcp = await tcpConnect(port);
  raw = await rawHttp(port);
  const fetchStarted = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3500) });
    nodeFetch = { status: response.status, elapsedMs: Number((performance.now() - fetchStarted).toFixed(2)) };
    await response.body?.cancel();
  } catch (error) {
    nodeFetch = { status: null, name: error?.name ?? 'Error', error: String(error?.message ?? '').slice(0, 240),
      code: error?.code ?? null, causeCode: error?.cause?.code ?? null, causeName: error?.cause?.name ?? null,
      elapsedMs: Number((performance.now() - fetchStarted).toFixed(2)) };
  }
  const curlStarted = performance.now();
  const curlResult = spawnSync('curl.exe', ['--noproxy', '*', '--verbose', '--connect-timeout', '2', '--max-time', '5',
    '--output', 'NUL', '--write-out', 'HTTP=%{http_code};CONNECT=%{time_connect};TOTAL=%{time_total}', `http://127.0.0.1:${port}/`],
  { encoding: 'utf8', timeout: 6500, windowsHide: true });
  const curlStatus = curlResult.stdout?.match(/HTTP=(\d{3})/)?.[1];
  const verbose = `${curlResult.stderr ?? ''}\n${curlResult.stdout ?? ''}`;
  const connectionEvidence = verbose.split(/\r?\n/).filter((line) => /Trying 127\.0\.0\.1|Connected to 127\.0\.0\.1|GET \/ HTTP|HTTP\/1\.1 200/i.test(line)).slice(0, 8);
  curl = { status: curlStatus ? Number(curlStatus) : null, exitCode: curlResult.status, signal: curlResult.signal,
    elapsedMs: Number((performance.now() - curlStarted).toFixed(2)), connectMs: Number(curlResult.stdout?.match(/CONNECT=([\d.]+)/)?.[1] ?? 0),
    totalMs: Number(curlResult.stdout?.match(/TOTAL=([\d.]+)/)?.[1] ?? 0),
    noProxyStar: true, directLoopbackStatusProof: Number(curlStatus) === 200, connectionEvidence,
    errorCode: curlResult.error?.code ?? null };
  owners = listenerOwner(port);
}
const loopbackExcludedFromProxy = String(process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').some((entry) => {
  const value = entry.trim().toLowerCase(); return value === '*' || value === '127.0.0.1' || value === 'localhost' || value === '127.0.0.0/8';
});
const proxyEnvironment = { httpProxySet: !!(process.env.HTTP_PROXY || process.env.http_proxy),
  httpsProxySet: !!(process.env.HTTPS_PROXY || process.env.https_proxy), allProxySet: !!(process.env.ALL_PROXY || process.env.all_proxy),
  noProxySet: !!(process.env.NO_PROXY || process.env.no_proxy), loopbackExcludedFromProxy,
  nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY === '1', nodeOptionsContainsProxyFlag: /env-proxy/i.test(process.env.NODE_OPTIONS ?? '') };
const ownershipMatchesChild = owners.rows?.some((row) => Number(row.owningProcess) === child.pid) ?? null;
const pass = !!(listenObserved && !childExit && ownershipMatchesChild && tcp.connected && raw.status === 200 && nodeFetch.status === 200 &&
  curl.status === 200 && curl.exitCode === 0 && curl.noProxyStar && curl.directLoopbackStatusProof);

const requestedTermination = !childExit;
if (requestedTermination) {
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)]);
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  if (childExit === null) childExit = { code: child.exitCode, signal: child.signalCode, terminationSource: 'preflight_controlled_cleanup' };
}
await delay(150);
const cleanup = { listenerAfterCleanup: listenerOwner(port), tcpAfterCleanup: await tcpConnect(port, 800) };
cleanup.portReleased = cleanup.tcpAfterCleanup.error === 'ECONNREFUSED' && (cleanup.listenerAfterCleanup.rows?.length ?? 0) === 0;
cleanup.portReleaseIndeterminate = cleanup.tcpAfterCleanup.connected === false && !cleanup.portReleased && (cleanup.listenerAfterCleanup.rows?.length ?? 0) === 0;

const report = { schemaVersion: 'fair-trial-dashboard-readiness-preflight/v1', status: pass && cleanup.portReleased ? 'PASS' : 'BLOCKED',
  runId, startedAtUtc: startedAt, runtime: { platform: process.platform, node: process.version, executable: process.execPath,
    cwdIsRepositoryRoot: path.resolve(process.cwd()) === root, loopbackOnly: true, applicationMode: 'OFFLINE_MOCK', syntheticOnly: true },
  sandboxContext: { declared: 'local task execution; OS security controls unchanged', envKeysIndicatingSandboxPresent: Object.keys(process.env).filter((key) => /sandbox|codex/i.test(key)).length },
  proxyEnvironment, port, child: { pid: child.pid, parentPid: process.pid, startupElapsedMs, readinessLogObserved: listenObserved,
    exit: childExit, terminationSource: requestedTermination ? 'preflight_controlled_cleanup' : 'child_exit_or_startup_timeout',
    output: appOutput.slice(-2000) }, tcp, rawHttp: raw, nodeFetch, curl, listener: owners,
  ownershipMatchesChild, cleanup, gates: { tcpConnected: tcp.connected, rawHttp200: raw.status === 200,
    nodeFetch200: nodeFetch.status === 200, directCurl200: curl.status === 200, listenerOwnedByChild: ownershipMatchesChild,
    portReleased: cleanup.portReleased } };
await writeFile(path.join(output, 'readiness.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, runId, port, childPid: child.pid, tcp: tcp.connected,
  rawHttp: raw.status, nodeFetch: nodeFetch.status, nodeFetchCode: nodeFetch.causeCode ?? nodeFetch.code ?? null,
  curl: curl.status, ownerMatches: ownershipMatchesChild, portReleased: cleanup.portReleased, output }));
if (report.status !== 'PASS') process.exitCode = 2;
