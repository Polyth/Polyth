/** DOM-free overflow rule for Markdown fenced code frames. */

export function codeBlockOverflow(
  contentHeight: number,
  viewportHeight: number,
): { collapsible: boolean; collapsedMax: number } {
  return {
    collapsible: contentHeight > viewportHeight,
    collapsedMax: viewportHeight / 3,
  };
}
