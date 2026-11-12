import { readFileSync } from 'node:fs';
import { parseArgs, VALUE_FLAGS } from '../core/script.js';
import type { HttpResult } from '../core/http.js';
import {
  DEFAULT_CONCURRENCY, DEFAULT_MAX_LINKS, DEFAULT_MAX_PAGES, MAX_CONCURRENCY, MAX_LINKS, MAX_PAGES,
  absoluteUrl, boundedInt, dedupe, discover, formatAudit, formatDiff, parseList, runAudit, runDiff, type Call,
} from '../core/multipage.js';

/**
 * `grasp diff` et `grasp audit` côté CLI : lecture des options et des listes, sessions éphémères (une par
 * travailleur, fermées à la fin, Ctrl-C compris), rendu. La logique est dans src/core/multipage.ts.
 */

/** Appel d'une route ; `session` : en-tête x-grasp-session (undefined : routes hors session). */
export type SessionCall = (session: string | undefined, method: string, path: string, body?: unknown, timeoutMs?: number) => Promise<HttpResult>;

const FLAGS = new Set([...VALUE_FLAGS, 'paths', 'concurrency', 'max-links']);
const COMMON = ['max', 'concurrency', 'ignore', 'json', 'session', 'profile', 'proxy', 'http-auth'];
const ALLOWED: Record<'diff' | 'audit', Set<string>> = {
  diff: new Set([...COMMON, 'paths']),
  audit: new Set([...COMMON, 'max-links', 'no-links']),
};
export const DIFF_USAGE = 'grasp diff <urlA> <urlB> [--paths fichier|-] [--max N] [--concurrency N] [--ignore <regex>] [--json]';
export const AUDIT_USAGE = 'grasp audit <url-sitemap|url…|fichier|-> [--max N] [--concurrency N] [--max-links N | --no-links] [--ignore <regex>] [--json]';

function str(flags: Map<string, string | true>, k: string): string | undefined {
  const v = flags.get(k);
  if (v === true) throw new Error(`--${k} attend une valeur`);
  return v;
}

function readList(src: string, what: string): string[] {
  let text: string;
  try { text = readFileSync(src === '-' ? 0 : src, 'utf8'); } catch (e) { throw new Error(`impossible de lire ${src === '-' ? 'stdin' : src} (${what}) : ${(e as Error).message}`); }
  return parseList(text);
}

export async function multipageCmd(cmd: 'diff' | 'audit', argv: string[], call: SessionCall, io: { out(s: string): void; hint(s: string): void }): Promise<number> {
  const a = parseArgs(argv, FLAGS);
  const usage = cmd === 'diff' ? DIFF_USAGE : AUDIT_USAGE;
  for (const k of a.flags.keys()) if (!ALLOWED[cmd].has(k)) throw new Error(`option inconnue --${k} — usage : ${usage}`);
  const max = boundedInt(a.flags.get('max'), 'max', DEFAULT_MAX_PAGES, MAX_PAGES);
  let concurrency = boundedInt(a.flags.get('concurrency'), 'concurrency', DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
  const ignoreSrc = str(a.flags, 'ignore');
  let ignore: RegExp | undefined;
  if (ignoreSrc !== undefined) { try { ignore = new RegExp(ignoreSrc, 'i'); } catch (e) { throw new Error(`--ignore : expression régulière invalide : ${(e as Error).message}`); } }
  // Session imposée : seulement par --session explicite. GRASP_SESSION (l'onglet de travail de l'agent) n'est pas
  // emmené de page en page par une recette.
  const session = str(a.flags, 'session');
  const profile = str(a.flags, 'profile');
  const proxy = str(a.flags, 'proxy');
  const auth = str(a.flags, 'http-auth');
  if (session !== undefined && (profile !== undefined || proxy !== undefined || auth !== undefined)) throw new Error('--session exclut --profile, --proxy et --http-auth (la session existe déjà avec ses options)');
  if (session !== undefined || profile !== undefined) {
    if (a.flags.has('concurrency') && concurrency > 1) throw new Error(`${session !== undefined ? '--session' : '--profile'} impose --concurrency 1 (un profil ne sert qu'à une session à la fois)`);
    concurrency = 1;
  }

  const checkLinks = !a.flags.has('no-links');
  if (!checkLinks && a.flags.has('max-links')) throw new Error('--max-links et --no-links s\'excluent');
  const maxLinks = boundedInt(a.flags.get('max-links'), 'max-links', DEFAULT_MAX_LINKS, MAX_LINKS);

  // Entrées, lues AVANT de créer des sessions (une faute de frappe ne lance aucun Chrome).
  let stdinUsed = false;
  const listFrom = (src: string, what: string) => { if (src === '-') { if (stdinUsed) throw new Error('stdin ne peut servir qu\'une fois'); stdinUsed = true; } return readList(src, what); };
  let diffIn: { urlA: string; urlB: string; paths?: string[] } | undefined;
  let auditIn: { seeds: string[]; listed: boolean; source: string } | undefined;
  if (cmd === 'diff') {
    if (a.pos.length !== 2) throw new Error(`usage : ${usage}`);
    const urlA = absoluteUrl(a.pos[0]!);
    const urlB = absoluteUrl(a.pos[1]!);
    const pf = str(a.flags, 'paths');
    let paths: string[] | undefined;
    if (pf !== undefined) {
      paths = dedupe(listFrom(pf, '--paths'));
      if (paths.length === 0) throw new Error(`--paths ${pf} : aucun chemin (un par ligne, # pour commenter)`);
      for (const p of paths) { absoluteUrl(p, urlA); absoluteUrl(p, urlB); }
    }
    diffIn = { urlA, urlB, ...(paths !== undefined ? { paths } : {}) };
  } else {
    if (a.pos.length === 0) throw new Error(`usage : ${usage}`);
    const isUrl = (s: string) => /^https?:\/\//i.test(s);
    if (a.pos.length === 1 && isUrl(a.pos[0]!)) auditIn = { seeds: [absoluteUrl(a.pos[0]!)], listed: false, source: a.pos[0]! };
    else {
      const seeds = a.pos.flatMap((p) => (isUrl(p) ? [p] : listFrom(p, 'liste'))).map((u) => absoluteUrl(u));
      if (seeds.length === 0) throw new Error('aucune URL à auditer (une par ligne, # pour commenter)');
      auditIn = { seeds, listed: true, source: a.pos.length === 1 ? a.pos[0]! : `${a.pos.length} entrées` };
    }
  }
  const httpAuth = auth === '-' ? (stdinUsed ? (() => { throw new Error('--http-auth - et une liste sur stdin s\'excluent'); })() : readList('-', '--http-auth')) : auth !== undefined ? [auth] : undefined;
  if (auth === '-' && httpAuth?.length === 0) throw new Error('--http-auth - : aucun identifiant reçu sur stdin (utilisateur:motdepasse@hôte, un par ligne)');

  // Sessions : imposée, ou éphémères (une par travailleur), toujours fermées.
  const created: string[] = [];
  const ac = new AbortController();
  const onSig = () => { if (ac.signal.aborted) return; ac.abort(); io.hint('interruption : aucune page de plus ne démarre ; sessions fermées à la fin de la page en cours'); };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    const want = cmd === 'diff' ? Math.min(concurrency, diffIn!.paths?.length ?? 1) : concurrency;
    const ids: string[] = [];
    if (session !== undefined) ids.push(session);
    else {
      const body = { ...(profile !== undefined ? { profile } : {}), ...(proxy !== undefined ? { proxyServer: proxy } : {}), ...(httpAuth !== undefined ? { httpAuth } : {}) };
      const made = await Promise.allSettled(Array.from({ length: Math.max(1, want) }, () => call(undefined, 'POST', '/sessions', body, 180_000).then((r) => (r.json() as { id: string }).id)));
      for (const m of made) if (m.status === 'fulfilled') { created.push(m.value); ids.push(m.value); }
      const failed = made.find((m): m is PromiseRejectedResult => m.status === 'rejected');
      if (ids.length === 0) throw failed?.reason instanceof Error ? failed.reason : new Error('aucune session créée');
      if (failed !== undefined) io.hint(`note: ${ids.length} session(s) sur ${want} créée(s) : ${(failed.reason as Error).message}`);
    }
    const workers: Call[] = ids.map((id) => (method, path, body, timeoutMs) => call(id, method, path, body, timeoutMs));
    if (cmd === 'diff') {
      const r = await runDiff({ ...diffIn!, max, ignore }, workers, ac.signal);
      if (ac.signal.aborted) return 130;
      io.out(a.flags.has('json') ? JSON.stringify(r) : formatDiff(r));
      return r.ok ? 0 : 1;
    }
    let urls = auditIn!.seeds;
    let notes: string[] = [];
    if (!auditIn!.listed) ({ urls, notes } = await discover(workers[0]!, urls[0]!, max));
    if (ac.signal.aborted) return 130;
    if (urls.length === 0) throw new Error(`${auditIn!.source} : aucune page à auditer${notes.length > 0 ? ` (${notes.join(' ; ')})` : ''}`);
    const r = await runAudit({ urls, source: auditIn!.source, max, maxLinks, checkLinks, ignore, notes }, workers, ac.signal);
    if (ac.signal.aborted) return 130;
    io.out(a.flags.has('json') ? JSON.stringify(r) : formatAudit(r));
    return r.ok ? 0 : 1;
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
    await Promise.allSettled(created.map((id) => call(undefined, 'DELETE', `/sessions/${encodeURIComponent(id)}`)));
  }
}
