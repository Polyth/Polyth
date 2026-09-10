export interface WeightedLayoutItem<T> {
  weight: number;
  data: T;
}

export interface WeightedLayoutRect<T> {
  x: number;
  y: number;
  width: number;
  height: number;
  data: T;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function splitIndex<T>(items: readonly WeightedLayoutItem<T>[], total: number): number {
  const target = total / 2;
  let sum = 0;
  let bestIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < items.length; index += 1) {
    sum += items[index - 1]?.weight ?? 0;
    const distance = Math.abs(target - sum);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function layout<T>(items: readonly WeightedLayoutItem<T>[], box: Box, output: WeightedLayoutRect<T>[]): void {
  if (items.length === 0 || box.width <= 0 || box.height <= 0) return;
  if (items.length === 1) {
    const item = items[0];
    if (item) output.push({ ...box, data: item.data });
    return;
  }

  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return;
  const index = splitIndex(items, total);
  const left = items.slice(0, index);
  const right = items.slice(index);
  const leftWeight = left.reduce((sum, item) => sum + item.weight, 0);
  const ratio = leftWeight / total;

  if (box.width >= box.height) {
    const width = box.width * ratio;
    layout(left, { ...box, width }, output);
    layout(right, { x: box.x + width, y: box.y, width: box.width - width, height: box.height }, output);
  } else {
    const height = box.height * ratio;
    layout(left, { ...box, height }, output);
    layout(right, { x: box.x, y: box.y + height, width: box.width, height: box.height - height }, output);
  }
}

export function layoutWeightedRects<T>(
  items: readonly WeightedLayoutItem<T>[],
  width: number,
  height: number,
): WeightedLayoutRect<T>[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const valid = items
    .filter((item) => Number.isFinite(item.weight) && item.weight > 0)
    .toSorted((left, right) => right.weight - left.weight);
  const output: WeightedLayoutRect<T>[] = [];
  layout(valid, { x: 0, y: 0, width, height }, output);
  return output;
}
