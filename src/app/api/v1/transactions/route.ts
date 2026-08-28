import { requireApiToken, fromActionResult, json, parseBody } from "@/lib/api-auth";
import { createTransactionAction, type TransactionFormInput } from "@/app/accounts/actions";

function toInput(body: unknown): TransactionFormInput | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Number.isFinite(b.accountId)) return null;
  if (typeof b.amount !== "number") return null;
  if (typeof b.date !== "string") return null;
  if (b.categoryId !== null && b.categoryId !== undefined && typeof b.categoryId !== "number") return null;

  return {
    accountId: b.accountId as number,
    amount: b.amount,
    date: b.date,
    payee: typeof b.payee === "string" ? b.payee : "",
    memo: typeof b.memo === "string" ? b.memo : "",
    cleared: typeof b.cleared === "boolean" ? b.cleared : false,
    categoryId: typeof b.categoryId === "number" ? b.categoryId : null,
  };
}

/** POST /api/v1/transactions — create a plain transaction (see `TransactionFormInput`). */
export async function POST(req: Request): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;

  const input = toInput(await parseBody(req));
  if (!input) return json({ error: "Invalid request body." }, 400);

  return fromActionResult(await createTransactionAction(input));
}
