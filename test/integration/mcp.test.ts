import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { makeTestEnv } from '../helpers/env.js';
import { CLI, startServer, waitExit } from '../helpers/server.js';
import { startTestSite } from '../helpers/testsite.js';
import { isAlive, waitUntil } from '../helpers/procs.js';
import { resolvePaths } from '../../src/core/paths.js';

/** `grasp mcp` en sous-processus, dialogue JSON-RPC 2.0 ligne à ligne sur stdio. */
class Mcp {
  readonly proc: ChildProcessWithoutNullStreams;
  /** Chaque ligne de stdout : le protocole n'en tolère pas d'autre. */
  readonly lines: string[] = [];
  stderr = '';
  private nextId = 1;
  private readonly waiting = new Map<number | string | null, (m: any) => void>();
  readonly unsolicited: any[] = [];

  constructor(env: NodeJS.ProcessEnv, args: string[] = []) {
    this.proc = spawn(process.execPath, [CLI, 'mcp', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.lines.push(line);
        const m = JSON.parse(line); // une ligne non JSON fait échouer le test : stdout pollué
        const key = Array.isArray(m) ? 'lot' : m.id;
        const w = this.waiting.get(key);
        if (w) { this.waiting.delete(key); w(m); } else this.unsolicited.push(m);
      }
    });
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString(); });
  }

  raw(line: string, key: number | string | null): Promise<any> {
    const p = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`pas de réponse à ${line}\n${this.stderr}`)), 120_000);
      this.waiting.set(key, (m) => { clearTimeout(t); resolve(m); });
    });
    this.proc.stdin.write(`${line}\n`);
    return p;
  }

  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    return this.raw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }), id);
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })}\n`);
  }

  async init(): Promise<any> {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    this.notify('notifications/initialized');
    return r;
  }

  /** tools/call → résultat MCP ; text = contenus texte concaténés. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; content: any[] }> {
    const r = await this.request('tools/call', { name, arguments: args });
    assert.equal(r.error, undefined, `erreur JSON-RPC sur ${name} : ${JSON.stringify(r.error)}`);
    const content = r.result.content as any[];
    return { text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: r.result.isError === true, content };
  }

  async close(): Promise<number | null> {
    this.proc.stdin.end();
    return waitExit(this.proc, 40_000);
  }
}

const refOf = (snap: string, re: RegExp): string => {
  const line = snap.split('\n').find((l) => re.test(l));
  assert.ok(line, `aucune ligne ${re} dans :\n${snap}`);
  return /(e[0-9a-z]+):/.exec(line)![1]!;
};

test('mcp : protocole (initialize, ping, tools/list, erreurs JSON-RPC), serveur démarré puis arrêté avec lui', async () => {
  const t = makeTestEnv();
  const paths = resolvePaths(t.env, t.env.HOME);
  const mcp = new Mcp(t.env);
  try {
    const init = await mcp.init();
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'grasp');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    // Version inconnue : le serveur propose la sienne.
    const old = await mcp.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(old.result.protocolVersion, '2025-06-18');
    assert.deepEqual((await mcp.request('ping')).result, {});

    const tools = (await mcp.request('tools/list')).result.tools as Array<{ name: string; inputSchema: any }>;
    assert.deepEqual(tools.map((x) => x.name), ['nav', 'back', 'forward', 'reload', 'scroll', 'snap', 'find', 'text', 'click', 'fill', 'secrets', 'type', 'select', 'check', 'press', 'hover', 'wait', 'console', 'screenshot', 'run', 'profile']);
    for (const x of tools) assert.equal(x.inputSchema.type, 'object');
    assert.deepEqual(tools.find((x) => x.name === 'fill')!.inputSchema.required, ['target', 'value']);
    assert.ok(tools.find((x) => x.name === 'click')!.inputSchema.properties.snapDiff);
    assert.ok(tools.find((x) => x.name === 'snap')!.inputSchema.properties.nameMax);

    assert.equal((await mcp.request('frobnicate')).error.code, -32601);
    assert.equal((await mcp.raw('{pas du json', null)).error.code, -32700);
    assert.equal((await mcp.request('tools/call', { name: 'inconnu', arguments: {} })).error.code, -32602);
    // Lot JSON-RPC : une réponse par requête, aucune pour la notification.
    const batch = await mcp.raw(JSON.stringify([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]), 'lot');
    assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 'a', result: {} }]);

    // Argument inconnu ou mal typé : refusé (isError), jamais ignoré ; aucun navigateur lancé pour ça.
    const bad = await mcp.call('click', { target: '#x', snapdiff: true });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /argument inconnu « snapdiff »/);
    assert.match((await mcp.call('snap', { max: 'beaucoup' })).text, /« max » : entier/);
    assert.match((await mcp.call('fill', { target: '#x' })).text, /argument « value » requis/);
    assert.equal(existsSync(paths.pidFile), false, 'aucun serveur démarré par une validation');

    // Premier vrai appel : `grasp serve` démarré (stdout → stderr), session créée.
    const nav = await mcp.call('nav', { url: 'http://example.com/' });
    assert.equal(nav.isError, true, 'hors allowlist : 403, rien chargé');
    assert.match(nav.text, /^ERROR: /);
    assert.match(mcp.stderr, /démarrage de `grasp serve`/);
    assert.match(mcp.stderr, /session s[0-9a-f]{12} créée/);
    const pid = Number(readFileSync(paths.pidFile, 'utf8'));
    assert.ok(isAlive(pid));

    assert.equal(await mcp.close(), 0);
    assert.ok(await waitUntil(() => !isAlive(pid), 20_000), 'le serveur lancé par grasp mcp s\'arrête avec lui');
    assert.match(mcp.stderr, /session s[0-9a-f]{12} fermée/);
    // Tout stdout est du protocole (chaque ligne a été analysée comme JSON par le lecteur).
    assert.ok(mcp.lines.every((l) => JSON.parse(l).jsonrpc === '2.0' || Array.isArray(JSON.parse(l))));
    assert.equal(mcp.unsolicited.length, 0);
  } finally {
    mcp.proc.kill('SIGKILL');
    t.cleanup();
  }
});

test('mcp : formulaire de bout en bout (snap, fill par ref, select, check, click snapDiff, text, wait, console, screenshot, erreurs avec candidats)', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const srv = await startServer(t.env);
  const mcp = new Mcp(t.env);
  try {
    await mcp.init();
    assert.equal((await mcp.call('nav', { url: `${site.url}/` })).text, 'OK');
    const snap = (await mcp.call('snap')).text;
    assert.match(snap, /heading\[1\] "Inscription"/);
    const nom = refOf(snap, /textbox "Nom"/);
    // Lecture progressive : mêmes refs que le snapshot complet.
    assert.match((await mcp.call('snap', { mode: 'outline' })).text, /heading\[1\] "Inscription"[\s\S]*… lecture partielle \(--outline\)/);
    assert.ok((await mcp.call('snap', { mode: 'interactive' })).text.includes(`${nom}:textbox "Nom"`));
    const found = await mcp.call('find', { pattern: 'madagascar', role: 'option' });
    assert.match(found.text, /find « madagascar » --role option : 1 correspondance\ne[0-9a-z]+:option "Madagascar" \(dans e[0-9a-z]+:combobox "Pays"\)/);
    assert.match((await mcp.call('find', { pattern: '/(/' })).text, /^ERROR: .*expression régulière invalide/);
    assert.equal((await mcp.call('snap', { mode: 'tout' })).isError, true);

    assert.equal((await mcp.call('fill', { target: nom, value: 'Ada Lovelace' })).text, 'OK');
    assert.equal((await mcp.call('fill', { target: '#email', value: 'ada@example.org' })).text, 'OK');
    assert.equal((await mcp.call('type', { target: 'text:Ville', text: 'Antananarivo' })).text, 'OK');
    const sel = await mcp.call('select', { target: 'text:Pays', value: 'Madagascar' });
    assert.equal(sel.isError, false, sel.text);
    const chk = await mcp.call('check', { target: "text:J'accepte les conditions", snapDiff: true });
    assert.match(chk.text, /~ e[0-9a-z]+:checkbox "J'accepte les conditions" \[x\]/);
    const off = await mcp.call('check', { target: '#cgu', checked: false, snapDiff: true });
    assert.match(off.text, /checkbox "J'accepte les conditions" \[ \]/);
    await mcp.call('check', { target: '#cgu' });

    // Erreur Grasp → isError avec le message du serveur, noms proches (refs candidates) compris.
    const typo = await mcp.call('click', { target: 'text:Valder' });
    assert.equal(typo.isError, true);
    assert.match(typo.text, /^ERROR: .*Valder.*e[0-9a-z]+ button "Valider"/s);

    const click = await mcp.call('click', { target: 'text:Valider', snapDiff: true });
    assert.equal(click.isError, false, click.text);
    assert.match(click.text, /navigation → .*\/submit\?nom=Ada\+Lovelace/);
    assert.match(click.text, /heading\[1\] "Inscription reçue"/);
    const txt = (await mcp.call('text')).text;
    assert.match(txt, /Nom : Ada Lovelace/);
    assert.match(txt, /Ville : Antananarivo/);
    assert.match(txt, /Pays : mg/);
    assert.match(txt, /CGU : oui/);
    assert.match((await mcp.call('text', { markdown: true })).text, /^# Inscription reçue$/m, 'markdown=true : titre en Markdown');
    assert.match((await mcp.call('wait', { text: 'Inscription reçue', timeout: 5000 })).text, /^OK \(attendu \d+ ms/);
    const late = await mcp.call('wait', { text: 'jamais là', timeout: 300 });
    assert.equal(late.isError, true);

    // Console : action avec console=true, puis lecture.
    await mcp.call('nav', { url: `${site.url}/console` });
    const logged = await mcp.call('click', { target: '#log', console: true });
    assert.match(logged.text, /^OK\n#\d+ info +console clic 42/);
    assert.match(logged.text, /console : seq courant \d+/);
    const cons = await mcp.call('console', { level: 'error' });
    assert.match(cons.text, /error network GET .*\/absent\.png → 404/);
    assert.match(cons.text, /seq courant : \d+ — suite : since=\d+/);

    // Capture : le chemin (fichier 0600), l'image seulement sur demande.
    const shot = await mcp.call('screenshot', { maxWidth: 400 });
    const path = shot.text.split('\n')[0]!;
    assert.ok(existsSync(path), shot.text);
    assert.equal(shot.content.length, 1);
    const img = await mcp.call('screenshot', { format: 'jpeg', quality: 50, image: true });
    const im = img.content.find((c) => c.type === 'image');
    assert.equal(im.mimeType, 'image/jpeg');
    assert.equal(Buffer.from(im.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');

    // snap borné et noms entiers : transmis tels quels au serveur.
    assert.match((await mcp.call('snap', { max: 60 })).text, /… tronqué/);
    assert.match((await mcp.call('snap', { scope: '#log', nameMax: 0 })).text, /button "Loguer"/);

    // Session réutilisée par la CLI : c'est la même que celle du serveur (une seule ouverte).
    const sessions = (await srv.api('GET', '/sessions')).json() as Array<{ id: string }>;
    assert.equal(sessions.length, 1);
    assert.equal(await mcp.close(), 0);
    assert.equal(((await srv.api('GET', '/sessions')).json() as unknown[]).length, 0, 'la session créée par grasp mcp est fermée à sa sortie');
    assert.ok(isAlive(srv.proc.pid!), 'un serveur que grasp mcp n\'a pas lancé reste en place');
  } finally {
    mcp.proc.kill('SIGKILL');
    srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup();
  }
});

test('mcp : run (script grasp run), session imposée réutilisée et jamais fermée, profile', async () => {
  const t = makeTestEnv();
  const site = await startTestSite();
  const srv = await startServer(t.env);
  try {
    const id = ((await srv.api('POST', '/sessions', {})).json() as { id: string }).id;
    const mcp = new Mcp({ ...t.env, GRASP_SESSION: id }, ['--no-serve']);
    try {
      await mcp.init();
      const run = await mcp.call('run', { script: `nav ${site.url}/\nfill #nom "Grace Hopper"\ncheck #cgu\nclick text:Valider --snap-diff\ntext --scope #r-nom` });
      assert.equal(run.isError, false, run.text);
      assert.match(run.text, /\[1\] nav .* → OK/);
      assert.match(run.text, /\[5\] text --scope #r-nom → OK\nNom : Grace Hopper/);
      assert.match(run.text, /5 commande\(s\), 5 OK/);
      const failed = await mcp.call('run', { script: 'click #absent\ntext' });
      assert.equal(failed.isError, true);
      assert.match(failed.text, /\[1\] click #absent → ERROR: aucun élément ne correspond à #absent/);
      assert.match(failed.text, /1 non exécutée/);
      const invalid = await mcp.call('run', { script: 'click e3 --snapdiff' });
      assert.equal(invalid.isError, true);
      assert.match(invalid.text, /option --snapdiff inconnue/);
      // Recette : expect dans run, rapport joint d'office ; un expect qui échoue → isError avec « attendu … ; constaté ».
      const ok = await mcp.call('run', { script: `nav ${site.url}/\nexpect text "Inscription"\nexpect no-form-errors` });
      assert.equal(ok.isError, false, ok.text);
      assert.match(ok.text, /== recette : OK/);
      const ko = await mcp.call('run', { script: `nav ${site.url}/\nexpect text "Texte absent" --timeout 0` });
      assert.equal(ko.isError, true);
      assert.match(ko.text, /attendu texte « Texte absent »/);
      assert.match(ko.text, /== recette : ÉCHEC/);
      assert.doesNotMatch((await mcp.call('run', { script: `expect url ~ ${site.url}`, report: false })).text, /== recette/);

      assert.match((await mcp.call('profile')).text, /aucun profil/);
      await srv.api('POST', '/profiles', { name: 'travail' });
      assert.match((await mcp.call('profile')).text, /travail/);
      assert.match((await mcp.call('profile', { name: 'travail' })).text, /^OK — profil \(éphémère\) → travail/);
      assert.match((await mcp.call('profile')).text, /^\* travail/m);
      assert.match(mcp.stderr, new RegExp(`session ${id}`));
      assert.equal(await mcp.close(), 0);
    } finally { mcp.proc.kill('SIGKILL'); }
    const left = (await srv.api('GET', '/sessions')).json() as Array<{ id: string }>;
    assert.deepEqual(left.map((s) => s.id), [id], 'une session imposée n\'est jamais fermée par grasp mcp');
  } finally { srv.proc.kill('SIGTERM'); await waitExit(srv.proc); await site.close(); t.cleanup(); }
});

test('mcp --no-serve : serveur absent → isError explicite, rien de lancé', async () => {
  const t = makeTestEnv();
  const mcp = new Mcp(t.env, ['--no-serve']);
  try {
    await mcp.init();
    const r = await mcp.call('snap');
    assert.equal(r.isError, true);
    assert.match(r.text, /serveur Grasp injoignable/);
    assert.equal(existsSync(resolvePaths(t.env, t.env.HOME).pidFile), false);
    assert.equal(await mcp.close(), 0);
  } finally { mcp.proc.kill('SIGKILL'); t.cleanup(); }
});
