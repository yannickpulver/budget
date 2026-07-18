"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CategoryGroupOption, TransferTarget } from "@/lib/queries";
import { CategorySelect } from "./category-select";

export type CategorySelection =
  | { kind: "rta" }
  | { kind: "category"; categoryId: number }
  | { kind: "transfer"; accountId: number; categoryId: number | null };

function encode(value: CategorySelection): string {
  if (value.kind === "rta") return "rta";
  if (value.kind === "category") return `cat:${value.categoryId}`;
  return `xfer:${value.accountId}`;
}

/**
 * Category picker for new transactions: Ready to Assign, real categories, or a
 * transfer target account. When the chosen transfer target is a tracking
 * account, a second (required) category select appears — YNAB categorizes the
 * on-budget leg of a transfer to/from tracking money.
 */
export function CategoryTransferSelect({
  groups,
  transferTargets,
  value,
  onChange,
}: {
  groups: CategoryGroupOption[];
  transferTargets: TransferTarget[];
  value: CategorySelection;
  onChange: (value: CategorySelection) => void;
}) {
  function onPrimaryChange(raw: string | null) {
    if (!raw || raw === "rta") {
      onChange({ kind: "rta" });
    } else if (raw.startsWith("cat:")) {
      onChange({ kind: "category", categoryId: Number(raw.slice(4)) });
    } else if (raw.startsWith("xfer:")) {
      onChange({ kind: "transfer", accountId: Number(raw.slice(5)), categoryId: null });
    }
  }

  const transferTarget =
    value.kind === "transfer" ? transferTargets.find((a) => a.id === value.accountId) : undefined;
  const needsLinkedCategory = value.kind === "transfer" && transferTarget?.type === "tracking";

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select value={encode(value)} onValueChange={onPrimaryChange}>
        <SelectTrigger className="w-full min-w-0">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="rta">Ready to Assign</SelectItem>
          </SelectGroup>
          {groups.map((group) => (
            <SelectGroup key={group.id}>
              <SelectLabel>{group.name}</SelectLabel>
              {group.categories.map((category) => (
                <SelectItem key={category.id} value={`cat:${category.id}`}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          {transferTargets.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Transfer to/from account</SelectLabel>
                {transferTargets.map((account) => (
                  <SelectItem key={account.id} value={`xfer:${account.id}`}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>

      {needsLinkedCategory && (
        <CategorySelect
          groups={groups}
          value={value.kind === "transfer" ? value.categoryId : null}
          onChange={(categoryId) =>
            onChange({ kind: "transfer", accountId: transferTarget!.id, categoryId })
          }
          placeholder="Budget category"
          className="w-full min-w-0"
        />
      )}
    </div>
  );
}
