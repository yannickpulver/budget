import { inArray } from "drizzle-orm";
import { requireApiToken, json, parseBody } from "@/lib/api-auth";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { moveMoney } from "@/app/budget/actions";
import { isValidNumber } from "@/lib/validation";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

type AssignInput = { month: string; categoryId: number; fromCategoryId: number | null; amount: number };

function toInput(body: unknown): AssignInput | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.month !== "string" || !MONTH_RE.test(b.month)) return null;
  if (!Number.isInteger(b.categoryId)) return null;
  if (b.fromCategoryId !== null && b.fromCategoryId !== undefined && !Number.isInteger(b.fromCategoryId)) return null;
  if (typeof b.amount !== "number" || !Number.isInteger(b.amount) || b.amount <= 0 || !isValidNumber(b.amount)) {
    return null;
  }

  return {
    month: b.month,
    categoryId: b.categoryId as number,
    fromCategoryId: typeof b.fromCategoryId === "number" ? b.fromCategoryId : null,
    amount: b.amount,
  };
}

/**
 * POST /api/v1/assignments — move `amount` (minor units) into a category for
 * `month`, from Ready to Assign or from `fromCategoryId`. One undo step.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;

  const input = toInput(await parseBody(req));
  if (!input) return json({ error: "Invalid request body." }, 400);
  if (input.fromCategoryId === input.categoryId) return json({ error: "Source and target are the same category." }, 400);

  const ids = [input.categoryId, ...(input.fromCategoryId === null ? [] : [input.fromCategoryId])];
  const found = db.select({ id: schema.categories.id }).from(schema.categories).where(inArray(schema.categories.id, ids)).all();
  if (found.length !== ids.length) return json({ error: "Unknown category." }, 400);

  await moveMoney(input.month, input.fromCategoryId, input.categoryId, input.amount);
  return json({ ok: true });
}
