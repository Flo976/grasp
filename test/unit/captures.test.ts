import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { imageSize } from '../../src/core/image.js';
import { saveCapture } from '../../src/core/captures.js';
import { makeTestEnv } from '../helpers/env.js';

/** PNG minimal valide (en-tête + IHDR suffisent pour lire les dimensions). */
function png(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(h * (w * 4 + 1)))), chunk('IEND', Buffer.alloc(0))]);
}

test('imageSize : PNG, JPEG (SOF après APP0), WebP VP8/VP8L/VP8X ; format inconnu → erreur', () => {
  assert.deepEqual(imageSize(png(321, 123)), { width: 321, height: 123, format: 'png' });
  // JPEG : SOI, APP0 (16 o), SOF0 avec hauteur 480 / largeur 640
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
  assert.deepEqual(imageSize(jpeg), { width: 640, height: 480, format: 'jpeg' });
  const riff = (fourcc: string, payload: Buffer) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(fourcc), Buffer.alloc(4), payload]);
  // VP8 (avec perte) : 3 o de tag de trame, code de départ 9d 01 2a, largeur/hauteur sur 14 bits
  const vp8 = riff('VP8 ', Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0x58, 0x02]));
  assert.deepEqual(imageSize(vp8), { width: 800, height: 600, format: 'webp' });
  // VP8L (sans perte) : signature 0x2f, puis (w-1) sur 14 bits et (h-1) sur 14 bits
  const w = 100 - 1; const h = 50 - 1;
  const bits = w | (h << 14);
  const vp8l = riff('VP8L', Buffer.from([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff]));
  assert.deepEqual(imageSize(vp8l), { width: 100, height: 50, format: 'webp' });
  // VP8X (étendu) : drapeaux (4 o), puis largeur-1 et hauteur-1 sur 24 bits
  const vp8x = riff('VP8X', Buffer.from([0, 0, 0, 0, 0xff, 0x0f, 0x00, 0x1f, 0x00, 0x00]));
  assert.deepEqual(imageSize(vp8x), { width: 4096, height: 32, format: 'webp' });
  assert.throws(() => imageSize(Buffer.from('GIF89a......')), /format d'image/);
});

test('saveCapture : dossier 0700, fichier 0600, extension selon le format, rotation au-delà de la limite', () => {
  const t = makeTestEnv();
  try {
    const dir = join(t.root, 'state', 'captures');
    const paths: string[] = [];
    for (let i = 0; i < 7; i++) paths.push(saveCapture(dir, png(2, 2), 'png', { keep: 5 }));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const p of paths.slice(-5)) assert.equal(statSync(p).mode & 0o777, 0o600, p);
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 5, `rotation : ${files.join(', ')}`);
    assert.deepEqual(files, paths.slice(-5).map((p) => p.slice(dir.length + 1)).sort(), 'les plus anciennes sont supprimées');
    assert.match(saveCapture(dir, Buffer.from('x'), 'jpeg', { keep: 50 }), /\.jpg$/);
    assert.match(saveCapture(dir, Buffer.from('x'), 'webp', { keep: 50 }), /\.webp$/);
    // La rotation ne touche que nos captures, jamais un autre fichier du dossier.
    writeFileSync(join(dir, 'a-garder.txt'), 'x');
    for (let i = 0; i < 3; i++) saveCapture(dir, png(2, 2), 'png', { keep: 2 });
    assert.ok(readdirSync(dir).includes('a-garder.txt'));
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('grasp-')).length, 2);
  } finally { t.cleanup(); }
});

test('saveCapture : un dossier trop ouvert est resserré à 0700 ; un dossier non inscriptible fait échouer bruyamment', () => {
  const t = makeTestEnv();
  try {
    const dir = join(t.root, 'caps');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    saveCapture(dir, png(1, 1), 'png');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const ro = join(t.root, 'ro');
    mkdirSync(ro, { mode: 0o700 });
    const sub = join(ro, 'captures');
    chmodSync(ro, 0o500);
    try { assert.throws(() => saveCapture(sub, png(1, 1), 'png'), /capture/); } finally { chmodSync(ro, 0o700); }
  } finally { t.cleanup(); }
});
