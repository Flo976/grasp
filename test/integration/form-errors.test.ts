import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, type PageFixture } from '../helpers/chrome.js';
import { startTestSite, type TestSite } from '../helpers/testsite.js';

/**
 * Erreurs de formulaire visibles par l'agent (snap, --snap-diff, notes), sur toutes les variantes de
 * balisage du site de test, dont le balisage Malt relevé (message aria-hidden, champ sans aria-*).
 */

let site: TestSite;
let fx: PageFixture;
before(async () => { site = await startTestSite(); fx = await openPage(); });
after(async () => { await fx.close(); await site.close(); });

const TROP_LONG = 'Développeur PHP Symfony Migration Sécurité Web IA Expert'; // 56 caractères, maxlength=50
const line = (text: string, re: RegExp) => text.split('\n').map((l) => l.trim()).find((l) => re.test(l)) ?? '';

test('Malt : message aria-hidden sous un champ sans aria-* → [invalide: …] sur le champ, dans le diff du fill et dans snap --scope', async () => {
  await fx.page.navigate(`${site.url}/erreurs`);
  const r = await fx.page.fill('#headline', TROP_LONG, { snapDiff: true });
  assert.match(r.diff ?? '', /^~ e[0-9a-z]+:textbox "Intitulé du poste"="Développeur PHP Symfony Migration Sécurité Web IA Expert" \[focus\] \[invalide: Doit compter au maximum 50 caractères\]$/m, r.diff);
  assert.match(r.detail ?? '', /champ invalide après la saisie : Doit compter au maximum 50 caractères/, r.detail);
  assert.match(r.detail ?? '', /56 caractères.*maxlength=50/, 'saisie au-delà de maxlength signalée');
  const scoped = (await fx.page.snapshot({ scope: '#tiroir' })).text;
  assert.match(line(scoped, /Intitulé du poste/), /\[invalide: Doit compter au maximum 50 caractères\]$/, scoped);
  assert.equal(scoped.split('\n').filter((l) => l.includes('Doit compter au maximum 50 caractères')).length, 1, 'une seule fois');
});

test('Enregistrer : aria-describedby, aria-errormessage, message non relié, validité native, role=alert, toast aria-hidden — tous dans le diff', async () => {
  await fx.page.navigate(`${site.url}/erreurs`);
  await fx.page.fill('#headline', TROP_LONG);
  await fx.page.fill('#cp', '75');
  await fx.page.fill('#mail', 'pas-un-email');
  const r = await fx.page.click('text:Enregistrer', { snapDiff: true });
  const d = r.diff ?? '';
  assert.match(d, /^~ e[0-9a-z]+:textbox "Code postal"="75" \[invalide: Code postal à 5 chiffres\]$/m, d);
  assert.match(d, /^~ e[0-9a-z]+:textbox "Téléphone" \[invalide: Numéro à 10 chiffres\]$/m, d);
  assert.match(d, /^~ e[0-9a-z]+:textbox "Nom" \[invalide: Le nom est obligatoire\]$/m, d);
  assert.match(d, /^~ e[0-9a-z]+:textbox "Email"="pas-un-email" \[invalide: .+\]$/m, d);
  assert.match(d, /^~ e[0-9a-z]+:alert "5 erreur\(s\) dans le formulaire"$/m, d);
  assert.match(d, /^\+ alerte "Enregistrement impossible"$/m, d);
  assert.doesNotMatch(d, /^\+ "(Code postal à 5 chiffres|Numéro à 10 chiffres|Le nom est obligatoire|5 erreur)/m, 'messages non répétés en texte brut');
  assert.doesNotMatch(d, /aucun changement/);
});

test('clic sur un bouton sans effet alors que le formulaire est invalide : la note le dit (diff et sans diff)', async () => {
  await fx.page.navigate(`${site.url}/erreurs`);
  await fx.page.fill('#headline', TROP_LONG);
  await fx.page.fill('#cp', '75001');
  await fx.page.fill('#tel', '0123456789');
  await fx.page.fill('#nom', 'Ada');
  await fx.page.click('text:Enregistrer');
  const r = await fx.page.click('text:Enregistrer', { snapDiff: true });
  assert.match(r.diff ?? '', /^\(aucun changement — formulaire invalide : e[0-9a-z]+:textbox "Intitulé du poste"=.* \[invalide: Doit compter au maximum 50 caractères\]\)$/, r.diff);
  const plain = await fx.page.click('text:Enregistrer');
  assert.match(plain.detail ?? '', /formulaire invalide : e[0-9a-z]+:textbox "Intitulé du poste".*Doit compter au maximum 50 caractères/, plain.detail);
  // Bouton hors formulaire invalide (Annuler est dans le même tiroir : note aussi) ; un lien ou un champ : jamais.
  const f = await fx.page.fill('#nom', 'Ada Lovelace');
  assert.doesNotMatch(f.detail ?? '', /formulaire invalide/);
});

test('correction : l\'erreur disparaît du diff ; formulaire valide : aucune note', async () => {
  await fx.page.navigate(`${site.url}/erreurs`);
  await fx.page.fill('#headline', TROP_LONG);
  const r = await fx.page.fill('#headline', 'Développeur PHP Symfony', { snapDiff: true });
  assert.match(r.diff ?? '', /^~ e[0-9a-z]+:textbox "Intitulé du poste"="Développeur PHP Symfony" \[focus\]$/m, r.diff);
  assert.equal(r.detail, undefined, r.detail);
  await fx.page.fill('#cp', '75001');
  await fx.page.fill('#tel', '0123456789');
  await fx.page.fill('#nom', 'Ada');
  const ok = await fx.page.click('text:Enregistrer', { snapDiff: true });
  assert.match(ok.diff ?? '', /Enregistré/);
  assert.doesNotMatch(`${ok.diff} ${ok.detail}`, /invalide/);
});
