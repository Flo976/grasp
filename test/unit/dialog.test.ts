import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDialog, dialogLine, dialogLines, parseDialogOption } from '../../src/core/dialog.js';
import { buildRequest, checkRunFlags, parseArgs, parseScript } from '../../src/core/script.js';

const answer = (type: string, opt?: string, def = '') => decideDialog(type, 'm', def, parseDialogOption(opt)).params;

test('défaut sûr (aucune option) : alert et beforeunload acceptés, confirm et prompt REFUSÉS', () => {
  // Test par mutation : accepter confirm/prompt par défaut ferait échouer cette assertion.
  assert.deepEqual(answer('alert'), { accept: true });
  assert.deepEqual(answer('beforeunload'), { accept: true });
  assert.deepEqual(answer('confirm'), { accept: false });
  assert.deepEqual(answer('prompt', undefined, 'proposé'), { accept: false });
  assert.equal(decideDialog('confirm', 'm', '', undefined).seen.byDefault, true);
});

test('--dialog accept|dismiss|texte → réponse par type', () => {
  assert.deepEqual(answer('confirm', 'accept'), { accept: true });
  assert.deepEqual(answer('prompt', 'accept', 'proposé'), { accept: true, promptText: 'proposé' }, 'accept : valeur proposée par la page');
  assert.deepEqual(answer('beforeunload', 'accept'), { accept: true });
  assert.deepEqual(answer('confirm', 'dismiss'), { accept: false });
  assert.deepEqual(answer('prompt', 'dismiss'), { accept: false });
  assert.deepEqual(answer('beforeunload', 'dismiss'), { accept: false });
  assert.deepEqual(answer('alert', 'dismiss'), { accept: true }, 'alert : un seul bouton');
  assert.deepEqual(answer('prompt', 'Alice'), { accept: true, promptText: 'Alice' });
  assert.deepEqual(answer('prompt', 'text:accept'), { accept: true, promptText: 'accept' });
  assert.deepEqual(answer('prompt', 'text:dismiss'), { accept: true, promptText: 'dismiss' });
  assert.deepEqual(answer('prompt', ''), { accept: true, promptText: '' });
  assert.deepEqual(answer('confirm', 'Alice'), { accept: true }, 'texte : confirm accepté, sans texte');
  assert.equal(decideDialog('confirm', 'm', '', parseDialogOption('accept')).seen.byDefault, undefined);
});

test('--dialog : texte borné, caractères de contrôle refusés (400)', () => {
  assert.throws(() => parseDialogOption('x'.repeat(4097)), (e: { status: number }) => e.status === 400);
  assert.doesNotThrow(() => parseDialogOption('x'.repeat(4096)));
  assert.throws(() => parseDialogOption('a\u0000b'), (e: { status: number }) => e.status === 400);
  assert.equal(parseDialogOption(undefined), undefined);
});

test('rapport : une ligne bornée, message sur une ligne, conseil seulement pour un refus par défaut', () => {
  const long = decideDialog('confirm', `ligne 1\nligne 2 ${'x'.repeat(400)}`, '', undefined).seen;
  assert.ok(long.message.length <= 200 && !long.message.includes('\n'), long.message);
  assert.equal(dialogLine(decideDialog('confirm', 'Supprimer ?', '', undefined).seen), 'dialogue confirm « Supprimer ? » → refusé (défaut sûr — --dialog accept pour répondre)');
  assert.equal(dialogLine(decideDialog('confirm', 'Supprimer ?', '', parseDialogOption('dismiss')).seen), 'dialogue confirm « Supprimer ? » → refusé');
  assert.equal(dialogLine(decideDialog('prompt', 'Nom ?', '', parseDialogOption('Ada')).seen), 'dialogue prompt « Nom ? » → accepté avec « Ada »');
  assert.equal(dialogLine(decideDialog('beforeunload', '', '', undefined).seen), 'dialogue beforeunload → accepté (la page est quittée)');
  assert.equal(dialogLine(decideDialog('alert', 'OK', '', undefined).seen), 'dialogue alert « OK » → fermé');
  assert.deepEqual(dialogLines([], 3), ['… 3 autre(s) dialogue(s) non détaillé(s)']);
});

test('CLI et run : --dialog transmis au bridge sur les actions et nav, accepté dans run', () => {
  assert.deepEqual(buildRequest(parseArgs(['click', 'e3', '--dialog', 'accept'])).body, { target: 'e3', dialog: 'accept' });
  assert.deepEqual(buildRequest(parseArgs(['nav', 'http://x/', '--dialog=dismiss'])).body, { url: 'http://x/', dialog: 'dismiss' });
  assert.deepEqual(buildRequest(parseArgs(['fill', 'e3', 'v', '--dialog', 'Nouveau nom'])).body, { target: 'e3', value: 'v', dialog: 'Nouveau nom' });
  assert.throws(() => buildRequest(parseArgs(['click', 'e3', '--dialog'])), /--dialog attend une valeur/);
  const [line] = parseScript('click "#supprimer" --dialog accept --snap-diff');
  const a = parseArgs(line!.argv);
  assert.doesNotThrow(() => checkRunFlags(a));
  assert.deepEqual(buildRequest(a).body, { target: '#supprimer', snapDiff: true, dialog: 'accept' });
  assert.throws(() => checkRunFlags(parseArgs(['snap', '--dialog', 'accept'])), /option --dialog inconnue pour snap/);
});
