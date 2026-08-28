import { requireApiToken, json } from "@/lib/api-auth";
import { db } from "@/db";
import { getAccountDetail, getAccountRegister } from "@/lib/queries";

/** GET /api/v1/accounts/:id/transactions?search=&limit= — an account's most recent register rows. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) return json({ error: "Account not found" }, 404);

  const account = getAccountDetail(id, db);
  if (!account) return json({ error: "Account not found" }, 404);

  const url = new URL(req.url);
  const search = url.searchParams.get("search") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  if (limitParam !== null && !/^[1-9]\d*$/.test(limitParam)) return json({ error: "Invalid limit." }, 400);
  const limit = limitParam === null ? 20 : Math.min(100, Math.max(1, Number(limitParam)));

  const register = getAccountRegister(id, { search }, db);

  return json({
    account: { id: account.id, name: account.name },
    total: register.total,
    rows: register.rows.slice(0, limit),
  });
}
