// DOM-free HTML escaping, shared by the web views and the build scripts (Node type stripping).

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

// Shortened on a word boundary with a visible mark, so a quote never ends mid-word as if that were the whole message.
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length).trimEnd()}…`;
}

// Three significant digits at most: a filtered count is an estimate, and "733,319,207" would claim otherwise.
const threeDigits = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
export const roundCount = (n: number): string => (n < 1000 ? String(Math.round(n)) : threeDigits.format(n));
export const rangeText = (low: number, high: number): string => {
  const [a, b] = [roundCount(low), roundCount(high)];
  return a === b ? a : `${a}–${b}`;
};
