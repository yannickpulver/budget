import { requireApiToken, json } from "@/lib/api-auth";
import { undoAction } from "@/app/undo-actions";

/** POST /api/v1/undo — undo the most recent tracked change. */
export async function POST(req: Request): Promise<Response> {
  const denied = requireApiToken(req);
  if (denied) return denied;

  return json(await undoAction());
}
