import { inflateSync } from 'node:zlib';

/** Décodeur PNG minimal (8 bits, RGB ou RGBA, non entrelacé) : de quoi vérifier des pixels dans les tests. */
export interface Pixels { width: number; height: number; at(x: number, y: number): [number, number, number] }

export function decodePng(buf: Buffer): Pixels {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('pas un PNG');
  let off = 8;
  let width = 0, height = 0, colorType = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PNG non géré (profondeur ≠ 8 ou entrelacé)');
      colorType = data[9]!;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bpp === 0) throw new Error(`type de couleur PNG non géré : ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= bpp ? out[y * stride + x - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0;
      let p: number;
      switch (f) {
        case 0: p = v; break;
        case 1: p = v + a; break;
        case 2: p = v + b; break;
        case 3: p = v + ((a + b) >> 1); break;
        case 4: { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error(`filtre PNG inconnu : ${f}`);
      }
      out[y * stride + x] = p & 0xff;
    }
  }
  return { width, height, at: (x, y) => { const i = y * stride + x * bpp; return [out[i]!, out[i + 1]!, out[i + 2]!]; } };
}

/** Nombre de pixels proches de la couleur donnée (tolérance par canal). */
export function countColor(p: Pixels, rgb: [number, number, number], tol = 40): number {
  let n = 0;
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const c = p.at(x, y);
    if (Math.abs(c[0] - rgb[0]) <= tol && Math.abs(c[1] - rgb[1]) <= tol && Math.abs(c[2] - rgb[2]) <= tol) n++;
  }
  return n;
}
