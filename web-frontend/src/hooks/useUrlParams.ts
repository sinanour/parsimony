import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Reads/writes a flat set of string query parameters; setting a value to undefined or '' removes it. */
export function useUrlParams<K extends string>(defaults: Record<K, string>) {
  const [params, setParams] = useSearchParams();
  const values = useMemo(() => {
    const v = { ...defaults };
    for (const k of Object.keys(defaults) as K[]) {
      const p = params.get(k);
      if (p !== null) v[k] = p;
    }
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const update = useCallback(
    (changes: Partial<Record<K, string | undefined>>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(changes) as [K, string | undefined][]) {
            if (v === undefined || v === '' || v === defaults[k]) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setParams],
  );

  return [values, update] as const;
}
