// A region/window slot that ADOPTS a surface's stable mount node. Rendering a
// slot never mounts React content: the SurfaceMountLayer owns the subtree, the
// slot only decides where the already-rendered DOM lives right now.
import { useLayoutEffect, useRef } from "react";
import { adoptSurfaceNode, rememberSurfaceState, surfaceMountNode } from "./surfaceMounts.ts";

export interface SurfaceSlotProps {
  surfaceId: string;
  className?: string;
}

export default function SurfaceSlot({ surfaceId, className }: SurfaceSlotProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    adoptSurfaceNode(surfaceId, host);
    return () => {
      // The node may already have been adopted by a sibling slot in this same
      // commit (surface moved regions): only release it when it is still ours.
      const node = surfaceMountNode(surfaceId);
      if (node.parentElement === host) {
        rememberSurfaceState(surfaceId);
        host.removeChild(node);
      }
    };
  }, [surfaceId]);
  return <div ref={hostRef} className={`wb-slot${className ? ` ${className}` : ""}`} data-surface-slot={surfaceId} />;
}
