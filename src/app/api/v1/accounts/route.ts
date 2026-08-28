import { requireApiToken, json } from "@/lib/api-auth";
import { db } from "@/db";
import { getCurrency, listAccountBalances } from "@/lib/queries";

/** GET /api/v1/accounts — open accounts by default; `?all=1` includes closed ones. */
export async function GET(req: Request): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;

  const includeClosed = new URL(req.url).searchParams.get("all") === "1";
  const accounts = listAccountBalances(db).filter((a) => includeClosed || !a.closed);

  return json({ currency: getCurrency(db), accounts });
}
