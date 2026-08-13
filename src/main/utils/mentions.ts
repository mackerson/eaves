/**
 * Return the display names @mentioned in `content`, matched against `names`
 * (case-insensitive; returns the original casing from `names`).
 *
 * Matches against the actual names rather than a generic `\w` class — names
 * legitimately contain hyphens, dots, spaces, etc., none of which `\w` covers,
 * so `@qa-fin-chagent` would otherwise never match. Longest-first so a longer
 * name wins over a shorter one it contains (`@Bobby` before `@Bob`), and the
 * trailing lookahead keeps `@Bob` from matching inside `@Bobbing`.
 */
export function parseMentions(content: string, names: string[]): string[] {
  if (names.length === 0) return [];
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  const regex = new RegExp(`@(${pattern})(?=[\\s,.:!?]|$)`, 'gi');
  const byLower = new Map(names.map(n => [n.toLowerCase(), n]));
  const out = new Set<string>();
  for (const match of content.matchAll(regex)) {
    const hit = byLower.get(match[1].trim().toLowerCase());
    if (hit) out.add(hit);
  }
  return [...out];
}
