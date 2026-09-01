import { requireApiToken, fromActionResult, json, parseBody } from "@/lib/api-auth";
import { db } from "@/db";
import { getTransactionById, type TransactionEditInput } from "@/lib/queries";
import { updateTransactionAction } from "@/app/accounts/actions";

type Patch = Partial<TransactionEditInput>;

function toPatch(body: unknown): Patch | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const patch: Patch = {};

  if (Object.hasOwn(b, "date")) {
    if (typeof b.date !== "string") return null;
    patch.date = b.date;
  }
  if (Object.hasOwn(b, "payee")) {
    if (typeof b.payee !== "string") return null;
    patch.payee = b.payee;
  }
  if (Object.hasOwn(b, "memo")) {
    if (typeof b.memo !== "string") return null;
    patch.memo = b.memo;
  }
  if (Object.hasOwn(b, "amount")) {
    if (typeof b.amount !== "number") return null;
    patch.amount = b.amount;
  }
  if (Object.hasOwn(b, "cleared")) {
    if (typeof b.cleared !== "boolean") return null;
    patch.cleared = b.cleared;
  }
  if (Object.hasOwn(b, "categoryId")) {
    if (b.categoryId !== null && typeof b.categoryId !== "number") return null;
    patch.categoryId = b.categoryId;
  }

  return patch;
}

/** GET /api/v1/transactions/:id — one transaction with its account/category/transfer names. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) return json({ error: "Transaction not found" }, 404);

  const row = getTransactionById(id, db);
  if (!row) return json({ error: "Transaction not found" }, 404);

  return json(row);
}

/** PATCH /api/v1/transactions/:id — update any subset of the row's fields; `categoryId: null` clears it. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) return json({ error: "Transaction not found" }, 404);

  const patch = toPatch(await parseBody(req));
  if (!patch) return json({ error: "Invalid request body." }, 400);
  if (Object.keys(patch).length === 0) return json({ error: "No fields to update." }, 400);

  const row = getTransactionById(id, db);
  if (!row) return json({ error: "Transaction not found" }, 404);
  if (row.transferAccountId !== null && Object.hasOwn(patch, "payee")) {
    return json({ error: "Cannot change a transfer's payee." }, 400);
  }

  const merged: TransactionEditInput = {
    date: patch.date ?? row.date,
    payee: patch.payee ?? row.payee,
    memo: patch.memo ?? row.memo,
    amount: patch.amount ?? row.amount,
    cleared: patch.cleared ?? row.cleared,
    categoryId: Object.hasOwn(patch, "categoryId") ? (patch.categoryId ?? null) : row.categoryId,
  };

  return fromActionResult(await updateTransactionAction(id, row.accountId, row.transferAccountId, merged));
}
