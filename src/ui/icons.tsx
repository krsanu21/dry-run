/**
 * Transport icons, drawn on a 16×16 grid with one stroke weight so they read as
 * a set. Step icons follow common debugger conventions: a dot is "the current
 * line"; over = an arc that jumps the dot, into = an arrow down into it,
 * out = an arrow up away from it.
 */

type IconName = "start" | "end" | "back" | "backOver" | "play" | "pause" | "into" | "over" | "out" | "prevBp" | "nextBp" | "restart" | "stop";

const PATHS: Record<IconName, React.ReactNode> = {
  start: (
    <>
      <path d="M4 3v10" />
      <path d="M12 3.5 6.5 8 12 12.5Z" fill="currentColor" />
    </>
  ),
  end: (
    <>
      <path d="M12 3v10" />
      <path d="M4 3.5 9.5 8 4 12.5Z" fill="currentColor" />
    </>
  ),
  back: <path d="M11 3.5 5 8l6 4.5Z" fill="currentColor" />,
  play: <path d="M5 3.2 12.5 8 5 12.8Z" fill="currentColor" />,
  pause: (
    <>
      <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2.2" />
    </>
  ),
  into: (
    <>
      <path d="M8 1.8v6.4" />
      <path d="m5.3 5.8 2.7 2.7 2.7-2.7" />
      <circle cx="8" cy="12.6" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  over: (
    <>
      <path d="M2.8 9.2C3.6 5 12.4 5 13.2 9.2" />
      <path d="m10.6 8.6 2.6.9.9-2.6" />
      <circle cx="8" cy="12.6" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  backOver: (
    <>
      <path d="M13.2 9.2C12.4 5 3.6 5 2.8 9.2" />
      <path d="m5.4 8.6-2.6.9-.9-2.6" />
      <circle cx="8" cy="12.6" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  out: (
    <>
      <path d="M8 10V3.2" />
      <path d="M5.3 5.6 8 2.9l2.7 2.7" />
      <circle cx="8" cy="12.9" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  prevBp: (
    <>
      <circle cx="10.5" cy="8" r="3" fill="currentColor" stroke="none" />
      <path d="M5.5 4.5 2.5 8l3 3.5" />
    </>
  ),
  nextBp: (
    <>
      <circle cx="5.5" cy="8" r="3" fill="currentColor" stroke="none" />
      <path d="m10.5 4.5 3 3.5-3 3.5" />
    </>
  ),
  restart: (
    <>
      <path d="M12.6 8.4A4.7 4.7 0 1 1 11 4.4" />
      <path d="M11.6 1.9v3h-3" />
    </>
  ),
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />,
};

export function Icon({ name }: { name: IconName }): React.JSX.Element {
  return (
    <svg className="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
