import fs from "node:fs";
import path from "node:path";

/**
 * Serves a downloaded payee favicon by its key (see lib/payee-icons.ts). The
 * key is validated to be exactly 16 lowercase hex chars, so this can only ever
 * read files inside data/payee-icons/ — never an arbitrary path. 404 when no
 * icon exists for the key.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> }
): Promise<Response> {
  const { key } = await params;
  if (!/^[a-f0-9]{16}$/.test(key)) {
    return new Response("Not found", { status: 404 });
  }

  const dir = path.join(process.cwd(), "data", "payee-icons");
  for (const ext of ["png", "ico"] as const) {
    const file = path.join(dir, `${key}.${ext}`);
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": ext === "png" ? "image/png" : "image/x-icon",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
  }

  return new Response("Not found", { status: 404 });
}
