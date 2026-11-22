import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl } from '../../src/core/policy.js';

const allowed = (list: string[], url: string) => checkUrl(list, url).allowed;

test('allowlist vide = tout bloqué (fail-closed)', () => {
  assert.equal(allowed([], 'http://127.0.0.1/'), false);
  assert.equal(allowed([], 'https://example.com/'), false);
});

test('correspondance exacte de l\'hôte, port ignoré, insensible à la casse', () => {
  assert.equal(allowed(['127.0.0.1'], 'http://127.0.0.1:8080/x'), true);
  assert.equal(allowed(['Example.com'], 'https://EXAMPLE.com./'), true);
  assert.equal(allowed(['example.com'], 'https://sub.example.com/'), false);
  assert.equal(allowed(['example.com'], 'https://example.com.evil.org/'), false);
  assert.equal(allowed(['127.0.0.1'], 'https://example.com'), false);
});

test('joker *.domaine = sous-domaines uniquement ; * = tout http(s) (opt-in explicite)', () => {
  assert.equal(allowed(['*.example.com'], 'https://a.b.example.com/'), true);
  assert.equal(allowed(['*.example.com'], 'https://example.com/'), false);
  assert.equal(allowed(['*'], 'https://anything.org/'), true);
});

test('schémas dangereux toujours bloqués, about:blank toujours permis', () => {
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'view-source:http://127.0.0.1/']) {
    assert.equal(allowed(['*'], u), false, u);
  }
  assert.equal(allowed([], 'about:blank'), true);
  assert.equal(allowed(['[::1]'], 'http://[::1]:3000/'), true);
});

test('URL invalide → bloquée avec raison', () => {
  const r = checkUrl(['*'], 'pas une url');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /invalide/);
});

test('withAllowlistAdvice : domaine hors allowlist → commande exacte (liste actuelle + hôte) et rappel du redémarrage ; autres refus inchangés', async () => {
  const { withAllowlistAdvice, stripAllowlistAdvice, checkUrl: check } = await import('../../src/core/policy.js');
  const allowed = ['127.0.0.1', 'localhost', '[::1]'];
  const reason = check(allowed, 'https://dev.app.exemple.com/x').reason;
  assert.equal(reason, 'domaine hors allowlist : dev.app.exemple.com');
  const msg = withAllowlistAdvice(allowed, reason);
  assert.match(msg, /^domaine hors allowlist : dev\.app\.exemple\.com — à autoriser par l'utilisateur humain, pas par l'agent de lui-même ; commande à lui proposer : grasp config set allowedDomains '127\.0\.0\.1,localhost,\[::1\],dev\.app\.exemple\.com' puis redémarrage du serveur \(grasp stop && grasp serve ; service : systemctl --user restart grasp\) — l'allowlist est lue au démarrage, les sessions ouvertes sont fermées$/);
  // Idempotent ; liste vide : la commande ne porte que l'hôte.
  assert.equal(withAllowlistAdvice(allowed, msg), msg);
  assert.match(withAllowlistAdvice([], check([], 'http://a.exemple.com/').reason), /allowedDomains 'a\.exemple\.com' /);
  // Schéma interdit, SSRF, URL invalide : aucune commande (l'allowlist n'y changerait rien).
  for (const r of ['schéma interdit : file:', 'adresse privée : 10.0.0.1 (inscrivez-la telle quelle dans l\'allowlist, ou allowPrivateNetwork=true)', 'URL invalide : x']) assert.equal(withAllowlistAdvice(allowed, r), r);
  // Rapports multi-pages : conseil retiré, le reste du message gardé.
  assert.equal(stripAllowlistAdvice(`navigation bloquée par le garde : ${msg} (https://dev.app.exemple.com/x)`), 'navigation bloquée par le garde : domaine hors allowlist : dev.app.exemple.com (https://dev.app.exemple.com/x)');
  assert.equal(stripAllowlistAdvice('navigation bloquée : schéma interdit : file:'), 'navigation bloquée : schéma interdit : file:');
});
