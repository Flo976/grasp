/**
 * playwright-core est une devDependency facultative : sans lui, les tests du moteur Playwright sont sautés.
 * Nom du module dans une variable : la compilation ne dépend pas de sa présence.
 */
const MODULE: string = 'playwright-core';
export const hasPlaywright: boolean = await import(MODULE).then(() => true, () => false);
export const needPlaywright: string | false = hasPlaywright ? false : 'playwright-core absent (npm i -D playwright-core)';
