import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolList } from '../../src/cli/mcp.js';
import { RUN_COMMANDS } from '../../src/core/script.js';

test('outil MCP run : sa description annonce chaque commande de grasp run (viewport compris)', () => {
  const run = toolList().find((t) => (t as { name: string }).name === 'run') as { description: string } | undefined;
  assert.ok(run !== undefined, 'outil run absent');
  for (const cmd of RUN_COMMANDS) assert.match(run.description, new RegExp(`\\b${cmd}\\b`), `« ${cmd} » absent de la description de run`);
  assert.match(run.description, /viewport 360x800/, 'syntaxe courte de viewport annoncée');
});
