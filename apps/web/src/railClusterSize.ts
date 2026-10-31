/**
 * Block size the idle launcher strip occupies as the tablet band's floating
 * cluster (styles.css, `@container app-shell (961px…1400px)`): the strip's own
 * padding, every in-flow child at its natural height, the gaps between them
 * and the host's 1px block borders.
 *
 * The open/close morph between that cluster and the docked column needs this
 * number while the strip is stretched to full height, where the browser
 * cannot report it — so it is derived from the children, which keep their
 * natural size in both states. The scroll list stretches, so its content is
 * measured from its first to its last item instead; an overflowing list
 * reports its scroll height and the stylesheet clamps the cluster anyway.
 */
export const RAIL_CLUSTER_HOST_BORDERS = 2;

export function railClusterBlockSize(strip: HTMLElement): number {
  const style = getComputedStyle(strip);
  let size = px(style.paddingTop) + px(style.paddingBottom) + RAIL_CLUSTER_HOST_BORDERS;
  let items = 0;
  for (const child of Array.from(strip.children)) {
    if (!isInFlow(child)) continue;
    items += 1;
    size += child.classList.contains("rail-icon-scroll")
      ? listContentSize(child)
      : child.getBoundingClientRect().height;
  }
  return size + px(style.rowGap) * Math.max(0, items - 1);
}

function listContentSize(list: Element): number {
  if (list.scrollHeight > list.clientHeight + 0.5) return list.scrollHeight;
  const rows = Array.from(list.children).filter(isInFlow);
  if (rows.length === 0) return 0;
  const style = getComputedStyle(list);
  const top = rows[0]!.getBoundingClientRect().top;
  const bottom = rows[rows.length - 1]!.getBoundingClientRect().bottom;
  return Math.max(0, bottom - top) + px(style.paddingTop) + px(style.paddingBottom);
}

function isInFlow(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.position !== "absolute" && style.position !== "fixed";
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
