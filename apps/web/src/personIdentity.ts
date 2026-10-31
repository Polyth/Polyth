// A person's colour wherever people talk: the bubbles' names and monograms,
// the people-message alert, the inbox and the chat header. Eight tones are
// derived from the theme's own signal colours (styles.css, `data-person-tone`),
// so every theme keeps its palette and each tone stays readable on its panels.
//
// A tone comes from a stable hash of the account id, so a person usually keeps
// their colour everywhere. Inside one chat no two people share a tone while
// there are tones to spare: `assignPersonTones` takes everyone in the chat, the
// reader included, so every reader of that chat sees the same colours.
//
// The tones run around the colour wheel in order (red, orange, amber, green,
// teal, blue, purple, rose), so neighbours are the near ones.

/** How many tones there are (`data-person-tone="0"` … `"7"`). */
export const PERSON_TONES = 8;

/** FNV-1a: small, stable across browsers and releases. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The tone a person gets when nobody else in the chat claims it first. */
export function preferredPersonTone(userId: string): number {
  return hash(userId) % PERSON_TONES;
}

/** Tones for everyone in one chat. The same people in give the same answer
 *  out whatever the order: ids are taken in sorted order and each takes the
 *  first free tone from their own onwards. Up to four people share the even
 *  tones only (red, amber, teal, purple — no two neighbours on the wheel, so
 *  orange beside amber never reads as one voice), which also keeps a person's
 *  colour the same from chat to chat. Bigger chats use all eight; past
 *  eight people tones repeat. */
export function assignPersonTones(userIds: Iterable<string>): Map<string, number> {
  const ids = [...new Set([...userIds].filter((id) => typeof id === "string" && id.length > 0))].sort();
  const small = ids.length <= PERSON_TONES / 2;
  const taken = new Set<number>();
  const tones = new Map<string, number>();
  for (const id of ids) {
    const preferred = preferredPersonTone(id);
    const tone = Array.from({ length: PERSON_TONES }, (_, step) => (preferred + step) % PERSON_TONES)
      .find((candidate) => !taken.has(candidate) && (!small || candidate % 2 === 0)) ?? preferred;
    taken.add(tone);
    tones.set(id, tone);
  }
  return tones;
}

/** A person's tone in `tones`, else their own. */
export function personToneOf(tones: ReadonlyMap<string, number> | null | undefined, userId: string | null | undefined): number | null {
  if (!userId) return null;
  return tones?.get(userId) ?? preferredPersonTone(userId);
}
