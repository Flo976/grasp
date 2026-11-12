import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Protection SSRF : un hôte admis par l'allowlist ne doit pas, par sa résolution DNS, mener à une adresse
 * privée ou réservée (boucle locale, RFC 1918, lien local et métadonnées cloud, CGNAT, ULA…).
 *
 * La classification des adresses suit le crate `obscura-ssrf` d'Obscura
 * (https://github.com/h4ckf0r0day/obscura, crates/obscura-ssrf/src/lib.rs, Apache-2.0), réécrite en
 * TypeScript : mêmes plages, mêmes formes IPv4 encapsulées dans IPv6 (mappée, compatible, NAT64, 6to4,
 * Teredo). Ajouts : site-local IPv6 dépréciée (fec0::/10).
 */

/** Résolution d'un nom en adresses (toutes familles). Injectable pour les tests. */
export type Resolver = (host: string) => Promise<string[]>;

const DNS_TIMEOUT_MS = 3000;

/** Résolveur du système (getaddrinfo : /etc/hosts, resolv.conf, systemd-resolved), borné dans le temps. */
export const systemResolver: Resolver = async (host) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`délai DNS dépassé (${DNS_TIMEOUT_MS} ms)`)), DNS_TIMEOUT_MS);
  });
  try {
    const r = await Promise.race([lookup(host, { all: true, verbatim: true }), timeout]);
    return r.map((a) => a.address);
  } finally { clearTimeout(timer); }
};

function v4Bytes(s: string): number[] | null {
  if (!isIPv4(s)) return null;
  return s.split('.').map(Number);
}

/** IPv6 → 8 mots de 16 bits (accepte la forme « ::ffff:1.2.3.4 » et un identifiant de zone « %eth0 »). */
function v6Words(raw: string): number[] | null {
  const s = raw.replace(/%.*$/, '');
  if (!isIPv6(s)) return null;
  let head = s;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted !== null) {
    const b = v4Bytes(dotted[1]!);
    if (b === null) return null;
    tail.push((b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!);
    head = s.slice(0, -dotted[1]!.length);
    if (!head.endsWith('::') && head.endsWith(':')) head = head.slice(0, -1);
  }
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((h) => parseInt(h, 16)));
  let words: number[];
  if (head.includes('::')) {
    const [l, r] = head.split('::') as [string, string];
    const left = parse(l);
    const right = [...parse(r), ...tail];
    words = [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  } else words = [...parse(head), ...tail];
  return words.length === 8 ? words : null;
}

const v4FromWords = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

function classifyV4(o: number[]): string | null {
  const [a, b, c, d] = o as [number, number, number, number];
  if (a === 0) return 'non spécifiée (0.0.0.0/8)';
  if (a === 127) return 'boucle locale (127.0.0.0/8)';
  if (a === 10) return 'privée (10.0.0.0/8)';
  if (a === 172 && b >= 16 && b <= 31) return 'privée (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'privée (192.168.0.0/16)';
  if (a === 169 && b === 254) return 'lien local (169.254.0.0/16, métadonnées cloud)';
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT (100.64.0.0/10)';
  if (a === 198 && (b === 18 || b === 19)) return 'banc d\'essai (198.18.0.0/15)';
  if (a === 192 && b === 88 && c === 99) return 'relais 6to4 (192.88.99.0/24)';
  // 192.0.0.0/24 : usage spécial, sauf les deux anycast PCP routables (.9 et .10).
  if (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) return 'réservée IETF (192.0.0.0/24)';
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'documentation';
  if (a >= 224 && a <= 239) return 'multicast (224.0.0.0/4)';
  if (a >= 240) return 'réservée (240.0.0.0/4, diffusion)';
  return null;
}

function classifyV6(w: number[]): string | null {
  const zeros = (n: number) => w.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return 'non spécifiée (::)';
  if (zeros(7) && w[7] === 1) return 'boucle locale (::1)';
  // IPv4 mappée (::ffff:a.b.c.d) ou compatible (::a.b.c.d) : on juge l'IPv4 encapsulée.
  if (zeros(5) && (w[5] === 0xffff || w[5] === 0)) {
    const inner = classifyV4(v4FromWords(w[6]!, w[7]!).split('.').map(Number));
    return inner === null ? null : `IPv4 encapsulée ${w[5] === 0xffff ? 'mappée' : 'compatible'} : ${inner}`;
  }
  if ((w[0]! & 0xfe00) === 0xfc00) return 'locale unique (fc00::/7, ULA)';
  if ((w[0]! & 0xffc0) === 0xfe80) return 'lien local (fe80::/10)';
  if ((w[0]! & 0xffc0) === 0xfec0) return 'site local (fec0::/10, dépréciée)';
  if ((w[0]! & 0xff00) === 0xff00) return 'multicast (ff00::/8)';
  const embedded = (label: string, ...v4s: string[]): string | null => {
    for (const ip of v4s) {
      const inner = classifyV4(ip.split('.').map(Number));
      if (inner !== null) return `IPv4 encapsulée (${label}) : ${inner}`;
    }
    return null;
  };
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) return embedded('NAT64', v4FromWords(w[6]!, w[7]!));
  if (w[0] === 0x2002) return embedded('6to4', v4FromWords(w[1]!, w[2]!));
  if (w[0] === 0x2001 && w[1] === 0) return embedded('Teredo', v4FromWords(w[2]!, w[3]!), v4FromWords(~w[6]! & 0xffff, ~w[7]! & 0xffff));
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return 'rebut (100::/64)';
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return 'NAT64 local (64:ff9b:1::/48)';
  if (w[0] === 0x2001 && w[1] === 0x0db8) return 'documentation (2001:db8::/32)';
  if (w[0] === 0x3fff && (w[1]! & 0xf000) === 0) return 'documentation (3fff::/20)';
  return null;
}

/**
 * Catégorie d'une adresse IP privée ou réservée, `null` si elle est publique, `undefined` si ce n'est pas
 * une adresse IP. Accepte les crochets d'un hôte d'URL (`[::1]`).
 */
export function classifyIp(ip: string): string | null | undefined {
  const s = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v4 = v4Bytes(s);
  if (v4 !== null) return classifyV4(v4);
  const v6 = v6Words(s);
  if (v6 !== null) return classifyV6(v6);
  return undefined;
}

/** `localhost` et ses sous-domaines : Chrome les résout lui-même en boucle locale, sans DNS (RFC 6761). */
export function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}
