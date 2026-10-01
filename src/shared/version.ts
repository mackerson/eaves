/**
 * Semver-ish compare of dotted versions, shared between the marketplace
 * install gate (main) and the marketplace UI's update-available check
 * (renderer) so the two can never disagree about what "newer" means.
 * a<b -> -1, a==b -> 0, a>b -> 1.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
