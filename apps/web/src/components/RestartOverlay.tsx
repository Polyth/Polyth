export default function RestartOverlay() {
  return (
    <div className="opencode-restart-overlay" role="status" aria-live="assertive" aria-label="Restarting OpenCode">
      <div className="opencode-restart-mark" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
          <defs>
            <linearGradient id="restart-blue" x1="80" y1="48" x2="432" y2="464" gradientUnits="userSpaceOnUse">
              <stop stopColor="#67D5FF" />
              <stop offset="1" stopColor="#3578FF" />
            </linearGradient>
            <linearGradient id="restart-orange" x1="72" y1="448" x2="440" y2="64" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FFCA67" />
              <stop offset="1" stopColor="#FF714D" />
            </linearGradient>
            <linearGradient id="restart-purple" x1="56" y1="72" x2="456" y2="440" gradientUnits="userSpaceOnUse">
              <stop stopColor="#D889FF" />
              <stop offset="1" stopColor="#7657FF" />
            </linearGradient>
            <linearGradient id="restart-mint" x1="72" y1="440" x2="448" y2="64" gradientUnits="userSpaceOnUse">
              <stop stopColor="#69F2C4" />
              <stop offset="1" stopColor="#27BFA9" />
            </linearGradient>
            <filter id="restart-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="12" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <style>{`
            .restart-state { opacity: 0; animation: restart-state 8s ease-in-out infinite; }
            .restart-state:nth-of-type(2) { animation-delay: 2s; }
            .restart-state:nth-of-type(3) { animation-delay: 4s; }
            .restart-state:nth-of-type(4) { animation-delay: 6s; }
            .restart-p { transform-origin: 256px 256px; animation: restart-breathe 2s ease-in-out infinite; }
            @keyframes restart-state {
              0%, 24% { opacity: 1; }
              30%, 94% { opacity: 0; }
              100% { opacity: 1; }
            }
            @keyframes restart-breathe {
              0%, 100% { transform: scale(.94) rotate(-2deg); }
              50% { transform: scale(1.04) rotate(2deg); }
            }
          `}</style>
          <g className="restart-p" filter="url(#restart-glow)">
            <path className="restart-state" fill="url(#restart-blue)" fillRule="evenodd" d="M128 64h128c85 0 144 50 144 128s-59 128-144 128h-48v128h-80V64zm80 72v112h44c42 0 68-20 68-56s-26-56-68-56h-44z" />
            <path className="restart-state" fill="url(#restart-orange)" fillRule="evenodd" d="M128 64h128c85 0 144 50 144 128s-59 128-144 128h-48v128h-80V64zm80 72v112h44c42 0 68-20 68-56s-26-56-68-56h-44z" />
            <path className="restart-state" fill="url(#restart-purple)" fillRule="evenodd" d="M128 64h128c85 0 144 50 144 128s-59 128-144 128h-48v128h-80V64zm80 72v112h44c42 0 68-20 68-56s-26-56-68-56h-44z" />
            <path className="restart-state" fill="url(#restart-mint)" fillRule="evenodd" d="M128 64h128c85 0 144 50 144 128s-59 128-144 128h-48v128h-80V64zm80 72v112h44c42 0 68-20 68-56s-26-56-68-56h-44z" />
          </g>
        </svg>
      </div>
      <span>Applying changes and restarting OpenCode…</span>
    </div>
  );
}
