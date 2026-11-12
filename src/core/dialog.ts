/**
 * Dialogues JavaScript (alert, confirm, prompt, beforeunload) : réponse donnée par Grasp et rapport.
 *
 * Un dialogue bloque tout l'onglet : Grasp y répond TOUJOURS aussitôt. Défaut (sûr, inchangé) : alert fermé,
 * beforeunload accepté (la navigation demandée a lieu), confirm et prompt REFUSÉS. L'option par action
 * `--dialog accept|dismiss|<texte>` change la réponse des dialogues ouverts PENDANT cette action seulement.
 */

import { GraspError } from './errors.js';

/** Réponse demandée pour les dialogues d'une action ; undefined = défaut sûr. */
export type DialogPolicy = { kind: 'accept' } | { kind: 'dismiss' } | { kind: 'text'; text: string };

/** Dialogue vu par Grasp, tel que rapporté dans la sortie de l'action. */
export interface DialogSeen {
  type: string;
  /** Message affiché par la page, borné (DIALOG_MESSAGE_MAX caractères) et sur une ligne. */
  message: string;
  accepted: boolean;
  /** Texte saisi dans un prompt accepté. */
  promptText?: string;
  /** Réponse par défaut (aucune option --dialog) plutôt que demandée. */
  byDefault?: true;
  /** Ouvert hors de toute action (minuterie après la fin d'une action, pendant une lecture) : rapporté à l'action suivante. */
  outside?: true;
}

export const DIALOG_MESSAGE_MAX = 200;
export const DIALOG_TEXT_MAX = 4096;
/** Dialogues rapportés au plus par action (au-delà : comptés). */
export const DIALOGS_REPORTED_MAX = 10;

/**
 * Valeur de --dialog → politique. `accept`, `dismiss` ; tout autre texte = réponse d'un prompt (accepté avec ce
 * texte) ; `text:accept` pour répondre littéralement « accept » à un prompt.
 */
export function parseDialogOption(v: string | undefined): DialogPolicy | undefined {
  if (v === undefined) return undefined;
  if (v === 'accept') return { kind: 'accept' };
  if (v === 'dismiss') return { kind: 'dismiss' };
  const text = v.startsWith('text:') ? v.slice(5) : v;
  if (text.length > DIALOG_TEXT_MAX) throw new GraspError(400, `--dialog : texte de ${text.length} caractères (${DIALOG_TEXT_MAX} au plus)`);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new GraspError(400, '--dialog : caractère de contrôle refusé dans le texte');
  return { kind: 'text', text };
}

/** Paramètres de Page.handleJavaScriptDialog pour ce dialogue, et ce qui en sera rapporté. */
export function decideDialog(type: string, message: string, defaultPrompt: string, policy: DialogPolicy | undefined): { params: { accept: boolean; promptText?: string }; seen: DialogSeen } {
  const msg = oneLine(message, DIALOG_MESSAGE_MAX);
  let accept: boolean;
  let promptText: string | undefined;
  if (policy === undefined) accept = type === 'alert' || type === 'beforeunload';
  else if (type === 'alert') accept = true; // un seul bouton : fermé, quelle que soit l'option
  else if (policy.kind === 'dismiss') accept = false;
  else {
    accept = true;
    if (type === 'prompt') promptText = policy.kind === 'text' ? policy.text : defaultPrompt;
  }
  const seen: DialogSeen = { type, message: msg, accepted: accept };
  if (promptText !== undefined) seen.promptText = promptText;
  if (policy === undefined) seen.byDefault = true;
  return { params: promptText !== undefined ? { accept, promptText } : { accept }, seen };
}

/** Une ligne de rapport : « dialogue confirm « Supprimer ? » → accepté ». */
export function dialogLine(d: DialogSeen): string {
  let r: string;
  if (d.type === 'alert') r = 'fermé';
  else if (!d.accepted) r = d.type === 'beforeunload' ? 'refusé (la page reste affichée, navigation annulée)' : 'refusé';
  else r = d.promptText !== undefined ? `accepté avec « ${oneLine(d.promptText, DIALOG_MESSAGE_MAX)} »` : d.type === 'beforeunload' ? 'accepté (la page est quittée)' : 'accepté';
  // Refus par défaut d'un confirm/prompt : dire comment l'accepter (l'agent ne le devinerait pas).
  const hint = d.byDefault === true && !d.accepted ? ` (défaut sûr — --dialog accept${d.type === 'prompt' ? ' ou --dialog "texte"' : ''} pour répondre)` : '';
  // beforeunload : Chrome ne transmet plus le message de la page (vide) — pas de « » vides.
  return `dialogue ${d.type}${d.message !== '' ? ` « ${d.message} »` : ''} → ${r}${hint}${d.outside === true ? " [ouvert hors action, avant celle-ci]" : ''}`;
}

/** Lignes de rapport, bornées ; `omitted` : dialogues au-delà de DIALOGS_REPORTED_MAX. */
export function dialogLines(list: readonly DialogSeen[], omitted: number): string[] {
  const lines = list.map(dialogLine);
  if (omitted > 0) lines.push(`… ${omitted} autre(s) dialogue(s) non détaillé(s)`);
  return lines;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
