"use client";

import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CategoryGroupAdmin } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  type ActionResult,
  createCategoryAction,
  createCategoryGroupAction,
  deleteCategoryAction,
  deleteCategoryGroupAction,
  renameCategoryAction,
  renameCategoryGroupAction,
  setCategoryGroupHiddenAction,
  setCategoryHiddenAction,
} from "./actions";

export function CategoriesEditor({ groups }: { groups: CategoryGroupAdmin[] }) {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="divide-y divide-border rounded-lg border border-border">
        {groups.map((group) => (
          <GroupBlock key={group.id} group={group} />
        ))}
        {groups.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No category groups yet — add one below.
          </div>
        )}
      </div>
      <AddGroupForm />
    </div>
  );
}

function GroupBlock({ group }: { group: CategoryGroupAdmin }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
    <div className={cn("p-3", pending && "opacity-60")}>
      <div className="flex items-center justify-between gap-2">
        <EditableName
          value={group.name}
          className="text-sm font-semibold"
          onSave={(name) => renameCategoryGroupAction(group.id, name)}
        />
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
        {group.categories.map((category) => (
          <CategoryBlock key={category.id} category={category} />
        ))}
        <AddCategoryForm groupId={group.id} />
      </div>
    </div>
  );
}

function CategoryBlock({ category }: { category: CategoryGroupAdmin["categories"][number] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm",
        pending && "opacity-60",
        category.hidden && "text-muted-foreground"
      )}
    >
      <EditableName value={category.name} onSave={(name) => renameCategoryAction(category.id, name)} />
      <div className="flex shrink-0 items-center gap-1">
        {error && <span className="text-xs text-destructive">{error}</span>}
        {category.hidden && <span className="text-xs text-muted-foreground">Hidden</span>}
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
