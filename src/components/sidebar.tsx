"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, GripVertical, PiggyBank, Tags, Wallet } from "lucide-react";
import { useState, useTransition } from "react";
import { reorderAccountsAction } from "@/app/accounts/actions";
import { AddAccountDialog } from "@/app/accounts/add-account-dialog";
import { AccountIcon } from "@/components/account-icon";
import { formatMoney } from "@/lib/currency";
import type { AccountBalance, SidebarData } from "@/lib/queries";
import { cn } from "@/lib/utils";

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function balanceClass(value: number): string {
  return value < 0 ? "text-red-600" : "text-foreground";
}

type Section = "budget" | "giftcards" | "tracking";

export function Sidebar({ data: initialData }: { data: SidebarData }) {
  const pathname = usePathname();
  const [closedOpen, setClosedOpen] = useState(false);
  const [data, setData] = useState(initialData);
  // Re-sync local (optimistically reordered) state whenever the server sends
  // fresh props, e.g. after another tab's edit — the "adjust state during
  // render" pattern, mirrors categories-editor.tsx, so this doesn't need an
  // effect.
  const [syncedData, setSyncedData] = useState(initialData);
  if (initialData !== syncedData) {
    setSyncedData(initialData);
    setData(initialData);
  }
  const [, startTransition] = useTransition();

  const hasAnyAccounts =
    data.budget.length > 0 ||
    data.giftcards.length > 0 ||
    data.tracking.length > 0 ||
    data.closed.length > 0;

  function reorderSection(section: Section, nextAccounts: AccountBalance[]) {
    setData((prev) => ({ ...prev, [section]: nextAccounts }));
    startTransition(async () => {
      await reorderAccountsAction(nextAccounts.map((a) => a.id));
    });
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="px-4 py-4 text-sm font-semibold tracking-tight">budget</div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        <SidebarLink href={`/budget/${currentMonthKey()}`} active={pathname.startsWith("/budget")}>
          <Wallet className="size-4" />
          Budget
        </SidebarLink>
        <SidebarLink href="/settings/categories" active={pathname.startsWith("/settings/categories")}>
          <Tags className="size-4" />
          Categories
        </SidebarLink>

        {!hasAnyAccounts && (
          <div className="mx-1 mt-4 rounded-md border border-dashed border-border p-3 text-center">
            <PiggyBank className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-1.5 text-xs font-medium">No accounts yet</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Add your first account to start budgeting.
            </p>
          </div>
        )}

        <AccountGroup
          title="Budget"
          accounts={data.budget}
          total={data.budgetTotal}
          pathname={pathname}
          onReorder={(next) => reorderSection("budget", next)}
        />
        <AccountGroup
          title="Giftcards"
          accounts={data.giftcards}
          total={data.giftcardsTotal}
          pathname={pathname}
          onReorder={(next) => reorderSection("giftcards", next)}
        />
        <AccountGroup
          title="Tracking"
          accounts={data.tracking}
          total={data.trackingTotal}
          pathname={pathname}
          onReorder={(next) => reorderSection("tracking", next)}
        />

        {data.closed.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setClosedOpen((o) => !o)}
              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn("size-3 transition-transform", closedOpen && "rotate-90")} />
              Closed ({data.closed.length})
            </button>
            {closedOpen && (
              <div className="mt-0.5">
                {data.closed.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    active={pathname === `/accounts/${account.id}`}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-4">
          <AddAccountDialog />
        </div>
      </nav>

      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center justify-between text-sm font-medium">
          <span>Net worth</span>
          <span className={cn("tabular-nums", balanceClass(data.netWorth))}>
            {formatMoney(data.netWorth)}
          </span>
        </div>
      </div>
    </aside>
  );
}

function SidebarLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {children}
    </Link>
  );
}

function AccountGroup({
  title,
  accounts,
  total,
  pathname,
  onReorder,
}: {
  title: string;
  accounts: AccountBalance[];
  total: number;
  pathname: string;
  onReorder: (nextAccounts: AccountBalance[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  if (accounts.length === 0) return null;

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = accounts.findIndex((a) => a.id === active.id);
    const newIndex = accounts.findIndex((a) => a.id === over.id);
    onReorder(arrayMove(accounts, oldIndex, newIndex));
  }

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground uppercase">
        <span>{title}</span>
        <span className={cn("tabular-nums", balanceClass(total))}>{formatMoney(total)}</span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      >
        <SortableContext items={accounts.map((a) => a.id)} strategy={verticalListSortingStrategy}>
          <div>
            {accounts.map((account) => (
              <SortableAccountRow
                key={account.id}
                account={account}
                active={pathname === `/accounts/${account.id}`}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

/** Draggable row for the reorderable sections — grip handle appears on hover, the row itself stays a plain nav link. */
function SortableAccountRow({ account, active }: { account: AccountBalance; active: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: account.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("group flex items-center gap-0.5", isDragging && "relative z-10 opacity-70")}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="flex size-4 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground active:cursor-grabbing"
        aria-label={`Drag to reorder ${account.name}`}
      >
        <GripVertical className="size-3" />
      </button>
      <AccountRow account={account} active={active} className="flex-1 pl-1.5" />
    </div>
  );
}

function AccountRow({
  account,
  active,
  className,
}: {
  account: AccountBalance;
  active: boolean;
  className?: string;
}) {
  return (
    <Link
      href={`/accounts/${account.id}`}
      className={cn(
        "flex min-w-0 items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm",
        active ? "bg-muted font-medium text-foreground" : "text-foreground/80 hover:bg-muted hover:text-foreground",
        className
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <AccountIcon type={account.type} icon={account.icon} />
        <span className="truncate">{account.name}</span>
      </span>
      <span className={cn("shrink-0 tabular-nums", balanceClass(account.balance))}>
        {formatMoney(account.balance)}
      </span>
    </Link>
  );
}
