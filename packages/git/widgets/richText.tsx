import { Fragment, type ReactNode } from "react";
import { tr, type TranslationKey } from "../../../apps/web/src/i18n/index.ts";

/** A translated sentence with React nodes (`<code>`) in its `{name}` slots,
 *  so a translation can move the code wherever its grammar needs it. */
export function richText(key: TranslationKey, parts: Record<string, ReactNode>): ReactNode {
  const marks = Object.fromEntries(Object.keys(parts).map((name) => [name, `\u0000${name}\u0000`]));
  return tr(key, marks).split("\u0000").map((chunk, index) => (
    <Fragment key={index}>{index % 2 === 1 ? parts[chunk] ?? chunk : chunk}</Fragment>
  ));
}
