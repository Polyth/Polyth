// A paused run's mark: the working ring at rest with a pause sign inside, so
// pausing reads as the spinner stopping rather than a different control. The
// subagent branch and a paused chat's notice share it.
export default function PausedMark({ className }: { className?: string }) {
  return (
    <svg
      className={["paused-mark", className ?? ""].filter(Boolean).join(" ")}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="paused-mark-ring" cx="8" cy="8" r="5.5" />
      <rect className="paused-mark-bar" x="5.6" y="5.4" width="1.7" height="5.2" rx=".85" />
      <rect className="paused-mark-bar" x="8.7" y="5.4" width="1.7" height="5.2" rx=".85" />
    </svg>
  );
}
