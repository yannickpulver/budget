import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Link-based period navigator: prev / label / next, an optional "jump to now"
 * shortcut and an optional mode toggle (Month / Year / All). Every control is
 * an <a>, so this stays a server component with zero client JS — the same
 * cluster the budget month header has always used, lifted out so /stats and
 * /budget navigate identically.
 */
export function PeriodNav({
  label,
  prevHref,
  nextHref,
  jumpHref,
  jumpLabel = "Today",
  modes,
  prevAriaLabel = "Previous period",
  nextAriaLabel = "Next period",
  labelClassName,
  className,
}: {
  label: string;
  /** null renders the arrow disabled instead of hiding it. */
  prevHref: string | null;
  nextHref: string | null;
  /** Omit or pass null to hide the shortcut (e.g. already on the current period). */
  jumpHref?: string | null;
  jumpLabel?: string;
  modes?: { key: string; label: string; href: string; active: boolean }[];
  prevAriaLabel?: string;
  nextAriaLabel?: string;
  /** Merged over the label defaults, so callers can set their own size/width. */
  labelClassName?: string;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      <NavArrow href={prevHref} label={prevAriaLabel}>
        <ChevronLeft className="size-4" />
      </NavArrow>
      {/* No min width on a phone — 8rem of empty label box crowds out the
          arrows and the "Today" shortcut at 390px. */}
      {/* Never wrapped: "August 2026" broken across two lines makes the whole
          cluster two rows tall. If something has to move to a second line it
          is the mode pills, via the wrapping root. */}
      <div className={cn("text-center text-sm font-medium whitespace-nowrap md:min-w-32", labelClassName)}>
        {label}
      </div>
      <NavArrow href={nextHref} label={nextAriaLabel}>
        <ChevronRight className="size-4" />
      </NavArrow>

      {jumpHref != null && (
        <Link
          href={jumpHref}
          className="ml-1 rounded-md px-2 py-1 text-xs whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {jumpLabel}
        </Link>
      )}

      {modes != null && modes.length > 0 && (
        <div className="ml-2 flex items-center gap-1.5">
          {modes.map((mode) => (
            <Link
              key={mode.key}
              href={mode.href}
              aria-current={mode.active ? "page" : undefined}
              className={cn(
                "inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium transition-colors",
                mode.active
                  ? "border-transparent bg-foreground text-background hover:bg-foreground/90"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {mode.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function NavArrow({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: React.ReactNode;
}) {
  if (!href) {
    return (
      <span className="flex size-7 items-center justify-center rounded-md text-muted-foreground/40">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </Link>
  );
}
