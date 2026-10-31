// Package glyphs in the app's Lucide line style (24px grid, 1.75 stroke).
import type { ReactNode, SVGProps } from "react";

const line = (children: ReactNode) => function Glyph(props: SVGProps<SVGSVGElement> & { size?: number | string }) {
  const { size = 16, ...rest } = props;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
};

/** Lucide `message-circle-question`: a side question. */
export const BtwIcon = line(<>
  <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
  <path d="M12 17h.01" />
</>);

/** Lucide `corner-down-left`: put into the composer draft. */
export const InsertIcon = line(<>
  <path d="M20 4v7a4 4 0 0 1-4 4H4" />
  <path d="m9 10-5 5 5 5" />
</>);

/** Lucide `check`. */
export const CheckGlyph = line(<path d="M20 6 9 17l-5-5" />);
