import { requireApiToken, json } from "@/lib/api-auth";
import { db } from "@/db";
import { getPayeeSuggestions } from "@/lib/queries";

/** GET /api/v1/payees — distinct payee names for autocomplete. */
export async function GET(req: Request): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;

  return json({ payees: getPayeeSuggestions(db) });
}
