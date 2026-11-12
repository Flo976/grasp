import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLine, parseScript, parseArgs, buildRequest } from '../../src/core/script.js';

test('splitLine : citation à la shell (simples, doubles, échappements), commentaires #', () => {
  assert.deepEqual(splitLine(`fill text:Nom "Ada Lovelace"`), ['fill', 'text:Nom', 'Ada Lovelace']);
  assert.deepEqual(splitLine(`check "text:J'accepte les conditions"`), ['check', "text:J'accepte les conditions"]);
  assert.deepEqual(splitLine(`fill '#email' 'a "b" c'`), ['fill', '#email', 'a "b" c']);
  assert.deepEqual(splitLine(`fill x "dit \\"oui\\" \\\\ fin"`), ['fill', 'x', 'dit "oui" \\ fin']);
  assert.deepEqual(splitLine(`fill x a\\ b`), ['fill', 'x', 'a b']);
  assert.deepEqual(splitLine(`click '#a' # commentaire "non fermé`), ['click', '#a']);
  assert.deepEqual(splitLine(`fill x "#pas un commentaire" y#z`), ['fill', 'x', '#pas un commentaire', 'y#z']);
  assert.deepEqual(splitLine(`fill x ''`), ['fill', 'x', '']);
  assert.deepEqual(splitLine(`  # tout est commentaire`), []);
  assert.deepEqual(splitLine(`#titre`), []);
  assert.deepEqual(splitLine(`click #valider`), ['click', '#valider'], 'un #id collé est un sélecteur CSS, pas un commentaire');
  assert.deepEqual(splitLine(`press Enter #q # puis soumission`), ['press', 'Enter', '#q']);
  assert.deepEqual(splitLine(`nav  http://h/?a=1&b=2\t`), ['nav', 'http://h/?a=1&b=2']);
  assert.throws(() => splitLine(`fill x "Ada`), /guillemet non fermé/);
  assert.throws(() => splitLine(`fill x 'Ada`), /guillemet non fermé/);
});

test('parseScript : numéros de ligne conservés, lignes vides et commentaires ignorés', () => {
  const s = parseScript('# titre\n\nnav http://x/\r\n  snap --max 500\n');
  assert.deepEqual(s.map((x) => [x.line, x.argv]), [[3, ['nav', 'http://x/']], [4, ['snap', '--max', '500']]]);
  assert.equal(s[1]!.text, 'snap --max 500');
  assert.throws(() => parseScript('snap\nfill x "a\n'), /ligne 2 : guillemet non fermé/);
});

test('buildRequest : même syntaxe que la CLI → requête du bridge', () => {
  const r = (line: string) => buildRequest(parseArgs(splitLine(line)));
  assert.deepEqual(r('nav http://x/ --snap-diff'), { cmd: 'nav', method: 'POST', path: '/navigate', body: { url: 'http://x/', snapDiff: true } });
  assert.deepEqual(r('click e1a2 --console --shot-on-error'), { cmd: 'click', method: 'POST', path: '/click', body: { target: 'e1a2', console: true, shotOnError: true } });
  assert.deepEqual(r('check text:CGU --uncheck'), { cmd: 'check', method: 'POST', path: '/check', body: { target: 'text:CGU', checked: false } });
  assert.deepEqual(r('press Enter #q'), { cmd: 'press', method: 'POST', path: '/press', body: { key: 'Enter', target: '#q' } });
  assert.deepEqual(r('snap --scope form --max 900'), { cmd: 'snap', method: 'GET', path: '/snap?max=900&scope=form' });
  assert.deepEqual(r('text'), { cmd: 'text', method: 'GET', path: '/text' });
  assert.deepEqual(r('wait --text "Prêt" --timeout 2000'), { cmd: 'wait', method: 'POST', path: '/wait', body: { text: 'Prêt', timeout: '2000' }, timeoutMs: 17_000 });
  assert.deepEqual(r('console --level error'), { cmd: 'console', method: 'POST', path: '/console', body: { level: 'error', limit: 50 } });
  assert.deepEqual(r('screenshot --el h1 --max-width 300'), { cmd: 'screenshot', method: 'GET', path: '/screenshot?el=h1&maxWidth=300&save=1' });
  assert.deepEqual(r('eval 1+1'), { cmd: 'eval', method: 'POST', path: '/eval', body: { expression: '1+1' } });
  assert.deepEqual(r('profile travail'), { cmd: 'profile', method: 'POST', path: 'profile', body: { name: 'travail' } });
  assert.throws(() => r('fill x'), /usage : grasp fill/);
  assert.throws(() => r('snap --max'), /--max attend une valeur/);
});

test('compileScript : options globales et options inconnues sur une ligne refusées, jamais ignorées', async () => {
  const { compileScript } = await import('../../src/control/run.js');
  const bad = (src: string, re: RegExp) => assert.throws(() => compileScript(src), (e: Error & { status?: number }) => e.status === 400 && re.test(e.message), src);
  bad('nav http://h/\nclick e3 --session autre', /ligne 2 : --session .*grasp run --session/);
  bad('snap --json', /ligne 1 : --json .*grasp run --json/);
  bad('click e3 --profile perso', /ligne 1 : --profile .*profile <nom>/);
  bad('click e3 --port 9000', /ligne 1 : --port/);
  bad('click e3 --continue', /ligne 1 : --continue/);
  bad('click e3 --snapdiff', /ligne 1 : option --snapdiff inconnue pour click .*--snap-diff/);
  bad('text --delay 3', /ligne 1 : option --delay inconnue pour text/);
  // screenshot -o : seulement si l'appelant écrit le fichier (CLI) ; chemins relatifs, sans « .. ».
  bad('screenshot -o x.png', /ligne 1 : screenshot -o n'est disponible que depuis la CLI `grasp run`/);
  const filesBad = (src: string, re: RegExp) => assert.throws(() => compileScript(src, { files: true }), (e: Error & { status?: number }) => e.status === 400 && re.test(e.message), src);
  filesBad('screenshot -o /tmp/x.png', /ligne 1 : .*chemin relatif attendu/);
  filesBad('screenshot -o ~/x.png', /chemin relatif attendu/);
  filesBad('screenshot -o ../x.png', /« \.\. » interdit/);
  filesBad('screenshot -o a/../../x.png', /« \.\. » interdit/);
  filesBad('screenshot -o -', /fichier relatif/);
  filesBad('screenshot -o', /--output attend une valeur/);
  filesBad('screenshot -o a.png\nscreenshot -o ./a.png', /ligne 2 : .*écraserait la capture de la ligne 1/);
  filesBad(Array.from({ length: 21 }, (_, i) => `screenshot -o s${i}.png`).join('\n'), /21 captures nommées.*20 au plus/);
  const shot = compileScript('screenshot -o "captures/étape 1.jpg" --full', { files: true })[0]!.rq;
  assert.deepEqual(shot, { cmd: 'screenshot', method: 'GET', path: '/screenshot?full=1&format=jpeg', saveAs: 'captures/étape 1.jpg' }, 'format déduit de l\'extension, pas de save=1 (l\'image revient au client)');
  // Les options propres à chaque commande restent acceptées.
  const ok = compileScript(`nav http://h/ --snap-diff --console
snap --max 100 --scope main
click e3 --snap-diff --max 9 --scope main --console --shot-on-error --engine playwright
check e4 --uncheck
type e5 abc --delay 10
wait --text Fin --timeout 3000
wait --idle
console --level warn --since 3 --limit 5 --clear
screenshot --full --refs --el e2 --format jpeg --quality 50 --max-width 800
upload e6 /tmp/x --engine playwright
profile perso`);
  assert.equal(ok.length, 11);
});

test('text --markdown : ?markdown=1 (CLI et run) ; refusé ailleurs ou avec une valeur', async () => {
  const r = (line: string) => buildRequest(parseArgs(splitLine(line)));
  assert.deepEqual(r('text --markdown'), { cmd: 'text', method: 'GET', path: '/text?markdown=1' });
  assert.deepEqual(r('text --markdown --max 500 --scope main'), { cmd: 'text', method: 'GET', path: '/text?max=500&scope=main&markdown=1' });
  assert.throws(() => r('snap --markdown'), /--markdown ne s'applique qu'à text/);
  assert.throws(() => r('text --markdown=oui'), /--markdown ne prend pas de valeur/);
  const { compileScript } = await import('../../src/control/run.js');
  assert.equal(compileScript('text --markdown --scope main').length, 1);
  assert.throws(() => compileScript('snap --markdown'), /ligne 1 : option --markdown inconnue pour snap/);
});

test('writeUnder (screenshot -o dans run) : sous le répertoire de sortie seulement, 0600, liens refusés', async () => {
  const { writeUnder } = await import('../../src/cli/runfiles.js');
  const { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'grasp-out-'));
  try {
    const out = join(root, 'out');
    mkdirSync(out);
    const f = writeUnder(out, 'captures/a.png', Buffer.from('img'));
    assert.equal(f, join(out, 'captures', 'a.png'));
    assert.equal(readFileSync(f, 'utf8'), 'img');
    assert.equal(statSync(f).mode & 0o777, 0o600);
    // Réécriture dans le répertoire : permise (relancer une recette).
    writeUnder(out, 'captures/a.png', Buffer.from('img2'));
    assert.equal(readFileSync(f, 'utf8'), 'img2');
    assert.throws(() => writeUnder(out, '../x.png', Buffer.from('x')), /sort du répertoire/);
    assert.throws(() => writeUnder(out, '/etc/x.png', Buffer.from('x')), /relatif/);
    // Répertoire intermédiaire en lien vers l'extérieur : refus, rien n'est créé dehors.
    const dehors = join(root, 'dehors');
    mkdirSync(dehors);
    symlinkSync(dehors, join(out, 'fuite'));
    assert.throws(() => writeUnder(out, 'fuite/sous/x.png', Buffer.from('x')), /lien symbolique/);
    assert.deepEqual(readdirSync(dehors), []);
    // Lien à la place du fichier : remplacé, sa cible jamais écrite.
    const cible = join(root, 'cible.txt');
    writeFileSync(cible, 'intact');
    symlinkSync(cible, join(out, 'piege.png'));
    writeUnder(out, 'piege.png', Buffer.from('img'));
    assert.equal(readFileSync(cible, 'utf8'), 'intact');
    assert.equal(lstatSync(join(out, 'piege.png')).isSymbolicLink(), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkRunOut : --out-dir et chemins de screenshot -o vérifiés AVANT le run, sans rien écrire', async () => {
  const { checkRunOut } = await import('../../src/cli/runfiles.js');
  const { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'grasp-out-'));
  try {
    const out = join(root, 'out');
    // Répertoire de sortie créé (comme avant), sous-répertoires des captures NON créés.
    checkRunOut('nav /\nscreenshot -o captures/a.png\n', out);
    assert.deepEqual(readdirSync(out), []);
    // --out-dir sous un fichier.
    writeFileSync(join(root, 'f'), 'x');
    assert.throws(() => checkRunOut('screenshot -o a.png\n', join(root, 'f', 'sub')), /--out-dir .*f\/sub/);
    // Capture sous un fichier, sur un répertoire, ou par un lien qui sort : ligne citée.
    writeFileSync(join(out, 'g'), 'x');
    assert.throws(() => checkRunOut('nav /\nscreenshot -o g/a.png\n', out), /ligne 2 : screenshot -o g\/a\.png : .*n'est pas un répertoire/);
    mkdirSync(join(out, 'rep'));
    assert.throws(() => checkRunOut('screenshot -o rep\n', out), /ligne 1 : .*est un répertoire/);
    const dehors = join(root, 'dehors');
    mkdirSync(dehors);
    symlinkSync(dehors, join(out, 'fuite'));
    assert.throws(() => checkRunOut('screenshot -o fuite/x.png\n', out), /lien symbolique/);
    assert.equal(existsSync(join(out, 'captures')), false);
    // Script invalide : pas de vérification locale, le serveur rendra l'erreur d'analyse.
    checkRunOut('cliq e1\n', out);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeRunShots : échec d\'écriture tardif → étape KO dans le résultat, jamais une exception qui jette le run', async () => {
  const { writeRunShots } = await import('../../src/cli/runfiles.js');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'grasp-out-'));
  try {
    writeFileSync(join(root, 'f'), 'x');
    const r = {
      ok: true, total: 2, executed: 2,
      steps: [
        { n: 1, line: 1, text: 'screenshot -o a.png', cmd: 'screenshot', ok: true, result: { saveAs: 'a.png', data: Buffer.from('img').toString('base64') } },
        { n: 2, line: 2, text: 'snap', cmd: 'snap', ok: true, output: 'x' },
      ],
    } as unknown as Parameters<typeof writeRunShots>[0];
    // Répertoire de sortie devenu inutilisable entre la vérification et l'écriture.
    assert.doesNotThrow(() => writeRunShots(r, join(root, 'f', 'sub')));
    assert.equal(r.ok, false);
    assert.equal(r.steps[0]!.ok, false);
    assert.match(r.steps[0]!.error!, /capture non écrite/);
    assert.equal((r.steps[0]!.result as { data?: string }).data, undefined, 'jamais le base64 en sortie');
    assert.equal(r.steps[1]!.ok, true, 'les autres étapes restent rendues telles quelles');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('onglets : tabs, tab <id> | new [url] | close [id], --follow transmis ; formes invalides refusées', async () => {
  const { formatTab } = await import('../../src/core/tabs.js');
  const rq = (l: string) => buildRequest(parseArgs(splitLine(l)));
  assert.deepEqual(rq('tabs'), { cmd: 'tabs', method: 'GET', path: '/tabs' });
  assert.deepEqual(rq('tab t2'), { cmd: 'tab', method: 'POST', path: '/tabs/select', body: { id: 't2' } });
  assert.deepEqual(rq('tab new'), { cmd: 'tab', method: 'POST', path: '/tabs/new', body: {}, timeoutMs: 120_000 });
  assert.deepEqual(rq('tab new http://127.0.0.1/'), { cmd: 'tab', method: 'POST', path: '/tabs/new', body: { url: 'http://127.0.0.1/' }, timeoutMs: 120_000 });
  assert.deepEqual(rq('tab close'), { cmd: 'tab', method: 'POST', path: '/tabs/close', body: {} });
  assert.deepEqual(rq('tab close t3'), { cmd: 'tab', method: 'POST', path: '/tabs/close', body: { id: 't3' } });
  assert.equal(rq('click e1 --follow').body?.follow, true);
  assert.equal(rq('click e1').body?.follow, undefined);
  for (const bad of ['tab', 'tab 2', 'tab t0', 'tab close x', 'tab t1 t2', 'tab new a b']) assert.throws(() => rq(bad), /usage|identifiant/, bad);
  assert.equal(formatTab({ id: 't2', url: 'http://x/', title: 'T'.repeat(100), active: false, opener: 't1' }), `  t2 "${'T'.repeat(79)}…" http://x/ (ouvert par t1)`);
});
