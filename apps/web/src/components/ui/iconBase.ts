// Vendored Lucide React icon runtime. Polyth ships the handful of glyphs it
// uses as plain data (./iconNodes.ts) instead of depending on the whole
// lucide-react package, so this file reproduces that package's component
// behaviour exactly: the same default attributes, size/strokeWidth/
// absoluteStrokeWidth math, `lucide lucide-<name> …` classes (including the
// legacy alias classes Lucide still emits for renamed icons), the aria-hidden
// rule, children passthrough and ref forwarding. Markup must stay byte-identical
// to lucide-react for the same props.
//
// Upstream sources reproduced here (lucide-react 1.61.0, ISC licence — see
// ./LUCIDE-LICENSE): dist/esm/Icon.mjs, dist/esm/createLucideIcon.mjs and
// dist/esm/shared/src/{build,utils}. One deliberate omission: Lucide's optional
// provider context (LucideProvider) is not vendored because Polyth never
// renders one, so its defaults are inlined below.
import {
  createElement,
  forwardRef,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
  type SVGProps,
} from "react";

/** Attributes of one child element of an icon, exactly as Lucide stores them. */
export type IconNodeAttributes = Record<string, string | number | undefined>;

/** One icon child: [tag, attributes] as Lucide's own icon-node format. */
export type IconNodeChild = readonly [
  tag: string,
  attributes: IconNodeAttributes,
  children?: readonly IconNodeChild[],
];

/** The child elements of an icon, in drawing order. */
export type IconNode = readonly IconNodeChild[];

type ElementAttributes = RefAttributes<SVGSVGElement> & Partial<SVGProps<SVGSVGElement>>;

export interface LucideProps extends ElementAttributes {
  size?: string | number;
  /**
   * Keep the stroke visually constant when the icon is scaled: Lucide scales
   * the stroke width by the icon's own 24 unit box over the rendered size.
   */
  absoluteStrokeWidth?: boolean;
  nonScalingStroke?: boolean;
}

export type LucideIcon = ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>;

/** The fully-resolved icon Lucide's Icon renders. */
interface IconData {
  name?: string;
  size?: number;
  node: IconNode;
  aliases?: readonly string[];
}

// React attribute names (Lucide's build step maps its kebab-case defaults the
// same way) so React neither warns nor renames anything. Order is the markup
// order lucide-react emits.
const DEFAULT_ATTRIBUTES = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** Lucide's default icon box and viewBox unit. */
const DEFAULT_ICON_SIZE = 24;

const toKebabCase = (value: string): string =>
  value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const toCamelCase = (value: string): string => {
  let out = "";
  let upperNext = false;
  for (const ch of value) {
    if (ch === "-" || ch === "_" || ch <= " ") {
      upperNext = out.length > 0;
      continue;
    }
    if (out.length === 0) out += ch.toLowerCase();
    else out += upperNext ? ch.toUpperCase() : ch;
    upperNext = false;
  }
  return out;
};

const toPascalCase = (value: string): string => {
  const camel = toCamelCase(value);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
};

/** Join non-empty class names, keeping the first occurrence of each. */
const mergeClasses = (...classes: (string | undefined)[]): string =>
  classes
    .filter((className, index, array) => typeof className === "string" && className.trim() !== "" && array.indexOf(className) === index)
    .join(" ")
    .trim();

/** Any accessibility prop (or `title`) means the icon is not decorative. */
const hasA11yProp = (props: Record<string, unknown>): boolean => {
  for (const prop of Object.keys(props)) {
    if (prop.startsWith("aria-") || prop === "role" || prop === "title") return true;
  }
  return false;
};

interface BuildParams {
  color?: string;
  width?: string | number;
  height?: string | number;
  strokeWidth?: string | number;
  absoluteStrokeWidth?: boolean;
  nonScalingStroke?: boolean;
  className?: string;
  hasA11yProp?: boolean;
  attributes?: Record<string, unknown>;
}

function buildIconAttributes(icon: IconData, params: BuildParams): Record<string, unknown> {
  const viewBoxSize = icon.size ?? DEFAULT_ICON_SIZE;
  const aliasClassNames = (icon.aliases ?? [])
    .filter((alias) => typeof alias === "string" && alias.trim() !== "")
    .map((alias) => `lucide-${alias}`);
  const iconClassNames = [...(icon.name ? [`lucide-${icon.name}`] : []), ...aliasClassNames];
  const classNamesFromClassName = params.className?.split(" ").filter(Boolean) ?? [];
  const className = mergeClasses("lucide", ...iconClassNames, ...classNamesFromClassName);
  const calculatedStrokeWidth = params.absoluteStrokeWidth
    ? (Number(params.strokeWidth ?? DEFAULT_ATTRIBUTES.strokeWidth) * Number(icon.size ?? DEFAULT_ICON_SIZE)) /
      Number(params.width ?? DEFAULT_ICON_SIZE)
    : (params.strokeWidth ?? DEFAULT_ATTRIBUTES.strokeWidth);
  const attributes: Record<string, unknown> = {
    ...DEFAULT_ATTRIBUTES,
    ...(params.color ? { stroke: params.color } : {}),
    ...(params.width !== undefined && params.width !== null ? { width: params.width } : {}),
    ...(params.height !== undefined && params.height !== null ? { height: params.height } : {}),
    strokeWidth: calculatedStrokeWidth,
    ...(className ? { className } : {}),
    viewBox: `0 0 ${viewBoxSize} ${viewBoxSize}`,
    ...(params.hasA11yProp === false ? { "aria-hidden": "true" } : {}),
    ...params.attributes,
  };
  return attributes;
}

interface IconProps extends LucideProps {
  icon?: IconData;
  iconNode?: IconNode;
}

/** The shared SVG renderer every vendored icon component delegates to. */
const Icon = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
  const {
    color,
    size,
    width,
    height,
    strokeWidth,
    absoluteStrokeWidth,
    nonScalingStroke,
    className = "",
    children,
    iconNode = [],
    icon,
    ...rest
  } = props;
  const data: IconData = icon ?? { node: iconNode, aliases: [], size: DEFAULT_ICON_SIZE };
  const hasAccessibleProp = Boolean(children) || hasA11yProp(rest);
  const renderedWidth = width ?? size ?? DEFAULT_ICON_SIZE;
  const renderedHeight = height ?? size ?? DEFAULT_ICON_SIZE;
  const attributes = buildIconAttributes(data, {
    color: color ?? "currentColor",
    width: renderedWidth,
    height: renderedHeight,
    strokeWidth,
    absoluteStrokeWidth,
    nonScalingStroke,
    className: mergeClasses("", className),
    hasA11yProp: hasAccessibleProp,
    attributes: rest,
  });
  const nodeChildren: ReactNode[] = data.node.map(([tag, attrs]) => {
    // Lucide draws the stroke vector effect per child when it is opted into.
    const childAttrs = nonScalingStroke ? { vectorEffect: "non-scaling-stroke", ...attrs } : attrs;
    return createElement(tag, childAttrs as never);
  });
  const childNodes: ReactNode[] = [...nodeChildren, ...(Array.isArray(children) ? children : [children])];
  return createElement("svg", { ref, ...attributes } as never, childNodes);
});
Icon.displayName = "Icon";

/**
 * Build an icon component from an icon node. `name` is the Lucide name
 * (PascalCase or kebab-case); `aliases` keeps the legacy `lucide-<alias>`
 * classes Lucide emits for renamed icons.
 */
export function createIcon(name: string, iconNode: IconNode, aliases: readonly string[] = []): LucideIcon {
  if (iconNode == null) throw new Error("[lucide]: iconNode is required when icon name is used");
  const icon: IconData = {
    name: toKebabCase(name),
    size: DEFAULT_ICON_SIZE,
    node: iconNode,
    ...(aliases.length > 0 ? { aliases } : {}),
  };
  const Component = forwardRef<SVGSVGElement, LucideProps>(({ className, ...rest }, ref) =>
    createElement(Icon, { ref, icon, className, ...rest }),
  );
  if (icon.name) Component.displayName = toPascalCase(icon.name);
  return Component;
}

/** Lucide's own factory name, kept so existing call sites need no edit. */
export const createLucideIcon = createIcon;
