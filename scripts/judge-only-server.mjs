// Fair Trial Judge-only launcher. Intentionally rejects provider LIVE or model LIVE modes.
// This protects normal npm-run entrypoint; it is not a claim that all source is inert.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const providerMode = process.env.DISPUTE_PROVIDER_MODE ?? 'MOCK';
const plannerMode = process.env.FAIR_TRIAL_MODEL_MODE ?? 'OFFLINE_MOCK';
if (providerMode !== 'MOCK' || plannerMode !== 'OFFLINE_MOCK') {
  console.error('JUDGE_ONLY_OFFLINE_MODE_REQUIRED: provider must be MOCK; model must be OFFLINE_MOCK.');
  process.exit(2);
}
const env = { ...process.env, DISPUTE_PROVIDER_MODE: 'MOCK', FAIR_TRIAL_MODEL_MODE: 'OFFLINE_MOCK' };
for (const key of Object.keys(env)) {
  if (/^(AIRWALLEX|FT_W1_|OPENAI_|ANTHROPIC_)/i.test(key)) delete env[key];
}
const child = spawn(process.execPath, [
  '--disable-warning=ExperimentalWarning','--import','tsx',
  resolve(repo,'spike/dispute-review-server.ts')
], { cwd: repo, env, stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('JUDGE_SERVER_SPAWN_FAILED'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT','SIGTERM']) {
  process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
