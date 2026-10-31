// Screen-reader-only content (reuses the core .sr-only utility).
import type { ReactNode } from "react";

export default function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
