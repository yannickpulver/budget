import { Banknote, CreditCard, Gift, Landmark, PiggyBank, TrendingUp, type LucideIcon } from "lucide-react";
import type { AccountType } from "@/lib/budget-math";
import { cn } from "@/lib/utils";

/** Default icon per account type, shown unless the account has an emoji override. */
export const ACCOUNT_TYPE_ICONS: Record<AccountType, LucideIcon> = {
  checking: Landmark,
  savings: PiggyBank,
  cash: Banknote,
  credit: CreditCard,
  giftcard: Gift,
  tracking: TrendingUp,
};

/** Small, muted type icon — or the account's emoji override when set. */
export function AccountIcon({
  type,
  icon,
  className,
}: {
  type: AccountType;
  icon?: string | null;
  className?: string;
}) {
  if (icon) {
    return (
      <span className={cn("inline-block w-4 shrink-0 text-center leading-none", className)}>{icon}</span>
    );
  }
  const Icon = ACCOUNT_TYPE_ICONS[type];
  return <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}
