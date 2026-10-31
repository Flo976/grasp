// Site de test local (le même que la suite de tests). Affiche son URL sur stdout.
import { startTestSite } from '../dist/test/helpers/testsite.js';
const site = await startTestSite();
process.stdout.write(`${site.url}\n`);
process.on('SIGTERM', () => site.close().then(() => process.exit(0)));
