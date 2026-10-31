// Package glyphs on the shared icon geometry (24 grid, round caps, the host
// Icon wrapper's className and stroke). Studio-specific marks that the host
// icon map does not carry (transport, studio views) live here once.
import type { ReactNode, SVGProps } from "react";

export type GlyphProps = Omit<SVGProps<SVGSVGElement>, "children"> & { strokeWidth?: number | string };
/** Props are optional so a glyph also fits the host's `iconStart` slot. */
export type Glyph = (props?: GlyphProps) => ReactNode;

const glyph = (body: ReactNode, filled = false): Glyph => function StudioGlyph({ strokeWidth = 1.75, ...props }: GlyphProps = {}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {body}
    </svg>
  );
};

export const PlayGlyph = glyph(<path d="M7.2 4.6v14.8a1 1 0 0 0 1.5.86l12-7.4a1 1 0 0 0 0-1.72l-12-7.4a1 1 0 0 0-1.5.86Z" />, true);
export const PauseGlyph = glyph(<><rect x="6" y="4.5" width="4" height="15" rx="1.2" /><rect x="14" y="4.5" width="4" height="15" rx="1.2" /></>, true);
export const RestartGlyph = glyph(<><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8.3" /><path d="M3 3.5v4.8h4.8" /></>);
export const SendGlyph = glyph(<><path d="m5 11 7-7 7 7" /><path d="M12 4v16" /></>);
export const SparkGlyph = glyph(<path d="M12 3.5c.5 3.9 2.6 6 6.5 6.5-3.9.5-6 2.6-6.5 6.5-.5-3.9-2.6-6-6.5-6.5 3.9-.5 6-2.6 6.5-6.5ZM18.5 15.5c.2 1.6 1 2.4 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.1 2.3-.9 2.5-2.5Z" />);
export const FilmGlyph = glyph(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21" /></>);
export const WaveGlyph = glyph(<path d="M3 10.5v3M7 7v10M11 4v16M15 8.5v7M19 6v12" />);
export const ExportGlyph = glyph(<><path d="M12 3.5v11" /><path d="m7.5 10 4.5 4.5 4.5-4.5" /><path d="M4 16.5v1.5A2.5 2.5 0 0 0 6.5 20.5h11a2.5 2.5 0 0 0 2.5-2.5v-1.5" /></>);
export const ReviewGlyph = glyph(<><path d="M4 21V4.5s1.2-1 4-1 5 2 8 2 4-1 4-1v10s-1.2 1-4 1-5-2-8-2-4 1-4 1" /></>);
export const ProgressGlyph = glyph(<><path d="M4 6.5h.01M4 12h.01M4 17.5h.01" /><path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H15" /></>);
export const ChatGlyph = glyph(<path d="M20.5 15a2.5 2.5 0 0 1-2.5 2.5H8l-4.5 3.5V6A2.5 2.5 0 0 1 6 3.5h12A2.5 2.5 0 0 1 20.5 6Z" />);
export const MoreGlyph = glyph(<><circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" /></>);
export const CheckGlyph = glyph(<path d="M20 6.5 9.5 17 4.5 12" />);
export const CloseGlyph = glyph(<path d="M17.5 6.5 6.5 17.5M6.5 6.5l11 11" />);
export const PlusGlyph = glyph(<path d="M12 5v14M5 12h14" />);
export const MusicGlyph = glyph(<><path d="M9 18V5.5l11-2v12.5" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></>);
export const UploadGlyph = glyph(<><path d="M12 15.5v-11" /><path d="m7.5 9 4.5-4.5L16.5 9" /><path d="M4 16.5v1.5A2.5 2.5 0 0 0 6.5 20.5h11a2.5 2.5 0 0 0 2.5-2.5v-1.5" /></>);
export const OpenGlyph = glyph(<><path d="M14.5 3.5h6v6" /><path d="M10 14 20.5 3.5" /><path d="M18.5 13.5v5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h5" /></>);
export const BellGlyph = glyph(<><path d="M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15.5 6 9Z" /><path d="M10.2 20.5a2 2 0 0 0 3.6 0" /></>);
export const AlertGlyph = glyph(<><path d="M10.3 4.4 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4M12 17h.01" /></>);
export const ClapperGlyph = glyph(<><path d="M3.5 10.5h17v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /><path d="m3.6 10.4-.8-2.6a2 2 0 0 1 1.3-2.5l12.4-3.6a2 2 0 0 1 2.5 1.3l.8 2.6Z" /><path d="m7.5 6.7 3 3.5M13.3 5l3 3.5" /></>);
export const ChevronGlyph = glyph(<path d="m9 6 6 6-6 6" />);
export const BackGlyph = glyph(<path d="m15 6-6 6 6 6" />);
export const LayersGlyph = glyph(<><path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8Z" /><path d="m3.5 12 8.5 4.5 8.5-4.5" /><path d="m3.5 16 8.5 4.5 8.5-4.5" /></>);
export const LyricsGlyph = glyph(<><path d="M4.5 6.5h11M4.5 11h11M4.5 15.5h6" /><path d="M18.5 18V9l2.5-.5" /><circle cx="17" cy="18.2" r="1.8" /></>);
