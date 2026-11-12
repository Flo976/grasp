import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Deux variantes d'un même petit site, pour la recette multi-pages (`grasp diff`, `grasp audit`) : « a » (la
 * référence, prod) et « b » (la préprod, avec ses régressions). Chaque instance écoute sur son propre port :
 * deux origines distinctes, comme deux environnements. Aucun site externe.
 */
export interface MultiSite { url: string; server: Server; hits: Array<{ method: string; path: string }>; close(): Promise<void> }

const page = (title: string, body: string, head = '') => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>
<header><nav aria-label="Principale"><a href="/">Accueil</a> <a href="/produits">Produits</a> <a href="/contact">Contact</a> <a href="/logout">Se déconnecter</a></nav></header>
<main>${body}</main>
<footer><p>Pied de page</p></footer>
</body></html>`;

export async function startMultiSite(variant: 'a' | 'b'): Promise<MultiSite> {
  const hits: Array<{ method: string; path: string }> = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const origin = `http://${req.headers.host ?? ''}`;
    hits.push({ method: req.method ?? 'GET', path: u.pathname });
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const html = (s: string, status = 200) => { res.statusCode = status; res.end(req.method === 'HEAD' ? undefined : s); };
    switch (u.pathname) {
      case '/':
        return html(page('Accueil', `<h1>Accueil</h1><p>Bienvenue sur la boutique.</p>
<ul><li><a href="/mort">Page disparue</a></li><li><a href="/redirige">Ancienne adresse</a></li><li><a href="/api/methode">Méthode</a></li>
<li><a href="/inscription">Inscription</a></li><li><a href="/contact#formulaire">Formulaire</a></li><li><a href="http://example.com/">Externe</a></li></ul>`));
      case '/produits':
        return variant === 'a'
          ? html(page('Produits', '<h1>Produits</h1><section aria-label="Offres"><h2>Promotions</h2><p>Vélo de ville</p><p>Prix : 12 €</p></section>'))
          : html(page('Produits', `<h1>Produits</h1><section aria-label="Offres"><h2>Soldes</h2><p>Vélo de ville</p><p>Prix : 14 €</p></section>
<img src="/absent.png" alt="photo"><script>console.error('panier introuvable');</script>`));
      case '/contact':
        // L'origine figure dans la page : identique après neutralisation ({origine}).
        return html(page('Contact', `<h1>Contact</h1><p>Écrivez-nous : ${origin}/contact</p><p id="maj">Mis à jour ${variant === 'a' ? 'le 3 mars' : 'le 9 avril'}</p>`));
      case '/statut':
        return html(page('Statut', '<h1>Statut</h1><p>Service</p>'), variant === 'a' ? 200 : 500);
      case '/inscription':
        return html(page('Inscription', `<h1>Inscription</h1><form><label for="mail">Courriel</label>
<input id="mail" aria-invalid="true" aria-describedby="err-mail" value="ada@"><p id="err-mail">Adresse incomplète</p><button>Valider</button></form>`));
      case '/absente': return html(page('Introuvable', '<h1>Page introuvable</h1>'), 404);
      case '/mort': return html('introuvable', 404);
      case '/redirige': res.statusCode = 301; res.setHeader('location', '/contact'); res.end(); return;
      case '/api/methode':
        if (req.method === 'HEAD') { res.statusCode = 405; res.setHeader('allow', 'GET'); res.end(); return; }
        return html(page('Méthode', '<h1>Méthode</h1>'));
      case '/logout': return html(page('Déconnecté', '<h1>Au revoir</h1>'));
      case '/hors-allowlist': return html(page('Hors', '<h1>Hors</h1>'));
      case '/absent.png': res.statusCode = 404; res.end(); return;
      case '/sitemap.xml':
        res.setHeader('content-type', 'application/xml');
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${['/', '/produits', '/contact', '/inscription', '/absente'].map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n')}
</urlset>`);
        return;
      case '/sitemap-index.xml':
        res.setHeader('content-type', 'application/xml');
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap.xml</loc></sitemap></sitemapindex>`);
        return;
      default: return html(page('Inconnue', '<h1>Inconnue</h1>'), 404);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    hits,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
