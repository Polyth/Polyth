// Access review: what a package asks for, in reader language, with the
// constraints the host enforces (origins, methods, model classes, limits).
import type {
  PackageCapabilityRequestDto,
  PackageConnectionReviewDto,
  PackageConnectionSecurityDto,
} from "@polyth/contracts";
import { Badge } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { capabilityLabel } from "./pluginTaxonomy.ts";

interface CapabilityReviewView {
  required: boolean;
  origins: string[];
  methods: string[];
  modelClasses: string[];
  maxOutputTokens?: number;
}

/** The server manifest parser already validates these fields. The root
 *  contracts DTO predates v2 constraints, so the settings UI re-validates the
 *  JSON-compatible extension before presenting it instead of relying on an
 *  unsafe cast or pretending optional authority is required. */
function capabilityReviewView(capability: PackageCapabilityRequestDto): CapabilityReviewView {
  const raw = capability as unknown as Record<string, unknown>;
  const constraints = raw.constraints && typeof raw.constraints === "object" && !Array.isArray(raw.constraints)
    ? raw.constraints as Record<string, unknown>
    : {};
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const maxOutputTokens = typeof constraints.maxOutputTokens === "number" && Number.isFinite(constraints.maxOutputTokens)
    ? constraints.maxOutputTokens
    : undefined;
  return {
    required: raw.required !== false,
    origins: strings(constraints.origins),
    methods: strings(constraints.methods),
    modelClasses: strings(constraints.modelClasses),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

export function capabilityRequired(capability: PackageCapabilityRequestDto): boolean {
  return capabilityReviewView(capability).required;
}

/** Constraint facts of one capability, e.g. "Origins: https://api.github.com". */
export function capabilityDetails(capability: PackageCapabilityRequestDto): string[] {
  const view = capabilityReviewView(capability);
  return [
    ...(view.origins.length ? [`${tr("packages.plugins.origins")}: ${view.origins.join(", ")}`] : []),
    ...(view.methods.length ? [`${tr("packages.plugins.methods")}: ${view.methods.join(", ")}`] : []),
    ...(view.modelClasses.length ? [`${tr("packages.plugins.models")}: ${view.modelClasses.join(", ")}`] : []),
    ...(view.maxOutputTokens !== undefined ? [tr("packages.plugins.maxOutputTokens", { count: view.maxOutputTokens })] : []),
  ];
}

/** One line per capability: its name, whether it is required, its limits. */
export function AccessList({ items, label }: { items: readonly PackageCapabilityRequestDto[]; label: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="plugin-access" aria-label={label}>
      {items.map((item) => {
        const view = capabilityReviewView(item);
        const details = capabilityDetails(item);
        return (
          <li className="plugin-access-item" key={`${item.name}:${view.required}:${JSON.stringify(item.constraints ?? {})}`}>
            <span className="plugin-access-name">
              <strong>{capabilityLabel(item.name)}</strong>
              {!view.required && <Badge>{tr("packages.plugins.optionalBadge")}</Badge>}
            </span>
            {details.length > 0 && <span className="plugin-access-detail">{details.join(" · ")}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function ConnectionFacts({ value }: { value: PackageConnectionSecurityDto }) {
  const facts: Array<[string, string]> = [
    [tr("packages.plugins.kind"), value.kind],
    [tr("packages.plugins.apiOrigins"), value.origins.join(", ")],
    [tr("packages.plugins.oauthAuthorize"), value.authorizeUrl ?? ""],
    [tr("packages.plugins.oauthToken"), value.tokenUrl ?? ""],
    [tr("packages.plugins.oauthClientId"), value.clientId ?? ""],
    [tr("packages.plugins.oauthScopes"), (value.scopes ?? []).join(", ")],
  ];
  return (
    <dl className="plugin-facts plugin-facts--compact">
      {facts.filter(([, fact]) => fact).map(([term, fact]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{fact}</dd>
        </div>
      ))}
    </dl>
  );
}

/** New or changed connection security, before/after side by side. */
export function ConnectionReview({ items }: { items: readonly PackageConnectionReviewDto[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="plugin-access" aria-label={tr("packages.plugins.connectionSecurity")}>
      {items.map((item) => (
        <li className="plugin-access-item" key={item.id}>
          <span className="plugin-access-name">
            <strong>{item.label}</strong>
            <Badge tone={item.kind === "changed" ? "warning" : "info"}>
              {item.kind === "changed" ? tr("packages.plugins.changed") : tr("packages.plugins.new")}
            </Badge>
          </span>
          <div className="plugin-connection-compare">
            {item.current && (
              <div>
                <span className="plugin-connection-label">{tr("packages.plugins.current")}</span>
                <ConnectionFacts value={item.current} />
              </div>
            )}
            <div>
              <span className="plugin-connection-label">{tr("packages.plugins.requested")}</span>
              <ConnectionFacts value={item.next} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
