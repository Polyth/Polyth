type Node = { size: number; height: number; values?: readonly unknown[]; left?: Node; right?: Node };
const PAGE = 256;
const roots = new WeakMap<readonly unknown[], Node>();
const branch = (left: Node, right: Node): Node => ({ left, right, size: left.size + right.size, height: Math.max(left.height, right.height) + 1 });
function join(left: Node, right: Node): Node {
  if (left.values && right.values && left.size + right.size <= PAGE) return { size: left.size + right.size, height: 1, values: [...left.values, ...right.values] };
  if (left.height > right.height + 1) {
    const tail = join(left.right!, right);
    if (tail.height <= left.left!.height + 1) return branch(left.left!, tail);
    return branch(branch(left.left!, tail.left!), tail.right!);
  }
  if (right.height > left.height + 1) {
    const head = join(left, right.left!);
    if (head.height <= right.right!.height + 1) return branch(head, right.right!);
    return branch(head.left!, branch(head.right!, right.right!));
  }
  return branch(left, right);
}
function root(values: readonly unknown[]): Node {
  const existing = roots.get(values);
  if (existing) return existing;
  if (values.length <= PAGE) return { size: values.length, height: 1, values: values.slice() };
  const middle = Math.floor(values.length / 2);
  return branch(root(values.slice(0, middle)), root(values.slice(middle)));
}
function at(node: Node, index: number): unknown {
  if (index < 0 || index >= node.size) return undefined;
  while (!node.values) {
    if (index < node.left!.size) node = node.left!;
    else { index -= node.left!.size; node = node.right!; }
  }
  return node.values[index];
}
function* values(node: Node): Generator<unknown> {
  if (node.values) yield* node.values;
  else { yield* values(node.left!); yield* values(node.right!); }
}
const indexOf = (key: string | symbol): number | undefined => {
  if (typeof key !== "string" || key === "") return undefined;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && String(index) === key ? index : undefined;
};
/** Array-compatible immutable pages. Ordinary array readers keep their API;
 * appends share the complete old tree instead of copying every event reference. */
function array<T>(node: Node): T[] {
  const target: T[] = [];
  const view = new Proxy(target, {
    get(target, key, receiver) {
      if (key === Symbol.iterator) return () => values(node);
      if (key === "length") return node.size;
      const index = indexOf(key);
      return index === undefined ? Reflect.get(target, key, receiver) : at(node, index);
    },
    has(target, key) { const index = indexOf(key); return index === undefined ? Reflect.has(target, key) : index < node.size; },
    ownKeys() { return [...Array.from({ length: node.size }, (_, i) => String(i)), "length"]; },
    getOwnPropertyDescriptor(target, key) {
      if (key === "length") return { value: node.size, writable: true, enumerable: false, configurable: false };
      const index = indexOf(key);
      return index !== undefined && index < node.size
        ? { value: at(node, index), writable: false, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, key);
    },
    set() { throw new TypeError("event segments are immutable"); },
    deleteProperty() { throw new TypeError("event segments are immutable"); },
  });
  roots.set(view, node);
  return view;
}
export function appendEventSegments<T>(existing: readonly T[], added: readonly T[]): T[] {
  if (!existing.length) return array<T>(root(added));
  return array<T>(join(root(existing), root(added)));
}
export function prependEventSegments<T>(existing: readonly T[], added: readonly T[]): T[] {
  return array<T>(join(root(added), root(existing)));
}
export function eventSegmentDepth(events: readonly unknown[]): number { return roots.get(events)?.height ?? 0; }
