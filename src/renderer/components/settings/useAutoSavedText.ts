import { useEffect, useState } from 'react';
import { useToastStore } from '@/stores';

/**
 * Locally-editable text mirror of a persisted string. Call `commit` (typically
 * from an onBlur handler) to push the change through `save`; no-op if the
 * value is unchanged. External updates to `persisted` sync down automatically.
 *
 * Errors from `save` surface as a toast — success is silent (System
 * Preferences style).
 */
export function useAutoSavedText(
  persisted: string | undefined,
  save: (value: string) => Promise<unknown>,
) {
  const [local, setLocal] = useState(persisted ?? '');
  const showToast = useToastStore((s) => s.showToast);

  useEffect(() => {
    setLocal(persisted ?? '');
  }, [persisted]);

  const commit = () => {
    const next = local;
    if (next === (persisted ?? '')) return;
    save(next).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Save failed';
      showToast(`Failed to save: ${message}`, 'error');
    });
  };

  return { local, setLocal, commit };
}
