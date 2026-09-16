import { type CSSProperties, type ReactNode } from "react";
import type { Project } from "@polyth/contracts";
import { Icon } from "../icons.tsx";
import { tr } from "../i18n/index.ts";
import {
  isProjectIconBundledPath,
  isProjectIconRasterDataUrl,
  isProjectIconSvgDataUrl,
  projectIconMaskStyle,
  projectIconSvgBlobMaskUrl,
} from "../projectIconGlyph.ts";

type ProjectGlyphProps = {
  project: Pick<Project, "icon" | "color" | "remote">;
  className?: string;
  maskClassName?: string;
  loadingFallback?: ReactNode;
};

function useProjectIconMask(icon: string): { maskStyle: CSSProperties | null; pending: boolean } {
  const syncStyle = icon ? projectIconMaskStyle(icon) : null;
  const needsBlob = !!icon && !syncStyle && isProjectIconSvgDataUrl(icon);
  const blobMask = needsBlob ? projectIconSvgBlobMaskUrl(icon) : "";

  if (syncStyle) return { maskStyle: syncStyle, pending: false };
  if (blobMask) {
    return {
      maskStyle: { WebkitMaskImage: `url("${blobMask}")`, maskImage: `url("${blobMask}")` },
      pending: false,
    };
  }
  return { maskStyle: null, pending: needsBlob };
}

export function ProjectIconBody({
  icon,
  loadingFallback = null,
  maskClassName = "project-glyph-mask",
}: {
  icon: string;
  loadingFallback?: ReactNode;
  maskClassName?: string;
}) {
  const { maskStyle, pending } = useProjectIconMask(icon);

  if (!icon) return null;
  if (maskStyle) {
    return <span className={maskClassName} aria-hidden="true" style={maskStyle} />;
  }
  if (pending) return <>{loadingFallback}</>;
  if (isProjectIconRasterDataUrl(icon)) return <img src={icon} alt="" />;
  return <span aria-hidden="true">{icon}</span>;
}

export default function ProjectGlyph({
  project,
  className,
  maskClassName,
  loadingFallback = null,
}: ProjectGlyphProps) {
  const icon = project.icon ?? "";
  const showPlaceholder = !icon;

  return (
    <span
      className={className ? `project-glyph ${className}` : "project-glyph"}
      style={project.color ? { color: project.color } : undefined}
    >
      {showPlaceholder
        ? <Icon.files />
        : isProjectIconBundledPath(icon) || isProjectIconSvgDataUrl(icon)
          ? <ProjectIconBody icon={icon} loadingFallback={loadingFallback} maskClassName={maskClassName} />
          : isProjectIconRasterDataUrl(icon)
            ? <img src={icon} alt="" />
            : <span aria-hidden="true">{icon}</span>}
      {project.remote && (
        <span
          className="project-remote-marker"
          role="img"
          aria-label={tr("ssh.sshprojectsource.remoteProject")}
          title={tr("ssh.sshprojectsource.remoteProject")}
        >
          <Icon.globe />
        </span>
      )}
    </span>
  );
}
