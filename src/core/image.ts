export type ImageFormat = 'png' | 'jpeg' | 'webp';
export interface ImageSize { width: number; height: number; format: ImageFormat }

/** Dimensions réelles d'une image (PNG, JPEG, WebP) lues dans son en-tête, sans décodage. */
export function imageSize(b: Buffer): ImageSize {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) { off++; continue; }
      const marker = b[off + 1]!;
      if (marker === 0xff) { off++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = b.readUInt16BE(off + 2);
      // SOF0..SOF15, hors DHT (c4), JPG (c8) et DAC (cc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7), format: 'jpeg' };
      }
      off += 2 + len;
    }
    throw new Error('JPEG sans en-tête SOF');
  }
  if (b.length >= 25 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    const d = 20;
    if (chunk === 'VP8 ' && b.length >= d + 10) return { width: b.readUInt16LE(d + 6) & 0x3fff, height: b.readUInt16LE(d + 8) & 0x3fff, format: 'webp' };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(d + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, format: 'webp' };
    }
    if (chunk === 'VP8X' && b.length >= d + 10) return { width: b.readUIntLE(d + 4, 3) + 1, height: b.readUIntLE(d + 7, 3) + 1, format: 'webp' };
  }
  throw new Error('format d\'image non reconnu (PNG, JPEG ou WebP attendu)');
}
