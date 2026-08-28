/** Stored CLI config: ~/.config/budget/config.json (honors XDG_CONFIG_HOME). */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Config = { url: string; token: string; defaultAccount?: string };

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "budget", "config.json");
}

/** Config file contents, or null when there is no readable config yet. */
export function readConfigFile(): Partial<Config> | null {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as Partial<Config>;
  } catch {
    return null;
  }
}

/** Config with BUDGET_URL / BUDGET_TOKEN taking precedence over the file. */
export function loadConfig(): Config {
  const file = readConfigFile() ?? {};
  const url = process.env.BUDGET_URL ?? file.url;
  const token = process.env.BUDGET_TOKEN ?? file.token;
  if (!url || !token) throw new Error("Not logged in. Run `budget login <url>`.");
  return { url, token, defaultAccount: file.defaultAccount };
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function deleteConfig(): void {
  rmSync(configPath(), { force: true });
}
