Essais : 5 par moteur (lancement à froid à chaque essai). Médianes.

| Mesure | Chrome headless | Lightpanda | Rapport |
|---|---|---|---|
| Lancement (processus → CDP prêt), ms | 126 | 29 | ×4.3 |
| Démarrage à froid (→ onglet Grasp prêt), ms | 135 | 36 | ×3.8 |
| RSS groupe au repos, Mo | 849 | 20 | ×43.0 |
| PSS groupe au repos, Mo | 318 | 9 | ×35.6 |
| RSS groupe après 7 pages, Mo | 1714 | 65 | ×26.5 |
| PSS groupe après 7 pages, Mo | 591 | 53 | ×11.1 |
| Processus dans le groupe | 17 | 1 | |

| Page | nav Chrome ms | nav LP ms | snap Chrome ms | snap LP ms | octets snap Chrome | octets snap LP | lignes C / LP | erreurs |
|---|---|---|---|---|---|---|---|---|
| http://local/ | 541 | 474 | 3.6 | 2.1 | 436 | 431 | 16 / 16 |  |
| http://local/big | 518 | 478 | 178.7 | 30.3 | 68890 | 68890 | 2002 / 2002 |  |
| http://local/snap-v3 | 487 | 475 | 6.3 | 2.5 | 1530 | 1559 | 47 / 48 |  |
| https://example.com/ | 695 | 714 | 3.6 | 1.2 | 891 | 891 | 8 / 8 |  |
| https://info.cern.ch/hypertext/WWW/TheProject.html | 1166 | 1200 | 4.6 | 1.9 | 1765 | 1736 | 64 / 51 |  |
| https://news.ycombinator.com/ | 2218 | 1905 | 27.1 | 6.4 | 13107 | 6791 | 310 / 205 |  |
| https://fr.wikipedia.org/wiki/Antananarivo | 3054 | 3308 | 241.2 | 67.0 | 94657 | 120012 | 3112 / 4060 |  |


## Avec --load-resources stylesheet

Essais : 3 par moteur (lancement à froid à chaque essai). Médianes. Options Lightpanda : --load-resources stylesheet ; stableTimeoutMs : défaut (5000).

| Mesure | Chrome headless | Lightpanda | Rapport |
|---|---|---|---|
| Lancement (processus → CDP prêt), ms | 124 | 30 | ×4.1 |
| Démarrage à froid (→ onglet Grasp prêt), ms | 135 | 36 | ×3.7 |
| RSS groupe au repos, Mo | 849 | 20 | ×43.0 |
| PSS groupe au repos, Mo | 318 | 9 | ×35.5 |
| RSS groupe après 7 pages, Mo | 1716 | 65 | ×26.3 |
| PSS groupe après 7 pages, Mo | 590 | 54 | ×11.0 |
| Processus dans le groupe | 17 | 1 | |

| Page | nav Chrome ms | nav LP ms | snap Chrome ms | snap LP ms | octets snap Chrome | octets snap LP | lignes C / LP | erreurs |
|---|---|---|---|---|---|---|---|---|
| http://local/ | 536 | 465 | 3.8 | 2.0 | 436 | 431 | 16 / 16 |  |
| http://local/big | 509 | 479 | 176.8 | 35.6 | 68890 | 68890 | 2002 / 2002 |  |
| http://local/snap-v3 | 491 | 476 | 6.5 | 2.9 | 1530 | 1559 | 47 / 48 |  |
| https://example.com/ | 686 | 695 | 3.6 | 1.4 | 891 | 891 | 8 / 8 |  |
| https://info.cern.ch/hypertext/WWW/TheProject.html | 1155 | 1203 | 4.6 | 2.1 | 1765 | 1736 | 64 / 51 |  |
| https://news.ycombinator.com/ | 2218 | 1926 | 26.3 | 7.5 | 13107 | 6791 | 310 / 205 |  |
| https://fr.wikipedia.org/wiki/Antananarivo | 2980 | 3510 | 245.2 | 56.4 | 94657 | 91334 | 3112 / 2930 |  |


## Sans attente de stabilité (BANC_STABLE_MS=0), avec stylesheet

Essais : 5 par moteur (lancement à froid à chaque essai). Médianes. Options Lightpanda : --load-resources stylesheet ; stableTimeoutMs : 0.

| Mesure | Chrome headless | Lightpanda | Rapport |
|---|---|---|---|
| Lancement (processus → CDP prêt), ms | 125 | 29 | ×4.2 |
| Démarrage à froid (→ onglet Grasp prêt), ms | 135 | 36 | ×3.8 |
| RSS groupe au repos, Mo | 850 | 20 | ×43.1 |
| PSS groupe au repos, Mo | 319 | 9 | ×35.6 |
| RSS groupe après 7 pages, Mo | 1709 | 65 | ×26.3 |
| PSS groupe après 7 pages, Mo | 586 | 54 | ×10.9 |
| Processus dans le groupe | 17 | 1 | |

| Page | nav Chrome ms | nav LP ms | snap Chrome ms | snap LP ms | octets snap Chrome | octets snap LP | lignes C / LP | erreurs |
|---|---|---|---|---|---|---|---|---|
| http://local/ | 138 | 64 | 4.0 | 2.2 | 436 | 431 | 16 / 16 |  |
| http://local/big | 92 | 67 | 169.8 | 30.8 | 68890 | 68890 | 2002 / 2002 |  |
| http://local/snap-v3 | 75 | 66 | 6.4 | 2.8 | 1530 | 1559 | 47 / 48 |  |
| https://example.com/ | 275 | 304 | 4.0 | 1.3 | 891 | 891 | 8 / 8 |  |
| https://info.cern.ch/hypertext/WWW/TheProject.html | 787 | 759 | 4.8 | 1.9 | 1765 | 1736 | 64 / 51 |  |
| https://news.ycombinator.com/ | 1854 | 1486 | 26.3 | 6.6 | 13105 | 6791 | 310 / 205 |  |
| https://fr.wikipedia.org/wiki/Antananarivo | 2564 | 2283 | 243.0 | 51.3 | 94657 | 91334 | 3112 / 2930 |  |


## 10 sessions en parallèle

K = 10 sessions simultanées (un navigateur par session, comme un bridge Grasp), chacune sur http://127.0.0.1:…/big ; 3 essais, médianes.

| Mesure | Chrome headless | Lightpanda | Rapport |
|---|---|---|---|
| Temps mur : 10 lancements + nav + snapshot, ms | 2163 | 897 | ×2.4 |
| RSS totale, Mo | 10519 | 271 | ×38.9 |
| PSS totale, Mo | 1966 | 81 | ×24.3 |
| PSS par session, Mo | 197 | 8 | |
