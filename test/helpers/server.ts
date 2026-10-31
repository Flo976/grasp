import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths, type GraspPaths } from '../../src/core/paths.js';
import { request, type HttpResult } from '../../src/core/http.js';
import { waitUntil } from './procs.js';

export const CLI = join(process.cwd(), 'dist', 'src', 'cli', 'main.js');

export interface Server { proc: ChildProcess; paths: GraspPaths; stderr: () => string; token: () => string; api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> }

export async function startServer(env: NodeJS.ProcessEnv, args: string[] = []): Promise<Server> {
  const paths = resolvePaths(env, env.HOME);
  const proc = spawn(process.execPath, [CLI, 'serve', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr!.on('data', (d) => { err += d.toString(); });
  proc.stdout!.on('data', (d) => { err += d.toString(); });
  const ready = await waitUntil(() => existsSync(paths.endpointFile) || proc.exitCode !== null, 30_000);
  if (!ready || proc.exitCode !== null) throw new Error(`serve n'a pas démarré (code ${proc.exitCode}) :\n${err}`);
  const token = () => readFileSync(paths.tokenFile, 'utf8').trim();
  return {
    proc, paths, stderr: () => err, token,
    api: (method, path, body, headers = {}) => request(JSON.parse(readFileSync(paths.endpointFile, 'utf8')), method, path, body, { authorization: `Bearer ${token()}`, ...headers }),
  };
}

export function runCli(env: NodeJS.ProcessEnv, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string; raw: Buffer }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
    p.on('close', (code) => { const raw = Buffer.concat(out); resolve({ code: code ?? -1, stdout: raw.toString(), stderr, raw }); });
  });
}

export function waitExit(proc: ChildProcess, timeoutMs = 15_000): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    proc.once('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}
