// A sign-in name proposed from the person's display name during setup, so
// nobody has to invent a login. The server's rule (packages/identity
// validation `loginName`) is the authority; this only proposes a value that
// passes it, and falls back to "owner" when the name has nothing to keep.

export const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const FALLBACK_LOGIN = "owner";
const MAX_PROPOSED = 32;

// Cyrillic letters have no decomposition to Latin; a short table keeps
// Ukrainian, Russian and Bulgarian names readable instead of empty.
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ye", ж: "zh", з: "z",
  и: "y", і: "i", ї: "yi", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ь: "", ъ: "", ы: "y", э: "e", ю: "yu", я: "ya", ё: "yo", "'": "", "’": "", "ʼ": "",
};

export function loginFromName(name: string): string {
  const folded = Array.from(name.trim().toLowerCase())
    .map((char) => CYRILLIC[char] ?? char)
    .join("")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  const proposed = folded
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, MAX_PROPOSED)
    .replace(/\.+$/, "");
  return LOGIN_PATTERN.test(proposed) ? proposed : FALLBACK_LOGIN;
}

/** What the person typed in the login field, in the form the server stores. */
export const normalizeLogin = (value: string): string => value.trim().toLowerCase();
