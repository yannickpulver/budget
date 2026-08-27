"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
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
import { BarChart3, ChevronRight, GripVertical, PiggyBank, Tags, Wallet } from "lucide-react";
import { useState, useTransition } from "react";
import {
  hideAccountFromMonthAction,
  reorderAccountsAction,
  unhideAccountAction,
} from "@/app/accounts/actions";
import { AddAccountDialog } from "@/app/accounts/add-account-dialog";
import { AccountIcon } from "@/components/account-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { UndoButtons } from "@/components/undo-buttons";
import { isAccountHiddenForMonth, monthFromPathname } from "@/lib/budget-math";
import { formatMoney } from "@/lib/currency";
import type { AccountBalance, SidebarData } from "@/lib/queries";
import type { UndoState } from "@/lib/undo";
import { cn } from "@/lib/utils";

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** YYYY-MM -> "July 2026" (matches the budget page header format). */
function monthLabel(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return `${MONTH_NAMES[mon - 1]} ${year}`;
}

function balanceClass(value: number): string {
  return value < 0 ? "text-red-600" : "text-foreground";
}

type Section = "budget" | "giftcards" | "tracking";

/**
 * Desktop sidebar shell. Below `md` it's gone entirely — the same
 * {@link SidebarContent} renders inside the mobile top bar's slide-in sheet.
 */
export function Sidebar({ data, undo }: { data: SidebarData; undo: UndoState }) {
  return (
    // Sticky + h-screen so the sidebar stays put while the main list scrolls;
    // the nav inside is the scroll container for long account lists.
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
      <SidebarContent data={data} undo={undo} />
    </aside>
  );
}

/**
 * Everything inside the sidebar: nav links, the reorderable account groups and
 * the net-worth footer. A fragment, so its parent (the `<aside>` on desktop, a
 * sheet panel on mobile) owns the column layout.
 */
export function SidebarContent({
  data: initialData,
  undo,
}: {
  data: SidebarData;
  undo: UndoState;
}) {
  const pathname = usePathname();
  // The sidebar mirrors the month the user is viewing on the budget page so
  // "hidden from <month> on" takes effect exactly there; anywhere else we fall
  // back to the current month.
  const viewedMonth = monthFromPathname(pathname) ?? currentMonthKey();
  const [closedOpen, setClosedOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
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

  // Accounts hidden for the viewed month are pulled out of their groups (but
  // stay in their group's subtotal — see AccountGroup) and collected here.
  const hidden = [...data.budget, ...data.giftcards, ...data.tracking].filter((a) =>
    isAccountHiddenForMonth(a.hiddenFrom, viewedMonth)
  );

  function reorderSection(section: Section, nextAccounts: AccountBalance[]) {
    setData((prev) => ({ ...prev, [section]: nextAccounts }));
    startTransition(async () => {
      await reorderAccountsAction(nextAccounts.map((a) => a.id));
    });
  }

  return (
    <>
      <div className="flex items-center justify-between px-4 py-4">
        <span className="text-sm font-semibold tracking-tight">budget</span>
        <UndoButtons state={undo} />
      </div>

      <nav className="scrollbar-none flex-1 overflow-y-auto px-2 pb-3">
        <SidebarLink href={`/budget/${currentMonthKey()}`} active={pathname.startsWith("/budget")}>
          <Wallet className="size-4" />
          Budget
        </SidebarLink>
        <SidebarLink href="/settings/categories" active={pathname.startsWith("/settings/categories")}>
          <Tags className="size-4" />
          Categories
        </SidebarLink>
        <SidebarLink href="/stats" active={pathname.startsWith("/stats")}>
          <BarChart3 className="size-4" />
          Stats
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
          viewedMonth={viewedMonth}
          pathname={pathname}
          onReorder={(next) => reorderSection("budget", next)}
        />
        <AccountGroup
          title="Giftcards"
          accounts={data.giftcards}
          total={data.giftcardsTotal}
          viewedMonth={viewedMonth}
          pathname={pathname}
          onReorder={(next) => reorderSection("giftcards", next)}
        />
        <AccountGroup
          title="Tracking"
          accounts={data.tracking}
          total={data.trackingTotal}
          viewedMonth={viewedMonth}
          pathname={pathname}
          onReorder={(next) => reorderSection("tracking", next)}
        />

        {hidden.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setHiddenOpen((o) => !o)}
              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn("size-3 transition-transform", hiddenOpen && "rotate-90")} />
              Hidden ({hidden.length})
            </button>
            {hiddenOpen && (
              <div className="mt-0.5">
                {hidden.map((account) => (
                  <AccountContextMenu key={account.id} account={account} viewedMonth={viewedMonth}>
                    <AccountRow account={account} active={pathname === `/accounts/${account.id}`} />
                  </AccountContextMenu>
                ))}
              </div>
            )}
          </div>
        )}

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
    </>
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
  viewedMonth,
  pathname,
  onReorder,
}: {
  title: string;
  accounts: AccountBalance[];
  total: number;
  viewedMonth: string;
  pathname: string;
  onReorder: (nextAccounts: AccountBalance[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Touch needs hold-to-drag, or every attempt to scroll the account list
    // would start a reorder instead.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Rows hidden for the viewed month drop out of the group (they render in the
  // "Hidden" section instead). The subtotal deliberately still sums ALL of the
  // group's accounts — hiding is display-only and must not diverge from the
  // budget math, which counts hidden accounts' balances too.
  const visible = accounts.filter((a) => !isAccountHiddenForMonth(a.hiddenFrom, viewedMonth));
  const hidden = accounts.filter((a) => isAccountHiddenForMonth(a.hiddenFrom, viewedMonth));

  if (visible.length === 0) return null;

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = visible.findIndex((a) => a.id === active.id);
    const newIndex = visible.findIndex((a) => a.id === over.id);
    // Persist the reordered visible rows plus the hidden ones (kept at the end)
    // so the section's full membership survives the write.
    onReorder([...arrayMove(visible, oldIndex, newIndex), ...hidden]);
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
        <SortableContext items={visible.map((a) => a.id)} strategy={verticalListSortingStrategy}>
          <div>
            {visible.map((account) => (
              <SortableAccountRow
                key={account.id}
                account={account}
                active={pathname === `/accounts/${account.id}`}
                viewedMonth={viewedMonth}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

/**
 * Right-click wrapper for account rows: hide the account from the viewed month
 * on, or unhide it. Right-click only — left-click navigation and drag-reorder
 * are untouched.
 */
function AccountContextMenu({
  account,
  viewedMonth,
  className,
  children,
}: {
  account: AccountBalance;
  viewedMonth: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [, startTransition] = useTransition();
  const hidden = isAccountHiddenForMonth(account.hiddenFrom, viewedMonth);

  return (
    <ContextMenu>
      <ContextMenuTrigger className={className}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {hidden ? (
          <ContextMenuItem
            onClick={() => startTransition(() => void unhideAccountAction(account.id))}
          >
            Unhide
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            onClick={() =>
              startTransition(() => void hideAccountFromMonthAction(account.id, viewedMonth))
            }
          >
            Hide from {monthLabel(viewedMonth)} on
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Draggable row for the reorderable sections — grip handle appears on hover, the row itself stays a plain nav link. */
function SortableAccountRow({
  account,
  active,
  viewedMonth,
}: {
  account: AccountBalance;
  active: boolean;
  viewedMonth: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: account.id,
  });

  // The context menu lives INSIDE the sortable node so its DOM parent stays the
  // list container — dnd-kit's restrictToParentElement measures the dragging
  // node's parentElement, so an extra wrapper here would clamp the drag range.
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("group", isDragging && "relative z-10 opacity-70")}
    >
      <AccountContextMenu
        account={account}
        viewedMonth={viewedMonth}
        className="flex items-center gap-0.5"
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="flex size-4 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground active:cursor-grabbing pointer-coarse:opacity-100"
          aria-label={`Drag to reorder ${account.name}`}
        >
          <GripVertical className="size-3" />
        </button>
        <AccountRow account={account} active={active} className="flex-1 pl-1.5" />
      </AccountContextMenu>
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
