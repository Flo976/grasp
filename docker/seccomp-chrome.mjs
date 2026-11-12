#!/usr/bin/env node
// Génère docker/seccomp-chrome.json : le profil seccomp par défaut de Docker, plus UNE règle qui autorise
// clone et unshare sans condition, ce qu'exige le sandbox de Chrome (espaces de noms utilisateur, PID,
// réseau). Rien d'autre n'est ouvert : pas de mount, setns, bpf… (contrairement à --cap-add=SYS_ADMIN).
//
// Source : profil par défaut de Moby, https://github.com/moby/profiles/blob/main/seccomp/default.json
// (Apache-2.0, © Docker, Inc. et contributeurs Moby).
//
//   curl -fsSLo /tmp/default.json https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json
//   node docker/seccomp-chrome.mjs /tmp/default.json > docker/seccomp-chrome.json
import { readFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) { process.stderr.write('usage : node docker/seccomp-chrome.mjs <default.json de Moby>\n'); process.exit(2); }
const profile = JSON.parse(readFileSync(src, 'utf8'));
if (!Array.isArray(profile.syscalls)) throw new Error(`${src} : pas de tableau syscalls, ce n'est pas un profil seccomp Docker`);
profile.syscalls.push({
  names: ['clone', 'unshare'],
  action: 'SCMP_ACT_ALLOW',
  comment: 'Grasp : sandbox Chrome (espaces de noms utilisateur, PID, réseau) sans CAP_SYS_ADMIN',
});
process.stdout.write(`${JSON.stringify(profile, null, '\t')}\n`);
