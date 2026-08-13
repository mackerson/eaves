import { describe, it, expect } from 'vitest';
import { parseMentions } from './mentions';

describe('parseMentions', () => {
  it('matches a hyphenated name (regression: \\w excluded hyphens)', () => {
    expect(parseMentions('@qa-fin-chagent can you look?', ['qa-fin-chagent']))
      .toEqual(['qa-fin-chagent']);
  });

  it('matches names with dots and spaces', () => {
    expect(parseMentions('ping @dr.bot now', ['dr.bot'])).toEqual(['dr.bot']);
    expect(parseMentions('hey @Data Analyst hello', ['Data Analyst']))
      .toEqual(['Data Analyst']);
  });

  it('is case-insensitive but returns the original casing', () => {
    expect(parseMentions('@QA-Fin-ChAgent hi', ['qa-fin-chagent']))
      .toEqual(['qa-fin-chagent']);
  });

  it('prefers the longest matching name (@Bobby over @Bob)', () => {
    expect(parseMentions('@Bobby hi', ['Bob', 'Bobby'])).toEqual(['Bobby']);
  });

  it('does not match a name embedded in a longer word', () => {
    // "@Bobbing" must not resolve to "Bob" — the trailing lookahead guards this.
    expect(parseMentions('@Bobbing around', ['Bob'])).toEqual([]);
  });

  it('resolves multiple distinct mentions, de-duped', () => {
    const out = parseMentions('@alpha and @beta and @alpha again', ['alpha', 'beta']);
    expect(out.sort()).toEqual(['alpha', 'beta']);
  });

  it('treats regex metacharacters in names literally', () => {
    expect(parseMentions('@c++ ship it', ['c++'])).toEqual(['c++']);
    // a name of "a.b" must not match "axb" (the dot is escaped)
    expect(parseMentions('@axb', ['a.b'])).toEqual([]);
  });

  it('returns nothing when there are no participants or no mentions', () => {
    expect(parseMentions('@anyone', [])).toEqual([]);
    expect(parseMentions('no mentions here', ['alpha'])).toEqual([]);
  });

  it('terminates a mention at punctuation', () => {
    expect(parseMentions('thanks @alpha!', ['alpha'])).toEqual(['alpha']);
    expect(parseMentions('@alpha, @beta.', ['alpha', 'beta']).sort())
      .toEqual(['alpha', 'beta']);
  });
});
