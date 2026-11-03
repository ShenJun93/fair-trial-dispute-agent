import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

const port = Number(arg('--port'));
const configPath = arg('--config');
const readyPath = arg('--ready-file');
const config = JSON.parse(await readFile(configPath, 'utf8'));
let healthRequests = 0;

const server = createServer((request, response) => {
  if (request.url !== '/health') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
    return;
  }
  const sequence = config.responses;
  const item = sequence[Math.min(healthRequests, sequence.length - 1)];
  healthRequests += 1;
  response.writeHead(item.status, { 'content-type': 'application/json' });
  response.end(typeof item.body === 'string' ? item.body : JSON.stringify(item.body));
});

server.listen(port, '127.0.0.1', async () => {
  const address = server.address();
  await writeFile(readyPath, JSON.stringify({
    host: '127.0.0.1',
    port: address.port,
    pid: process.pid,
    mode: config.mode ?? 'sequence',
  }), 'utf8');
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
