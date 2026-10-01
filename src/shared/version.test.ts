import { describe, it, expect } from 'vitest';
import { compareVersions } from './version';

describe('compareVersions', () => {
  it('orders plain semver triples', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1', '1.0.1')).toBe(-1);
    expect(compareVersions('2', '1.9.9')).toBe(1);
  });
});
