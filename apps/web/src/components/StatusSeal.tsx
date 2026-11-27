// The seal: a chat that waits on a person (an approval, a reply, a failure or
// a runtime to confirm). One shape and one tone per kind on the rail tile, the
// project tree row and the session row; tones are `--seal-*` (tokens.css,
// derived per theme by `sealCssVars` in theme.ts).
import type { ProjectSealKind } from "../sessionStatus.ts";

/** The most a seal counts; the server sends ten unread rows per project. */
export const SEAL_MAX_COUNT = 9;

export function sealCountText(count: number): string {
  return count > SEAL_MAX_COUNT ? `${SEAL_MAX_COUNT}+` : String(count);
}

/**
 * The seal's glyph, drawn rather than set in type: at 9px a font's "?" and "!"
 * thin out into the seal's colour. One 10-unit box with ~1.9-unit strokes, so
 * every kind carries the same weight. The shield has its "!" punched out, as
 * the row's ShieldAlert icon does: a plain shield read as a blob at this size.
 * Each glyph's ink box is centred on the box's middle (5, 5): the seal centres
 * the box, so an off-centre drawing would ride high or low in every seal.
 */
export function SealGlyph({ kind }: { kind: ProjectSealKind }) {
  if (kind === "question") {
    return (
      <svg className="status-seal-glyph" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        <path d="M3.1 3.4a1.9 1.9 0 1 1 2.85 1.62c-.62.38-1 .72-1 1.38" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" />
        <circle cx="4.95" cy="8.4" r="1.05" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "permission") {
    return (
      <svg className="status-seal-glyph" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        <path
          fillRule="evenodd"
          fill="currentColor"
          d="M5 .3 9 1.75v2.9c0 2.55-1.75 4.2-4 5.05C2.75 8.85 1 7.2 1 4.65v-2.9zM4.3 2.55h1.4v3.3H4.3zM5 6.55a.78.78 0 1 0 0 1.56.78.78 0 0 0 0-1.56z"
        />
      </svg>
    );
  }
  return (
    <svg className="status-seal-glyph" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <rect x="4.05" y=".63" width="1.9" height="5.3" rx=".95" fill="currentColor" />
      <circle cx="5" cy="8.33" r="1.05" fill="currentColor" />
    </svg>
  );
}

/**
 * A count set in the seal's own SVG box, as the glyphs are drawn. The box
 * lands on the pixel grid with the disc, while HTML text snaps on its own: on
 * a rail scaled to 90% or 115% the tile sits between pixels and a figure set
 * as text fell most of a pixel off the disc's centre. The baseline sits half
 * a cap height below the middle, so the figures centre on the band they fill.
 */
export function SealCount({ count }: { count: number }) {
  return (
    <svg className="status-seal-count" aria-hidden="true" focusable="false">
      <text x="50%" y="50%" textAnchor="middle">{sealCountText(count)}</text>
    </svg>
  );
}

/** One chat shows what it is; several show how many. */
export function SealContent({ kind, count }: { kind: ProjectSealKind; count: number }) {
  return count > 1 ? <SealCount count={count} /> : <SealGlyph kind={kind} />;
}
