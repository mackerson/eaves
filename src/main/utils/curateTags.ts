/**
 * Curation pass for LLM-generated chat tags. The model tags freely; this is
 * the gate between generation and what gets stored/surfaced: normalize case
 * and whitespace, drop register tags that describe the shape of a
 * conversation rather than its subject (true of every chat, so pure filter
 * noise), dedup, and cap the count.
 */

// Tags that are true of literally every conversation. Anything here is noise
// the moment it's minted — extend as new synonyms show up in the wild.
const GENERIC_TAGS = new Set([
  'conversation',
  'chat',
  'chatting',
  'discussion',
  'talk',
  'general',
  'misc',
  'miscellaneous',
  'casual',
  'greeting',
  'greetings',
  'hello',
]);

const MAX_TAG_LENGTH = 50; // matches ChatTagSchema in shared/validation.ts

export function curateTags(raw: string, maxTags = 3): string {
  const seen = new Set<string>();
  const curated: string[] = [];

  for (const part of raw.split(',')) {
    const tag = part.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!tag || tag.length > MAX_TAG_LENGTH) continue;
    if (GENERIC_TAGS.has(tag)) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    curated.push(tag);
    if (curated.length >= maxTags) break;
  }

  return curated.join(', ');
}
