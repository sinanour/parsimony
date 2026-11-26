import { useEffect, useRef } from 'react';

/** How long the overlay takes to cover the sign-in form. */
const COVER_MS = 600;
/** When the logo starts to scale up and fade out, measured from mount. */
const EXIT_AT_MS = 2900;
const EXIT_MS = 1000;

/** Brand colours, matching public/icons/parsimony-icon.svg. */
const CREAM = '#F7F5EF';
const GOLD = '#E8B64C';
/** Overlay backdrop: a darker shade of the icon's green. */
const BACKDROP = '4, 36, 26';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

interface Props {
  /** Called once the overlay hides the page underneath, so the signed-in app can mount behind it. */
  onCovered: () => void;
  /** Called when the animation has finished and the overlay can be removed. */
  onDone: () => void;
}

/**
 * Plays after a successful sign-in: the page fades to a dark green, the Parsimony logo assembles piece by piece
 * (tile, letter P, coin, the coin's slice pulling out, rising bars), then the logo scales up and fades away while
 * the backdrop clears to reveal the app.
 */
export default function SignInAnimation({ onCovered, onDone }: Props) {
  const callbacks = useRef({ onCovered, onDone });
  callbacks.current = { onCovered, onDone };

  useEffect(() => {
    const covered = setTimeout(() => callbacks.current.onCovered(), COVER_MS);
    const done = setTimeout(() => callbacks.current.onDone(), EXIT_AT_MS + EXIT_MS);
    return () => {
      clearTimeout(covered);
      clearTimeout(done);
    };
  }, []);

  // Each logo piece's start time, measured from when the overlay has covered the page.
  const at = (ms: number) => `${COVER_MS + ms}ms`;

  return (
    <div className="psi-overlay" aria-hidden="true">
      <svg className="psi-logo" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="psi-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#138A63" />
            <stop offset="1" stopColor="#0B4A37" />
          </linearGradient>
        </defs>
        <rect className="psi-tile" style={{ animationDelay: at(0) }} width="1024" height="1024" rx="224" fill="url(#psi-bg)" />
        <g transform="translate(33 0)">
          {/* Letter P: the stem grows upwards, then the bowl is drawn. */}
          <rect className="psi-grow" style={{ animationDelay: at(300) }} x="232" y="176" width="112" height="672" rx="16" fill={CREAM} />
          <path
            className="psi-draw"
            style={{ animationDelay: at(600) }}
            d="M288.0 232.0 H480 A190 190 0 0 1 480 612.0 H288.0"
            pathLength={1}
            fill="none"
            stroke={CREAM}
            strokeWidth="112"
          />
          {/* Coin: appears whole, then the 19% slice pulls out. */}
          <path className="psi-coin" style={{ animationDelay: at(1050) }} d="M480 422.0 L568.4 405.1 A90 90 0 1 1 496.9 333.6 Z" fill={GOLD} />
          <path className="psi-slice" style={{ animationDelay: at(1050) }} d="M495.6 406.4 L512.4 318.0 A90 90 0 0 1 584.0 389.6 Z" fill={GOLD} />
          {/* Rising bars. */}
          <rect className="psi-bar" style={{ animationDelay: at(1500) }} x="392" y="788" width="84" height="60" rx="14" fill={GOLD} />
          <rect className="psi-bar" style={{ animationDelay: at(1620) }} x="508" y="749" width="84" height="99" rx="14" fill={GOLD} />
          <rect className="psi-bar" style={{ animationDelay: at(1740) }} x="624" y="708.0" width="84" height="140.0" rx="14" fill={GOLD} />
        </g>
      </svg>
      <style>{`
        .psi-overlay {
          position: fixed;
          inset: 0;
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          background-color: rgba(${BACKDROP}, 0);
          animation:
            psi-cover ${COVER_MS}ms ease-out forwards,
            psi-uncover ${EXIT_MS}ms ease-in-out ${EXIT_AT_MS}ms forwards;
        }
        .psi-logo {
          width: min(256px, 50vw);
          height: min(256px, 50vw);
          overflow: visible;
          animation: psi-scale-fade ${EXIT_MS}ms ease-in-out ${EXIT_AT_MS}ms forwards;
        }
        .psi-logo * { transform-box: fill-box; }
        .psi-tile {
          opacity: 0;
          transform-origin: 50% 50%;
          animation: psi-pop 500ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        .psi-grow {
          transform-origin: 50% 100%;
          animation: psi-rise 450ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .psi-draw {
          stroke-dasharray: 1 1;
          animation: psi-draw 550ms ease-in-out both;
        }
        .psi-coin {
          transform-origin: 50% 50%;
          animation: psi-coin 400ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        /* Scales about the coin's centre (480, 422), expressed relative to the slice's own box, starting seated. */
        .psi-slice {
          transform-origin: -17.65% 117.65%;
          animation: psi-slice 750ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        .psi-bar {
          transform-origin: 50% 100%;
          animation: psi-rise 450ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
        }
        @keyframes psi-cover { to { background-color: rgba(${BACKDROP}, 1); } }
        @keyframes psi-uncover { from { background-color: rgba(${BACKDROP}, 1); } to { background-color: rgba(${BACKDROP}, 0); } }
        @keyframes psi-scale-fade { to { transform: scale(3); opacity: 0; } }
        @keyframes psi-pop { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: scale(1); } }
        @keyframes psi-rise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
        @keyframes psi-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
        @keyframes psi-coin { from { transform: scale(0); } to { transform: scale(1); } }
        @keyframes psi-slice {
          0% { transform: scale(0) translate(-15.6px, 15.6px); }
          45% { transform: scale(1) translate(-15.6px, 15.6px); }
          100% { transform: scale(1) translate(0, 0); }
        }
      `}</style>
    </div>
  );
}
