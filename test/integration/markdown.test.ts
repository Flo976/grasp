import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { needPlaywright } from '../helpers/playwright.js';
import { makeTestEnv } from '../helpers/env.js';
import { startServer, runCli, waitExit } from '../helpers/server.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';
import { GraspError } from '../../src/core/errors.js';
import { TRUNC_RE } from '../../src/core/limits.js';

/**
 * text --markdown : conversion DOM → Markdown du contenu visible, en code fixe dans le monde isolé
 * (allowEval=false, la valeur par défaut de openPage), avec le budget et --scope de text.
 */

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage({ allowedDomains: ['127.0.0.1', 'localhost'] }); });
after(async () => { await fx.close(); await site.close(); });

const md = (max?: number, scope?: string) => fx.page.text(max, scope, { markdown: true });
const lastLine = (s: string) => s.replace(/\n$/, '').split('\n').pop()!;

const EXPECTED = `# Guide de *lecture*

Un paragraphe avec du **gras**, de l'*italique*, du \`code_inline()\`, un [lien relatif](U/doc/intro?x=1#haut) et **espaces** autour.

Image : ![Logo Grasp](U/logo.png) et pixel ![Pixel](data:image/png;base64,…)

## Listes

- Premier point
- Deuxième point
  - Sous-point A
  - Sous-point **B**
    1. Étape un
    2. Étape deux
- Troisième point

3. Trois
4. Quatre

> Une citation *célèbre*.
>
> Second paragraphe cité.

\`\`\`\`js
function f(x) {
  return \`\`\`x\`\`\`;
}
\`\`\`\`

Tarifs

| Produit | Prix |
| --- | --- |
| Vélo [fiche](U/velo) | 1 \\| 2 € |
| Casque | 30 € |

[Carte cliquable Description de la carte](U/carte)

Saut
de ligne et pseudo-lien.

Bloc flex un

Bloc flex deux

---

Visible à côté

Résumé visible

Bouton visible

Texte *fantôme* : contenu inséré

## Zone

Texte de la **zone**.`;

test('text --markdown : titres, emphase, code, liens absolus, images, listes imbriquées, citation, bloc de code, tableau', async () => {
  await fx.page.navigate(`${site.url}/markdown`);
  assert.equal((await md()).replaceAll(site.url, 'U'), EXPECTED);
});

test('text --markdown : même critère de visibilité que text (caché, script/style/noscript/template, champs)', async () => {
  await fx.page.navigate(`${site.url}/markdown`);
  const m = await md();
  const t = await fx.page.text();
  assert.doesNotMatch(m, /Secret/, m);
  // innerText garde le texte des <option> d'un <select> ; le Markdown omet les champs de formulaire.
  assert.doesNotMatch(t.replace('Secret option', ''), /Secret/, t);
  // Ce qui est visible dans text l'est aussi dans le Markdown.
  for (const s of ['Visible à côté', 'Résumé visible', 'Bouton visible', 'contenu inséré']) {
    assert.ok(t.includes(s), `text : ${s}`);
    assert.ok(m.includes(s), `markdown : ${s}`);
  }
});

test('text --markdown --scope : zone CSS ou ref ; iframe de même origine ; autre origine → 409 qui propose frame=', async () => {
  await fx.page.navigate(`${site.url}/markdown`);
  assert.equal(await md(undefined, '#zone-md'), '## Zone\n\nTexte de la **zone**.');
  const snap = await fx.page.snapshot();
  const line = snap.text.split('\n').find((l) => /link "lien relatif"/.test(l));
  assert.ok(line, snap.text);
  assert.equal(await md(undefined, line.trim().split(':')[0]!), `[lien relatif](${site.url}/doc/intro?x=1#haut)`);
  await assert.rejects(md(undefined, '#absent'), (e: GraspError) => e.status === 404);
  await fx.page.navigate(`${site.url}/cadres`);
  assert.equal(await md(undefined, '#meme'), 'Contenu du cadre');
  await assert.rejects(md(undefined, '#autre'), (e: GraspError) => e.status === 409 && e.message.includes("grasp text --markdown --scope 'frame=#autre'"));
});

test('text --markdown : budget textMax (4000) et --max, ligne de troncature identique à text, reste exact', async () => {
  await fx.page.navigate(`${site.url}/long`);
  const m = await md();
  assert.match(lastLine(m), TRUNC_RE);
  const kept = m.split('\n').slice(0, -1).join('\n');
  assert.ok(kept.length <= 4000, `${kept.length} caractères gardés`);
  const all = await md(1_000_000);
  assert.doesNotMatch(all, /tronqué/);
  assert.equal(Number(/(\d+) caractères restants/.exec(lastLine(m))![1]), all.length - kept.length, 'reste annoncé exact');
  const small = await md(300);
  assert.match(lastLine(small), TRUNC_RE);
  assert.ok(small.split('\n').slice(0, -1).join('\n').length <= 300);
});

test('text --markdown : DOM de 10 000 niveaux, parcours itératif (pile explicite)', async () => {
  await fx.page.navigate(`${site.url}/profond`);
  assert.equal(await md(), 'Surface\n\n**Fond atteint**');
});

test('text --markdown --scope frame=… : dans une iframe d\'une autre origine (moteur Playwright)', { skip: needPlaywright }, async () => {
  await fx.page.navigate(`${site.url}/pw-cadres`);
  const m = await md(undefined, 'frame=#editeur');
  assert.match(m, /^Texte initial$/m);
  assert.match(m, /^Rien$/m);
  assert.doesNotMatch(m, /Petit/, 'options du <select> exclues');
  assert.equal(await md(undefined, 'frame=#editeur >> #etat'), 'Rien');
});

test('CLI et run : grasp text --markdown [--scope] ; --markdown refusé sur snap', async () => {
  const t = makeTestEnv();
  const srv = await startServer(t.env);
  try {
    const id = (await runCli(t.env, ['session', 'create'])).stdout.trim();
    const env = { ...t.env, GRASP_SESSION: id };
    const ok = async (args: string[], stdin?: string) => { const r = await runCli(env, args, stdin); assert.equal(r.code, 0, `${args.join(' ')} : ${r.stderr}`); return r; };
    await ok(['nav', `${site.url}/markdown`]);
    const out = (await ok(['text', '--markdown'])).stdout;
    assert.equal(out.replaceAll(site.url, 'U'), `${EXPECTED}\n`);
    assert.equal((await ok(['text', '--markdown', '--scope', '#zone-md'])).stdout, '## Zone\n\nTexte de la **zone**.\n');
    const bad = await runCli(env, ['snap', '--markdown']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--markdown ne s'applique qu'à text/);
    const ran = await ok(['run'], `text --markdown --scope '#zone-md'\ntext --scope '#zone-md'\n`);
    assert.match(ran.stdout, /\[1\] text --markdown --scope '#zone-md' → OK\n## Zone\n\nTexte de la \*\*zone\*\*\.\n/);
    assert.match(ran.stdout, /\[2\] text --scope '#zone-md' → OK\nZone\n/);
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); t.cleanup(); }
});
