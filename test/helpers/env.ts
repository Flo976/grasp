import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Environnement XDG isolé dans un répertoire temporaire court (les sockets Unix sont limités à ~108 octets). */
export interface TestEnv {
  root: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export function makeTestEnv(extra: NodeJS.ProcessEnv = {}): TestEnv {
  const root = mkdtempSync(join(tmpdir(), 'gr-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'c'),
    XDG_STATE_HOME: join(root, 's'),
    XDG_DATA_HOME: join(root, 'd'),
    XDG_RUNTIME_DIR: join(root, 'r'),
    GRASP_SESSION: '',
    ...extra,
  };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
