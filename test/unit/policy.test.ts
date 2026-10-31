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
