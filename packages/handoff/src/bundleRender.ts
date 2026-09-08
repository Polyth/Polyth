import type { ContextBundleDto, ContextBundleSectionDto } from "@polyth/contracts";

export function renderBundleMarkdown(
  sections: ReadonlyArray<Pick<ContextBundleSectionDto, "title" | "body">>,
  instruction: string,
): string {
  const parts = sections.map((s) => `# ${s.title}\n\n${s.body}`);
  if (instruction.trim()) parts.push(`# Instruction\n\n${instruction}`);
  return parts.join("\n\n");
}

export function bundleSectionsForCopy(
  bundle: ContextBundleDto,
  excludeSectionIds?: ReadonlySet<string>,
): ContextBundleSectionDto[] {
  if (!excludeSectionIds?.size) return bundle.sections;
  return bundle.sections.filter((section) => !excludeSectionIds.has(section.id));
}

export function bundleCopyText(
  bundle: ContextBundleDto,
  excludeSectionIds?: ReadonlySet<string>,
): string {
  const sections = bundleSectionsForCopy(bundle, excludeSectionIds);
  return renderBundleMarkdown(sections, bundle.instruction);
}

export function newBundleSectionId(): string {
  return crypto.randomUUID();
}
