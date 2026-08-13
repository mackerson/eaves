import { describe, it, expect } from 'vitest';
import { ENCLAVE_GUIDE_TOPICS, guideTopicIndex, lookupGuideTopic } from './enclaveGuide';
import { TOOL_CATALOG } from '../../shared/toolCatalog';

describe('enclave guide', () => {
  it('has unique, lowercase, hyphenated topic ids', () => {
    const ids = ENCLAVE_GUIDE_TOPICS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z-]*[a-z]$/);
  });

  it('lists every topic in the index so a caller can find them all', () => {
    const index = guideTopicIndex();
    for (const topic of ENCLAVE_GUIDE_TOPICS) {
      expect(index).toContain(topic.id);
      expect(index).toContain(topic.summary);
    }
  });

  it('returns a topic body by id, case- and whitespace-insensitively', () => {
    const overview = lookupGuideTopic('overview');
    expect(overview).toBe(ENCLAVE_GUIDE_TOPICS.find(t => t.id === 'overview')!.body);
    expect(lookupGuideTopic('  OVERVIEW ')).toBe(overview);
  });

  // A wrong guess should teach the correction in one round trip rather than
  // just failing — the same contract the workflow node validator has.
  it('names the real topics when the id is unknown', () => {
    const miss = lookupGuideTopic('everything');
    expect(miss).toContain('No guide topic named "everything"');
    for (const topic of ENCLAVE_GUIDE_TOPICS) expect(miss).toContain(topic.id);
  });

  // The guide names tools by name. A renamed or removed tool would leave the
  // guide confidently pointing at something that no longer exists, which is
  // the exact failure it was written to prevent.
  it('only names tools that actually exist', () => {
    const known = new Set(TOOL_CATALOG.map(t => t.name));
    // Agent-scoped tools are assembled per turn rather than listed in the
    // catalog, so enumerate the ones the guide is allowed to mention.
    for (const name of [
      'get_my_channel_behavior', 'update_my_channel_behavior',
      'store_memory', 'retrieve_memory', 'search_memories', 'list_memories', 'delete_memory',
      'create_workflow', 'create_routine', 'list_routines',
      'list_tools', 'get_tool_info',
    ]) known.add(name);

    const bodies = ENCLAVE_GUIDE_TOPICS.map(t => t.body).join('\n');
    // Tool names appear in backticks; that's the only thing that shape marks.
    const mentioned = [...bodies.matchAll(/`([a-z][a-z0-9_]*)`/g)].map(m => m[1]);
    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of new Set(mentioned)) {
      expect(known.has(name), `guide references unknown tool \`${name}\``).toBe(true);
    }
  });
});
