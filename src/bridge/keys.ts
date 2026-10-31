/** Définitions minimales pour Input.dispatchKeyEvent. */
export interface KeyDef { key: string; code: string; keyCode: number; text?: string }

const NAMED: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const ALIASES: Record<string, string> = { Esc: 'Escape', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', ' ': 'Space' };
const MODS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

export interface ParsedKey { def: KeyDef; modifiers: number }

/** « Enter », « a », « Control+a », « Shift+Tab ». */
export function parseKey(spec: string): ParsedKey {
  const parts = spec === '+' ? ['+'] : spec.split('+').filter((p) => p !== '');
  let modifiers = 0;
  const main = parts.pop();
  if (main === undefined) throw new Error(`touche vide`);
  for (const m of parts) {
    const bit = MODS[m];
    if (bit === undefined) throw new Error(`modificateur inconnu « ${m} » (Alt, Control, Meta, Shift)`);
    modifiers |= bit;
  }
  const name = ALIASES[main] ?? main;
  const named = NAMED[name];
  if (named) return { def: named, modifiers };
  if ([...main].length === 1) {
    const upper = main.toUpperCase();
    const isLetter = /[a-z]/i.test(main);
    const isDigit = /[0-9]/.test(main);
    const def: KeyDef = {
      key: main,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${main}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
    };
    if ((modifiers & ~8) === 0) def.text = main; // pas de texte si Ctrl/Alt/Meta
    return { def, modifiers };
  }
  throw new Error(`touche inconnue « ${spec} » (ex. Enter, Tab, Escape, ArrowDown, a, Control+a)`);
}
