/**
 * Payee favicon fetching for register avatars.
 *
 * For each distinct payee we guess a likely domain and try to download its
 * real favicon from a public favicon service, validating that we got an
 * actual icon rather than the service's generic globe fallback. Successful
 * icons are written to disk under data/payee-icons/ and cached in the
 * `payee_icons` table; the register avatar (see components/payee-avatar.tsx)
 * uses them when present and falls back to the payee's initial otherwise.
 *
 * Like lib/prices.ts, this is one of the very few modules in the app that
 * reaches the network — the fetch is user-triggered (the "Fetch payee icons"
 * button) and nothing here runs on a normal page render. The pure helpers
 * (`guessDomains`, `payeeKey`) are unit-tested without touching the network.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "@/db";
import { dataDir } from "@/db/paths";
import * as schema from "@/db/schema";
import { getIconPayees } from "./queries";

type DB = BetterSQLite3Database<typeof schema>;

const FETCH_TIMEOUT_MS = 5000;
const MAX_ICON_BYTES = 200 * 1024;
const POLITE_DELAY_MS = 150;
const RETRY_MISS_MS = 30 * 24 * 60 * 60 * 1000; // re-fetch misses older than 30d
/**
 * Wall-clock budget for one run, so a click stays a request-sized amount of
 * work. A count cap would not bound this: a payee that misses can spend up to
 * `FETCH_TIMEOUT_MS` on each of its domain/service combinations.
 */
const MAX_RUN_MS = 60 * 1000;
/** A domain that cannot exist, used to learn each service's fallback-icon bytes. */
const PROBE_DOMAIN = "zzz-nonexistent-payee-probe-4711.ch";

/** Favicon services tried in order, each producing a URL for a domain. */
const SERVICES: ((domain: string) => string)[] = [
  (domain) => `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
];

/**
 * Directory the downloaded icon bytes live in (created on first write). Sits
 * next to the database so it lands on the persistent volume in Docker.
 */
function iconDir(): string {
  return path.join(dataDir(), "payee-icons");
}

/** Stable 16-hex-char key derived from a payee — the on-disk/URL identifier. */
export function payeeKey(payee: string): string {
  return createHash("sha256").update(payee).digest("hex").slice(0, 16);
}

/**
 * Candidate domains for a payee, Swiss-first. Lowercases, transliterates
 * common umlauts/accents, strips everything non-alphanumeric, then yields
 * `<name>.ch` and `<name>.com`. Returns [] for payees that normalize to
 * empty or look like a phone number (e.g. "+41 79 000 00 00"). Pure.
 */
export function guessDomains(payee: string): string[] {
  const trimmed = payee.trim();
  // Phone-number-like: starts with + or a digit and contains only digits and
  // phone punctuation (spaces, /, +, -, (), .). No letters -> no useful guess.
  if (trimmed !== "" && /^[+\d][\d\s/+().-]*$/.test(trimmed)) return [];

  const name = trimmed
    .toLowerCase()
    .replace(/ü/g, "ue")
    .replace(/ö/g, "oe")
    .replace(/ä/g, "ae")
    .replace(/[éè]/g, "e")
    .replace(/[^a-z0-9]/g, "");

  if (name === "" || /^\d+$/.test(name)) return [];
  return [`${name}.ch`, `${name}.com`];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Fetch a URL's bytes with a hard timeout. Null on non-200/empty/oversized/error. */
async function fetchIconBytes(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;
    return { bytes, contentType: res.headers.get("content-type") ?? "" };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Lazily learned once per process: the byte-hash of each service's fallback
// "globe" icon (returned for domains with no real favicon). Any real response
// whose hash matches is treated as a miss. `null` if the probe itself failed.
let fallbackHashes: (string | null)[] | null = null;
async function getFallbackHashes(): Promise<(string | null)[]> {
  if (!fallbackHashes) {
    fallbackHashes = await Promise.all(
      SERVICES.map(async (service) => {
        const result = await fetchIconBytes(service(PROBE_DOMAIN));
        return result ? sha256(result.bytes) : null;
      })
    );
  }
  return fallbackHashes;
}

function extFromContentType(contentType: string): "ico" | "png" {
  const c = contentType.toLowerCase();
  if (c.includes("icon") || c.includes("ico")) return "ico";
  return "png"; // png, or unknown -> default png
}

/** Try every candidate domain/service until a real (non-fallback) icon lands. */
async function downloadPayeeIcon(
  payee: string
): Promise<{ domain: string; bytes: Buffer; ext: "ico" | "png" } | null> {
  const domains = guessDomains(payee);
  if (domains.length === 0) return null;
  const fallbacks = await getFallbackHashes();

  for (const domain of domains) {
    for (let i = 0; i < SERVICES.length; i++) {
      const result = await fetchIconBytes(SERVICES[i](domain));
      if (!result) continue;
      if (fallbacks[i] && sha256(result.bytes) === fallbacks[i]) continue; // generic globe
      return { domain, bytes: result.bytes, ext: extFromContentType(result.contentType) };
    }
  }
  return null;
}

function upsertIconRow(
  dbi: DB,
  row: { payee: string; domain: string | null; status: "ok" | "none"; fetchedAt: string }
): void {
  dbi
    .insert(schema.payeeIcons)
    .values(row)
    .onConflictDoUpdate({
      target: schema.payeeIcons.payee,
      set: { domain: row.domain, status: row.status, fetchedAt: row.fetchedAt },
    })
    .run();
}

/**
 * Fetch and persist one payee's icon. On success writes the bytes to disk and
 * upserts an "ok" row; on a total miss upserts a "none" row so the payee isn't
 * retried on every click. Never throws.
 */
export async function fetchPayeeIcon(dbi: DB, payee: string): Promise<"ok" | "none"> {
  const now = new Date().toISOString();
  const icon = await downloadPayeeIcon(payee);
  if (!icon) {
    upsertIconRow(dbi, { payee, domain: null, status: "none", fetchedAt: now });
    return "none";
  }

  const dir = iconDir();
  fs.mkdirSync(dir, { recursive: true });
  const key = payeeKey(payee);
  // Drop the alternate extension so a re-fetch that changes format leaves no stale file.
  const otherExt = icon.ext === "ico" ? "png" : "ico";
  fs.rmSync(path.join(dir, `${key}.${otherExt}`), { force: true });
  fs.writeFileSync(path.join(dir, `${key}.${icon.ext}`), icon.bytes);

  upsertIconRow(dbi, { payee, domain: icon.domain, status: "ok", fetchedAt: now });
  return "ok";
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PayeeIconRefreshResult {
  fetched: number;
  missed: number;
  skipped: number;
  /** Unresolved payees left over once the per-run fetch budget ran out. */
  remaining: number;
}

/** Whether an "ok" row's bytes are actually still on disk. */
function hasIconFile(payee: string): boolean {
  const key = payeeKey(payee);
  return ["png", "ico"].some((ext) => fs.existsSync(path.join(iconDir(), `${key}.${ext}`)));
}

/**
 * Fetch icons for every distinct payee, newest-seen first, skipping ones
 * already resolved. Existing "ok" rows are skipped unless their file is gone
 * (an older build wrote icons outside the persistent volume, so the row can
 * outlive the bytes); "none" rows are skipped until the miss is 30 days old,
 * or immediately retried when `retryMisses` is set. Fetches run sequentially
 * with a small delay to stay polite to the favicon services, and stop once
 * `MAX_RUN_MS` is up; whatever is left is reported as `remaining` so the
 * caller can say another run is needed.
 */
export async function refreshPayeeIcons(
  dbi: DB,
  retryMisses = false
): Promise<PayeeIconRefreshResult> {
  const payees = getIconPayees(dbi);
  const existing = new Map(
    dbi.select().from(schema.payeeIcons).all().map((r) => [r.payee, r])
  );

  let fetched = 0;
  let missed = 0;
  let skipped = 0;
  let remaining = 0;
  const deadline = Date.now() + MAX_RUN_MS;

  for (const payee of payees) {
    const row = existing.get(payee);
    if (row?.status === "ok" && hasIconFile(payee)) {
      skipped++;
      continue;
    }
    if (row?.status === "none") {
      const staleEnough = Date.now() - new Date(row.fetchedAt).getTime() > RETRY_MISS_MS;
      if (!retryMisses && !staleEnough) {
        skipped++;
        continue;
      }
    }
    if (Date.now() >= deadline) {
      remaining++;
      continue;
    }

    const result = await fetchPayeeIcon(dbi, payee);
    if (result === "ok") fetched++;
    else missed++;
    await delay(POLITE_DELAY_MS);
  }

  return { fetched, missed, skipped, remaining };
}

/**
 * Map of payee -> icon URL for every payee with a downloaded ("ok") icon.
 * Plain object so it crosses the server/client prop boundary; the register
 * page threads it into each row's avatar.
 */
export function getPayeeIconMap(dbi: DB = db): Record<string, string> {
  const rows = dbi
    .select()
    .from(schema.payeeIcons)
    .where(eq(schema.payeeIcons.status, "ok"))
    .all();
  const map: Record<string, string> = {};
  for (const row of rows) map[row.payee] = `/api/payee-icons/${payeeKey(row.payee)}`;
  return map;
}
