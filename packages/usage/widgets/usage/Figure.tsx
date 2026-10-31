/** A formatted value split into its lower-bound sign, the number and the unit that trails it. */
export interface FigureParts { sign: string; number: string; unit: string }

// The number runs to its last digit; what follows is the unit (`%`, `M`, ` tok/s`,
// `% used`). A value that does not start with a number (`—`, `Unlimited`,
// `In use`) is not split.
const FIGURE = /^([≥~]?)([^\p{L}\s]*\d(?:.*\d)?)(\D*)$/u;

export function splitFigure(value: string): FigureParts | null {
  const match = FIGURE.exec(value);
  return match ? { sign: match[1]!, number: match[2]!, unit: match[3]! } : null;
}

/**
 * The number carries the weight, the unit and the lower-bound sign step back.
 * The text is unchanged, so screen readers and copy read the value as formatted.
 */
export function Figure({ value }: { value: string }) {
  const parts = splitFigure(value);
  if (!parts) return <>{value}</>;
  return <>
    {parts.sign ? <span className="usage-figure-sign">{parts.sign}</span> : null}
    {parts.number}
    {parts.unit ? <span className="usage-figure-unit">{parts.unit}</span> : null}
  </>;
}
