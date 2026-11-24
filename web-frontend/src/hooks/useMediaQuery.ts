import { useEffect, useState } from 'react';

/** Viewport breakpoints. "Mobile" is anything narrower than a portrait tablet. */
export const BREAKPOINTS = {
  mobile: '(max-width: 767px)',
} as const;

/** Tracks whether a CSS media query currently matches, updating as the viewport changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
