// Shared text style components
import type { ReactNode } from "react";

/** Muted label text - used for flags like INPUT, OUTPUT, BEST BID */
export function Label({ children }: { children: ReactNode }) {
  return <span className="text-label">{children}</span>;
}

