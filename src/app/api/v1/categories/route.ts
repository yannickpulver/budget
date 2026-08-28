import { requireApiToken, json } from "@/lib/api-auth";
import { db } from "@/db";
import { currentMonth, getBudgetView, getCurrency } from "@/lib/queries";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** GET /api/v1/categories?month=YYYY-MM — flattened categories for one budget month. */
export async function GET(req: Request): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;

  const month = new URL(req.url).searchParams.get("month") ?? currentMonth();
  if (!MONTH_RE.test(month)) return json({ error: "Invalid month." }, 400);

  const view = getBudgetView(month);
  const categories = view.groups.flatMap((group) =>
    group.categories.map((c) => ({
      id: c.id,
      group: group.name,
      name: c.name,
      assigned: c.assigned,
      activity: c.activity,
      available: c.available,
    }))
  );

  return json({ month, currency: getCurrency(db), readyToAssign: view.readyToAssign, categories });
}
