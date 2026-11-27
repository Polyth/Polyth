// The sheet's own line glyphs, for the meanings the host icon set does not
// carry (a bug, an idea, a lock…). Paths are Lucide's (ISC licence), drawn the
// way host glyphs are: 24-unit box, round caps, coloured by currentColor.
import type { ReactNode } from "react";
import type { WebIconGlyphProps } from "@polyth/web-sdk";
import type { FeedbackKind } from "@polyth/contracts/feedback";

const glyph = (paths: ReactNode) => function Glyph({ size = 16, strokeWidth = 1.75, className }: WebIconGlyphProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths}
    </svg>
  );
};

export const BugGlyph = glyph(<>
  <path d="m8 2 1.88 1.88" /><path d="M14.12 3.88 16 2" /><path d="M9 7.13v-1a3 3 0 1 1 6 0v1" />
  <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
  <path d="M12 20v-9" /><path d="M6.53 9C4.6 8.8 3 7.1 3 5" /><path d="M6 13H2" />
  <path d="M3 21c0-2.1 1.7-3.9 3.8-4" /><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" /><path d="M22 13h-4" />
  <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
</>);
export const IdeaGlyph = glyph(<>
  <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
  <path d="M9 18h6" /><path d="M10 22h4" />
</>);
export const AwkwardGlyph = glyph(<>
  <circle cx="12" cy="12" r="10" /><path d="M16 16s-1.5-2-4-2-4 2-4 2" /><path d="M9 9h.01" /><path d="M15 9h.01" />
</>);
export const LikeGlyph = glyph(
  <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />,
);
export const PulseGlyph = glyph(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />);
export const LockGlyph = glyph(<><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>);
export const ReplyGlyph = glyph(<><path d="M9 14 4 9l5-5" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></>);
export const PersonGlyph = glyph(<><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>);
export const ShieldGlyph = glyph(<>
  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  <path d="m9 12 2 2 4-4" />
</>);
export const CheckGlyph = glyph(<path d="M20 6 9 17l-5-5" />);
export const ClockGlyph = glyph(<><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>);
export const ImageGlyph = glyph(<>
  <rect width="18" height="18" x="3" y="3" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
</>);
export const CloseGlyph = glyph(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
export const PencilGlyph = glyph(<>
  <path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
  <path d="m15 5 4 4" />
</>);
export const ChevronGlyph = glyph(<path d="m9 18 6-6-6-6" />);

export const KIND_GLYPHS: Record<FeedbackKind, ReturnType<typeof glyph>> = {
  bug: BugGlyph,
  idea: IdeaGlyph,
  pain: AwkwardGlyph,
  praise: LikeGlyph,
};
