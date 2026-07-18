"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";

export function SearchBox() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get("search") ?? "");

  useEffect(() => {
    const timeout = setTimeout(() => {
      const params = new URLSearchParams(searchParams);
      if (value.trim() === "") params.delete("search");
      else params.set("search", value.trim());
      params.delete("page"); // a new search always starts back at page 1
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    }, 250);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce keyed on value only; router/pathname/searchParams are stable enough here
  }, [value]);

  return (
    <div className="relative w-64">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        placeholder="Search payee, memo, category, amount…"
        className="h-8 pl-8 text-sm"
      />
    </div>
  );
}
