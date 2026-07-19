import { ArrowLeftRight } from "lucide-react";
import { PayeeAvatarImage } from "./payee-avatar-image";
import { cn } from "@/lib/utils";

/**
 * Fixed pastel background/foreground pairs spread across the hue wheel. Kept as
 * full literal class names (never interpolated) so Tailwind can see them.
 */
const PAYEE_COLORS = [
  "bg-red-100 text-red-700",
  "bg-orange-100 text-orange-700",
  "bg-amber-100 text-amber-700",
  "bg-lime-100 text-lime-700",
  "bg-emerald-100 text-emerald-700",
  "bg-teal-100 text-teal-700",
  "bg-sky-100 text-sky-700",
  "bg-blue-100 text-blue-700",
  "bg-violet-100 text-violet-700",
  "bg-pink-100 text-pink-700",
];

/** Stable non-negative hash of a string (djb2-ish). */
function hashPayee(payee: string): number {
  let hash = 0;
  for (let i = 0; i < payee.length; i++) {
    hash = (hash * 31 + payee.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Deterministic palette class for a payee — the same payee always maps to the same color. */
export function payeeColorClass(payee: string): string {
  return PAYEE_COLORS[hashPayee(payee) % PAYEE_COLORS.length];
}

const AVATAR_BOX =
  "flex size-4 shrink-0 items-center justify-center rounded-sm text-[9px] font-medium leading-none";

/** The letter-circle avatar: the payee's initial, or a muted "?" when empty. */
function letterAvatar(payee: string, className?: string): React.ReactElement {
  const letter = payee.trim().charAt(0).toUpperCase();
  if (letter === "") {
    return (
      <span className={cn(AVATAR_BOX, "bg-muted text-muted-foreground", className)} aria-hidden>
        ?
      </span>
    );
  }
  return (
    <span className={cn(AVATAR_BOX, payeeColorClass(payee), className)} aria-hidden>
      {letter}
    </span>
  );
}

/**
 * Tiny circle for a payee. With `iconUrl` it shows the downloaded favicon
 * (falling back to the initial if the image fails); otherwise the initial on a
 * deterministic pastel background. Transfer rows use a muted arrows glyph. The
 * base is server-compatible — only the icon path pulls in a small client child.
 */
export function PayeeAvatar({
  payee,
  transfer = false,
  iconUrl,
  className,
}: {
  payee: string;
  transfer?: boolean;
  iconUrl?: string;
  className?: string;
}) {
  if (transfer) {
    return (
      <span className={cn(AVATAR_BOX, "bg-muted text-muted-foreground", className)} aria-hidden>
        <ArrowLeftRight className="size-2.5" />
      </span>
    );
  }

  const fallback = letterAvatar(payee, className);
  if (iconUrl) {
    return <PayeeAvatarImage iconUrl={iconUrl} fallback={fallback} className={className} />;
  }
  return fallback;
}
