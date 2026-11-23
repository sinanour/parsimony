import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../utils/format';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => void;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/** Runs `fn` whenever `deps` change; ignores responses from superseded calls. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    setError(undefined);
    fn().then(
      (d) => {
        if (id !== seq.current) return;
        setDataState(d);
        setLoading(false);
      },
      (e) => {
        if (id !== seq.current) return;
        setError(errorMessage(e));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((f: (prev: T | undefined) => T | undefined) => setDataState(f), []);
  return { data, loading, error, reload, setData };
}
