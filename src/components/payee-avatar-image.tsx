"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Renders a downloaded payee favicon, falling back to the letter-circle
 * `fallback` if the image fails to load (deleted file, decode error, …).
 * Client-only for the `onError` handler; the rest of PayeeAvatar stays
 * server-compatible.
 */
export function PayeeAvatarImage({
  iconUrl,
  fallback,
  className,
}: {
  iconUrl: string;
  fallback: React.ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={iconUrl}
      onError={() => setFailed(true)}
      className={cn("size-4 shrink-0 rounded-sm object-cover", className)}
      alt=""
      aria-hidden
      loading="lazy"
    />
  );
}
