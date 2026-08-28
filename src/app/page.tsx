import { redirect } from "next/navigation";

// The redirect target is the current month, so it must be computed per
// request — a static prerender would freeze it at build time.
export const dynamic = "force-dynamic";

export default function Home() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  redirect(`/budget/${month}`);
}
