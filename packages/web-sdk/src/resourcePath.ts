/** Shorten by whole path segments, keeping the filename intact. The original
 * locator remains the resource identity and should be used as the tooltip. */
export function compactResourcePath(path: string, maxLength = 64): string {
  if (path.length <= maxLength) return path;
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return path;
  const filename = segments.at(-1)!;
  if (segments.length === 2) return filename.length + 2 <= maxLength ? `…/${filename}` : filename;
  let result = filename.length + 2 <= maxLength ? `…/${filename}` : filename;
  for (let count = 1; count < segments.length - 1; count++) {
    const candidate = `${segments[0]}/…/${segments.slice(-count).join("/")}`;
    if (candidate.length > maxLength) break;
    result = candidate;
  }
  return result;
}
