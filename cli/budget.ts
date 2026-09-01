#!/usr/bin/env node
/** budget — envelope budgeting from the command line, talking to a self-hosted server. */

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Api } from "./api.ts";
import type { Config } from "./config.ts";
import { deleteConfig, loadConfig, readConfigFile, saveConfig } from "./config.ts";
import { changedFields, formatMoney, isValidIsoDate, parseMoneyInput, resolveEditAmount, table } from "./format.ts";
import { resolveName } from "./resolve.ts";

/** Injected at compile time by `bun build --define`; absent when run straight from source. */
declare const BUDGET_VERSION: string | undefined;

const version = typeof BUDGET_VERSION === "string" ? BUDGET_VERSION : "dev";

type Account = { id: number; name: string; type: string; closed: boolean; balance: number };
type AccountsResponse = { currency: string; accounts: Account[] };

type Category = { id: number; group: string; name: string; assigned: number; activity: number; available: number };
type CategoriesResponse = { month: string; currency: string; readyToAssign: number; categories: Category[] };

type TransactionRow = {
  id: number;
  date: string;
  payee: string | null;
  categoryName: string | null;
  memo: string | null;
  amount: number;
  cleared: boolean;
  transferAccountName: string | null;
};
type TransactionsResponse = { account: { id: number; name: string }; total: number; rows: TransactionRow[] };

type TransactionDetail = {
  id: number;
  accountId: number;
  accountName: string;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  cleared: boolean;
  categoryId: number | null;
  categoryName: string | null;
  transferAccountId: number | null;
  transferAccountName: string | null;
};

type UndoResponse = { ok: boolean; label?: string };

const commonOptions = { json: { type: "boolean" } } as const;

const usage = `budget — envelope budgeting from the command line

Usage: budget <command> [options]

Commands:
  login [url]                  Store the server URL and an API token
  logout                       Delete the stored config
  accounts [--all]             Accounts with balances (--all includes closed)
  categories [YYYY-MM]         Ready to Assign and what's available per category
  tx [account] [-n 20] [-s q]  Transactions of an account (default: default account)
  add <amount> <payee> [-a account] [-c category] [-d YYYY-MM-DD] [-m memo] [--inflow] [--cleared]
  edit <id> [--amount 17.50] [--inflow | --outflow] [-d YYYY-MM-DD] [-p payee] [-c category | --no-category] [-m memo] [--cleared | --uncleared]
  transfer <amount> --from <account> --to <account> [-d YYYY-MM-DD] [-m memo] [--cleared]
  undo                         Undo the last change
  version                      Print the version

Options:
  --json                       Print the result as JSON and nothing else
  -v, --version                Print the version
  -h, --help                   Show this help

BUDGET_URL and BUDGET_TOKEN override the stored config.`;

/** Client built from the stored config; throws when not logged in. */
function connect(): { api: Api; config: Config } {
  const config = loadConfig();
  return { api: new Api(config.url, config.token), config };
}

async function listAccounts(api: Api): Promise<Account[]> {
  const { accounts } = await api.get<AccountsResponse>("/accounts");
  return accounts;
}

async function resolveCategory(api: Api, query: string, month: string) {
  const { categories } = await api.get<CategoriesResponse>(`/categories?month=${encodeURIComponent(month)}`);
  const items = categories.map((category) => ({
    id: category.id,
    name: category.name,
    qualifiedName: `${category.group}/${category.name}`,
  }));
  return resolveName(items, query, "category");
}

function currentMonth(): string {
  return todayIso().slice(0, 7);
}

function todayIso(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printLines(lines: string[]): void {
  for (const line of lines) console.log(line);
}

type Prompter = {
  ask: (question: string) => Promise<string>;
  askHidden: (question: string) => Promise<string>;
  close: () => void;
};

/** One stdin session asking on stderr, so `--json` output stays clean. Hidden questions don't echo. */
function createPrompter(): Prompter {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  let muted = false;
  let closed = false;
  let pending: ((answer: string) => void) | null = null;
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
    if (!muted) process.stderr.write(text);
  };
  // Stdin ending (piped input, ^D) answers empty instead of hanging or throwing.
  rl.on("close", () => {
    closed = true;
    pending?.("");
  });

  const question = (prompt: string, hidden: boolean) =>
    closed ? Promise.resolve("") : new Promise<string>((resolve) => {
      const finish = (answer: string) => {
        pending = null;
        muted = false;
        resolve(answer.trim());
      };
      pending = finish;
      rl.question(prompt, (answer) => {
        if (hidden) process.stderr.write("\n");
        finish(answer);
      });
      muted = hidden;
    });

  return {
    ask: (prompt) => question(prompt, false),
    askHidden: (prompt) => question(prompt, true),
    close: () => rl.close(),
  };
}

async function askDefaultAccount(prompter: Prompter, accounts: Account[]): Promise<string | undefined> {
  if (accounts.length === 0) return undefined;
  process.stderr.write("\nAccounts:\n");
  accounts.forEach((account, index) => process.stderr.write(`  ${index + 1}. ${account.name}\n`));
  const answer = await prompter.ask("Default account (number, empty for none): ");
  if (answer === "") return undefined;
  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > accounts.length) {
    process.stderr.write(`Ignoring "${answer}": not an account number.\n`);
    return undefined;
  }
  return accounts[index - 1].name;
}

async function login(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: commonOptions });
  const stored = readConfigFile();
  const url = positionals[1] ?? stored?.url;
  if (!url) throw new Error("Usage: budget login <url>");

  const prompter = createPrompter();
  try {
    const token = await prompter.askHidden(`API token for ${url}: `);
    if (token === "") throw new Error("No token given.");
    const response = await new Api(url, token).get<AccountsResponse>("/accounts");
    saveConfig({ url, token, defaultAccount: stored?.defaultAccount });

    if (values.json) {
      printJson(response);
      return;
    }

    const defaultAccount = process.stdin.isTTY
      ? await askDefaultAccount(prompter, response.accounts)
      : stored?.defaultAccount;
    saveConfig({ url, token, defaultAccount });
    console.log(`Logged in to ${url}.${defaultAccount ? ` Default account: ${defaultAccount}.` : ""}`);
  } finally {
    prompter.close();
  }
}

function logout(args: string[]): void {
  const { values } = parseArgs({ args, allowPositionals: true, options: commonOptions });
  deleteConfig();
  if (values.json) printJson({ ok: true });
  else console.log("Logged out.");
}

async function accounts(args: string[]): Promise<void> {
  const options = { ...commonOptions, all: { type: "boolean" } } as const;
  const { values } = parseArgs({ args, allowPositionals: true, options });
  const { api } = connect();
  const response = await api.get<AccountsResponse>(values.all ? "/accounts?all=1" : "/accounts");
  if (values.json) return printJson(response);

  const rows = response.accounts.map((account) => [account.name, account.type, formatMoney(account.balance)]);
  printLines(table(rows, ["l", "l", "r"]));
}

async function categories(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: commonOptions });
  const month = positionals[1] ?? currentMonth();
  const { api } = connect();
  const response = await api.get<CategoriesResponse>(`/categories?month=${encodeURIComponent(month)}`);
  if (values.json) return printJson(response);

  console.log(`Ready to Assign  ${formatMoney(response.readyToAssign)}`);
  const rows = response.categories.map((category) => [`  ${category.name}`, formatMoney(category.available)]);
  const lines = table(rows, ["l", "r"]);
  let group: string | null = null;
  response.categories.forEach((category, index) => {
    if (category.group !== group) {
      group = category.group;
      console.log("");
      console.log(group);
    }
    console.log(lines[index]);
  });
}

async function transactions(args: string[]): Promise<void> {
  const options = {
    ...commonOptions,
    limit: { type: "string", short: "n" },
    search: { type: "string", short: "s" },
  } as const;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });
  if (values.limit && !/^[1-9]\d*$/.test(values.limit)) throw new Error(`Invalid count "${values.limit}".`);
  const { api, config } = connect();
  const query = positionals[1] ?? config.defaultAccount;
  if (!query) throw new Error("No account given and no default account set.");

  const account = resolveName(await listAccounts(api), query, "account");
  const params = new URLSearchParams();
  if (values.search) params.set("search", values.search);
  if (values.limit) params.set("limit", values.limit);
  const search = params.toString();
  const path = `/accounts/${account.id}/transactions${search === "" ? "" : `?${search}`}`;
  const response = await api.get<TransactionsResponse>(path);
  if (values.json) return printJson(response);

  const rows = response.rows.map((row) => [
    `#${row.id}`,
    row.date,
    row.transferAccountName ? `Transfer: ${row.transferAccountName}` : (row.payee ?? ""),
    row.categoryName ?? "",
    formatMoney(row.amount),
    row.cleared ? "✓" : "",
  ]);
  printLines(table(rows, ["l", "l", "l", "l", "r", "l"]));
}

async function add(args: string[]): Promise<void> {
  const options = {
    ...commonOptions,
    account: { type: "string", short: "a" },
    category: { type: "string", short: "c" },
    date: { type: "string", short: "d" },
    memo: { type: "string", short: "m" },
    inflow: { type: "boolean" },
    cleared: { type: "boolean" },
  } as const;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });

  const rawAmount = positionals[1];
  const payee = positionals.slice(2).join(" ");
  if (!rawAmount || payee === "") throw new Error("Usage: budget add <amount> <payee> [options]");
  const parsed = parseMoneyInput(rawAmount);
  if (parsed === null) throw new Error(`Invalid amount "${rawAmount}"`);
  const amount = values.inflow ? Math.abs(parsed) : -Math.abs(parsed);
  const date = values.date ?? todayIso();
  if (!isValidIsoDate(date)) throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD).`);

  const { api, config } = connect();
  const accountQuery = values.account ?? config.defaultAccount;
  if (!accountQuery) throw new Error("No account given and no default account set.");
  const account = resolveName(await listAccounts(api), accountQuery, "account");
  const category = values.category ? await resolveCategory(api, values.category, date.slice(0, 7)) : null;

  const payload = {
    accountId: account.id,
    date,
    payee,
    memo: values.memo ?? "",
    cleared: values.cleared === true,
    amount,
    categoryId: category?.id ?? null,
  };
  const response = await api.post<{ ok: true }>("/transactions", payload);
  if (values.json) return printJson({ ...payload, ...response });

  const details = [account.name, category?.qualifiedName, payload.date].filter((part) => part !== undefined);
  console.log(`Added ${formatMoney(amount)}  ${payee}  (${details.join(" · ")})`);
}

/** The fields `edit` can change, rendered for the before/after line. */
function editableFields(
  row: { date: string; payee: string; memo: string; amount: number; cleared: boolean },
  categoryName: string | null
): Record<string, string> {
  return {
    date: row.date,
    payee: row.payee || "—",
    memo: row.memo || "—",
    amount: formatMoney(row.amount),
    cleared: row.cleared ? "✓" : "—",
    category: categoryName ?? "—",
  };
}

async function edit(args: string[]): Promise<void> {
  const options = {
    ...commonOptions,
    amount: { type: "string" },
    category: { type: "string", short: "c" },
    "no-category": { type: "boolean" },
    date: { type: "string", short: "d" },
    payee: { type: "string", short: "p" },
    memo: { type: "string", short: "m" },
    inflow: { type: "boolean" },
    outflow: { type: "boolean" },
    cleared: { type: "boolean" },
    uncleared: { type: "boolean" },
  } as const;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });

  const rawId = positionals[1];
  const id = Number(rawId);
  if (!rawId || !Number.isInteger(id)) throw new Error("Usage: budget edit <id> [options]");
  if (values.category && values["no-category"]) throw new Error("Pass either -c or --no-category, not both.");
  if (values.cleared && values.uncleared) throw new Error("Pass either --cleared or --uncleared, not both.");
  if (values.inflow && values.outflow) throw new Error("Pass either --inflow or --outflow, not both.");
  if (values.date !== undefined && !isValidIsoDate(values.date)) {
    throw new Error(`Invalid date "${values.date}" (expected YYYY-MM-DD).`);
  }

  let magnitude: number | null = null;
  if (values.amount !== undefined) {
    const parsed = parseMoneyInput(values.amount);
    if (parsed === null) throw new Error(`Invalid amount "${values.amount}"`);
    magnitude = Math.abs(parsed);
  }

  const { api } = connect();
  const row = await api.get<TransactionDetail>(`/transactions/${id}`);

  const amount = resolveEditAmount(row.amount, magnitude, values.inflow === true, values.outflow === true);
  const date = values.date ?? row.date;
  const category = values.category ? await resolveCategory(api, values.category, date.slice(0, 7)) : null;

  const payload: Record<string, unknown> = {};
  if (values.date !== undefined) payload.date = values.date;
  if (values.payee !== undefined) payload.payee = values.payee;
  if (values.memo !== undefined) payload.memo = values.memo;
  if (amount !== undefined) payload.amount = amount;
  if (values.cleared) payload.cleared = true;
  if (values.uncleared) payload.cleared = false;
  if (category) payload.categoryId = category.id;
  if (values["no-category"]) payload.categoryId = null;

  if (Object.keys(payload).length === 0) {
    throw new Error(
      "Nothing to change. Usage: budget edit <id> [--amount 17.50] [--inflow | --outflow] [-d YYYY-MM-DD] [-p payee] [-c category | --no-category] [-m memo] [--cleared | --uncleared]"
    );
  }

  const response = await api.patch<{ ok: true }>(`/transactions/${id}`, payload);
  if (values.json) return printJson({ id, ...payload, ...response });

  const merged = { ...row, ...payload } as TransactionDetail;
  const mergedCategory = values["no-category"] ? null : (category?.qualifiedName ?? row.categoryName);
  const changes = changedFields(editableFields(row, row.categoryName), editableFields(merged, mergedCategory));
  const name = row.transferAccountName ? `Transfer: ${row.transferAccountName}` : merged.payee;
  const transfer = row.transferAccountId === null ? "" : " (transfer, both legs)";
  console.log(`Edited #${id}  ${name}  ${changes.join("  ")}${transfer}`);
}

async function transfer(args: string[]): Promise<void> {
  const options = {
    ...commonOptions,
    from: { type: "string" },
    to: { type: "string" },
    date: { type: "string", short: "d" },
    memo: { type: "string", short: "m" },
    cleared: { type: "boolean" },
  } as const;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });

  const rawAmount = positionals[1];
  if (!rawAmount || !values.from || !values.to) {
    throw new Error("Usage: budget transfer <amount> --from <account> --to <account> [options]");
  }
  const parsed = parseMoneyInput(rawAmount);
  if (parsed === null) throw new Error(`Invalid amount "${rawAmount}"`);
  const amount = Math.abs(parsed);
  const date = values.date ?? todayIso();
  if (!isValidIsoDate(date)) throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD).`);

  const { api } = connect();
  const accountList = await listAccounts(api);
  const from = resolveName(accountList, values.from, "account");
  const to = resolveName(accountList, values.to, "account");

  const payload = {
    fromAccountId: from.id,
    toAccountId: to.id,
    date,
    amount,
    memo: values.memo ?? "",
    cleared: values.cleared === true,
    categoryId: null,
  };
  const response = await api.post<{ ok: true }>("/transfers", payload);
  if (values.json) return printJson({ ...payload, ...response });

  console.log(`Transferred ${formatMoney(amount)}  ${from.name} → ${to.name}  (${payload.date})`);
}

async function undo(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, allowPositionals: true, options: commonOptions });
  const { api } = connect();
  const response = await api.post<UndoResponse>("/undo", {});
  if (values.json) return printJson(response);
  console.log(response.ok ? `Undid: ${response.label ?? "last change"}` : "Nothing to undo.");
}

function printVersion(): void {
  console.log(version);
}

const commands: Record<string, ((args: string[]) => void | Promise<void>) | undefined> = {
  login,
  logout,
  accounts,
  categories,
  tx: transactions,
  add,
  edit,
  transfer,
  undo,
  version: printVersion,
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isHelpFlag = (arg: string | undefined) => arg === "-h" || arg === "--help";
  if (args.length === 0 || isHelpFlag(args[0]) || isHelpFlag(args[1])) {
    console.log(usage);
    return;
  }

  const isVersionFlag = (arg: string | undefined) => arg === "-v" || arg === "--version";
  if (isVersionFlag(args[0])) {
    printVersion();
    return;
  }

  const name = args.find((arg) => !arg.startsWith("-"));
  const command = name !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) {
    process.stderr.write(`Unknown command: ${name ?? ""}\n\n${usage}\n`);
    process.exit(1);
  }
  await command(args);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
