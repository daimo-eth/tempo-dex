// Shared text style components
import React from "react";

/** Muted label text - used for flags like INPUT, OUTPUT, BEST BID */
export function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-label">{children}</span>;
}

/** Primary value text */
export function Value({ children }: { children: React.ReactNode }) {
  return <span className="text-value">{children}</span>;
}

/** Muted/secondary text */
export function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted">{children}</span>;
}

