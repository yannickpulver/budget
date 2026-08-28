import { requireApiToken, fromActionResult, json, parseBody } from "@/lib/api-auth";
import { createTransferAction, type TransferFormInput } from "@/app/accounts/actions";

function toInput(body: unknown): TransferFormInput | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Number.isFinite(b.fromAccountId)) return null;
  if (!Number.isFinite(b.toAccountId)) return null;
  if (typeof b.amount !== "number") return null;
  if (typeof b.date !== "string") return null;
  if (b.categoryId !== null && b.categoryId !== undefined && typeof b.categoryId !== "number") return null;

  return {
    fromAccountId: b.fromAccountId as number,
    toAccountId: b.toAccountId as number,
    amount: b.amount,
    date: b.date,
    memo: typeof b.memo === "string" ? b.memo : "",
    cleared: typeof b.cleared === "boolean" ? b.cleared : false,
    categoryId: typeof b.categoryId === "number" ? b.categoryId : null,
  };
}

/** POST /api/v1/transfers — create a transfer between two accounts (see `TransferFormInput`). */
export async function POST(req: Request): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;

  const input = toInput(await parseBody(req));
  if (!input) return json({ error: "Invalid request body." }, 400);

  return fromActionResult(await createTransferAction(input));
}
