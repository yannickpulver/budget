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
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, GripVertical, Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CategoryAdmin, CategoryGroupAdmin } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  type ActionResult,
  createCategoryAction,
  createCategoryGroupAction,
  deleteCategoryAction,
  deleteCategoryGroupAction,
  moveCategoryToGroupAction,
  renameCategoryAction,
  renameCategoryGroupAction,
  reorderCategoriesAction,
  reorderCategoryGroupsAction,
  setCategoryGroupHiddenAction,
  setCategoryHiddenAction,
} from "./actions";

export function CategoriesEditor({ groups: initialGroups }: { groups: CategoryGroupAdmin[] }) {
  const [groups, setGroups] = useState(initialGroups);
  // Re-sync local (optimistically reordered) state whenever the server sends
  // fresh props, e.g. after another tab's edit — the "adjust state during
  // render" pattern, so this doesn't need an effect.
  const [syncedGroups, setSyncedGroups] = useState(initialGroups);
  if (initialGroups !== syncedGroups) {
    setSyncedGroups(initialGroups);
    setGroups(initialGroups);
  }
  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleGroupDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setGroups((prev) => {
      const oldIndex = prev.findIndex((g) => g.id === active.id);
      const newIndex = prev.findIndex((g) => g.id === over.id);
      const next = arrayMove(prev, oldIndex, newIndex);
      startTransition(async () => {
        await reorderCategoryGroupsAction(next.map((g) => g.id));
      });
      return next;
    });
  }

  function handleCategoriesReordered(groupId: number, nextCategories: CategoryAdmin[]) {
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, categories: nextCategories } : g)));
    startTransition(async () => {
      await reorderCategoriesAction(groupId, nextCategories.map((c) => c.id));
    });
  }

  function handleCategoryMoved(categoryId: number, fromGroupId: number, toGroupId: number) {
    setGroups((prev) => {
      const fromGroup = prev.find((g) => g.id === fromGroupId);
      const category = fromGroup?.categories.find((c) => c.id === categoryId);
      if (!category) return prev;
      return prev.map((g) => {
        if (g.id === fromGroupId) return { ...g, categories: g.categories.filter((c) => c.id !== categoryId) };
        if (g.id === toGroupId) return { ...g, categories: [...g.categories, category] };
        return g;
      });
    });
    startTransition(async () => {
      await moveCategoryToGroupAction(categoryId, toGroupId);
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGroupDragEnd}>
        <SortableContext items={groups.map((g) => g.id)} strategy={verticalListSortingStrategy}>
          <div className="divide-y divide-border rounded-lg border border-border">
            {groups.map((group) => (
              <GroupBlock
                key={group.id}
                group={group}
                allGroups={groups}
                onCategoriesReordered={handleCategoriesReordered}
                onCategoryMoved={handleCategoryMoved}
              />
            ))}
            {groups.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No category groups yet — add one below.
              </div>
            )}
          </div>
        </SortableContext>
      </DndContext>
      <AddGroupForm />
    </div>
  );
}

function GroupBlock({
  group,
  allGroups,
  onCategoriesReordered,
  onCategoryMoved,
}: {
  group: CategoryGroupAdmin;
  allGroups: CategoryGroupAdmin[];
  onCategoriesReordered: (groupId: number, nextCategories: CategoryAdmin[]) => void;
  onCategoryMoved: (categoryId: number, fromGroupId: number, toGroupId: number) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: group.id });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleCategoryDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = group.categories.findIndex((c) => c.id === active.id);
    const newIndex = group.categories.findIndex((c) => c.id === over.id);
    onCategoriesReordered(group.id, arrayMove(group.categories, oldIndex, newIndex));
  }

  function toggleHidden() {
    setError(null);
    startTransition(async () => {
      await setCategoryGroupHiddenAction(group.id, !group.hidden);
    });
  }

  function remove() {
    if (!confirm(`Delete group "${group.name}"?`)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteCategoryGroupAction(group.id);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("p-3", (pending || isDragging) && "opacity-60")}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="flex shrink-0 cursor-grab touch-none items-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
            aria-label={`Drag to reorder group ${group.name}`}
          >
            <GripVertical className="size-3.5" />
          </button>
          <EditableName
            value={group.name}
            className="text-sm font-semibold"
            onSave={(name) => renameCategoryGroupAction(group.id, name)}
          />
        </div>
        <div className="flex items-center gap-1">
          {group.hidden && <span className="text-xs text-muted-foreground">Hidden</span>}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={toggleHidden}
            disabled={pending}
            title={group.hidden ? "Show group" : "Hide group"}
          >
            {group.hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={remove}
            disabled={pending || group.categories.length > 0}
            title={group.categories.length > 0 ? "Remove its categories first" : "Delete group"}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}

      <div className="mt-2 flex flex-col gap-0.5 pl-3">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleCategoryDragEnd}>
          <SortableContext items={group.categories.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            {group.categories.map((category) => (
              <CategoryBlock
                key={category.id}
                category={category}
                group={group}
                allGroups={allGroups}
                onMove={onCategoryMoved}
              />
            ))}
          </SortableContext>
        </DndContext>
        <AddCategoryForm groupId={group.id} />
      </div>
    </div>
  );
}

function CategoryBlock({
  category,
  group,
  allGroups,
  onMove,
}: {
  category: CategoryAdmin;
  group: CategoryGroupAdmin;
  allGroups: CategoryGroupAdmin[];
  onMove: (categoryId: number, fromGroupId: number, toGroupId: number) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: category.id });

  const otherGroups = allGroups.filter((g) => g.id !== group.id);

  function toggleHidden() {
    setError(null);
    startTransition(async () => {
      await setCategoryHiddenAction(category.id, !category.hidden);
    });
  }

  function remove() {
    if (!confirm(`Delete category "${category.name}"?`)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteCategoryAction(category.id);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm",
        (pending || isDragging) && "opacity-60",
        category.hidden && "text-muted-foreground"
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="flex shrink-0 cursor-grab touch-none items-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
          aria-label={`Drag to reorder category ${category.name}`}
        >
          <GripVertical className="size-3.5" />
        </button>
        <EditableName value={category.name} onSave={(name) => renameCategoryAction(category.id, name)} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {error && <span className="text-xs text-destructive">{error}</span>}
        {category.hidden && <span className="text-xs text-muted-foreground">Hidden</span>}
        {otherGroups.length > 0 && (
          <Select
            value=""
            onValueChange={(groupId) => {
              if (!groupId) return;
              onMove(category.id, group.id, Number(groupId));
            }}
          >
            <SelectTrigger size="sm" className="h-6 max-w-28 border-none bg-transparent px-1.5 text-xs shadow-none hover:bg-muted">
              <SelectValue placeholder="Move to…" />
            </SelectTrigger>
            <SelectContent>
              {otherGroups.map((g) => (
                <SelectItem key={g.id} value={String(g.id)}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={toggleHidden}
          disabled={pending}
          title={category.hidden ? "Show category" : "Hide category"}
        >
          {category.hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={remove}
          disabled={pending || category.referenced}
          title={category.referenced ? "In use — hide instead" : "Delete category"}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function EditableName({
  value,
  className,
  onSave,
}: {
  value: string;
  className?: string;
  onSave: (name: string) => Promise<ActionResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function save() {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === value) {
      setName(value);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await onSave(trimmed);
      if (!result.ok) {
        setError(result.error);
        setName(value);
      }
    });
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            setName(value);
            setEditing(false);
          }
        }}
        className="h-7 max-w-56"
      />
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn("truncate rounded-md px-1 -mx-1 text-left hover:bg-muted", className)}
      >
        {value}
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function AddGroupForm() {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      const result = await createCategoryGroupAction(trimmed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder="New group name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        className="h-8 max-w-56"
      />
      <Button size="sm" variant="outline" onClick={submit} disabled={pending || !name.trim()}>
        <Plus className="size-3.5" />
        Add group
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function AddCategoryForm({ groupId }: { groupId: number }) {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      const result = await createCategoryAction(groupId, trimmed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
    });
  }

  return (
    <div className="flex items-center gap-2 py-0.5">
      <Input
        placeholder="New category name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        className="h-7 max-w-56 text-sm"
      />
      <Button size="icon-xs" variant="ghost" onClick={submit} disabled={pending || !name.trim()} title="Add category">
        <Plus className="size-3.5" />
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
