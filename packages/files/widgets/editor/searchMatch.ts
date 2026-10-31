// Which characters of a file name a quick-open query matched, for bolding.
// A contiguous case-insensitive hit wins; otherwise the query's characters
// in order (the server's fuzzy scorer also accepts subsequences).

export interface MatchSegment { text: string; hit: boolean }

export function matchSegments(name: string, query: string): MatchSegment[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [{ text: name, hit: false }];
  const haystack = name.toLocaleLowerCase();
  // Case folding that changes length would misalign indices: show it plain.
  if (haystack.length !== name.length) return [{ text: name, hit: false }];
  const hits = new Array<boolean>(name.length).fill(false);
  const at = haystack.indexOf(needle);
  if (at >= 0) {
    for (let index = at; index < at + needle.length; index += 1) hits[index] = true;
  } else {
    let cursor = 0;
    for (let index = 0; index < name.length && cursor < needle.length; index += 1) {
      if (haystack[index] === needle[cursor]) {
        hits[index] = true;
        cursor += 1;
      }
    }
    if (cursor < needle.length) return [{ text: name, hit: false }];
  }
  const segments: MatchSegment[] = [];
  for (let index = 0; index < name.length; index += 1) {
    const last = segments.at(-1);
    if (last && last.hit === hits[index]) last.text += name[index];
    else segments.push({ text: name[index]!, hit: hits[index]! });
  }
  return segments;
}

/** "packages/files/src/index.ts" → { name: "index.ts", dir: "packages/files/src" }. */
export function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { name: path, dir: "" } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}
