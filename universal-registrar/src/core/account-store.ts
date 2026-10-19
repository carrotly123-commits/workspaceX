/**
 * Persistent store for registered accounts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RegisteredAccount } from "./types.ts";
import { nowIso } from "./utils.ts";

export interface AccountStoreFile {
  version: 1;
  accounts: RegisteredAccount[];
}

export class AccountStore {
  constructor(private readonly path: string) {}

  private ensure(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  load(): AccountStoreFile {
    try {
      if (existsSync(this.path)) {
        return JSON.parse(readFileSync(this.path, "utf-8")) as AccountStoreFile;
      }
    } catch (e) {
      console.warn(`[store] failed to load ${this.path}:`, e);
    }
    return { version: 1, accounts: [] };
  }

  save(data: AccountStoreFile): void {
    this.ensure();
    writeFileSync(this.path, JSON.stringify(data, null, 2), "utf-8");
  }

  list(platformId?: string): RegisteredAccount[] {
    const all = this.load().accounts;
    return platformId ? all.filter((a) => a.platformId === platformId) : all;
  }

  upsert(account: RegisteredAccount): void {
    const data = this.load();
    const idx = data.accounts.findIndex(
      (a) => a.platformId === account.platformId && a.email === account.email,
    );
    account.updatedAt = nowIso();
    if (idx >= 0) data.accounts[idx] = account;
    else data.accounts.push(account);
    this.save(data);
  }

  addSuccess(
    platformId: string,
    partial: Omit<RegisteredAccount, "platformId" | "createdAt" | "updatedAt" | "status"> & {
      status?: RegisteredAccount["status"];
    },
  ): RegisteredAccount {
    const account: RegisteredAccount = {
      platformId,
      email: partial.email,
      password: partial.password,
      name: partial.name,
      phone: partial.phone,
      extra: partial.extra,
      credentials: partial.credentials,
      message: partial.message,
      status: partial.status ?? "success",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.upsert(account);
    return account;
  }

  exportCsv(platformId?: string): string {
    const rows = this.list(platformId);
    const header = "platform,email,password,status,createdAt,message";
    const lines = rows.map((r) =>
      [r.platformId, r.email, r.password, r.status, r.createdAt, JSON.stringify(r.message ?? "")]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(","),
    );
    return [header, ...lines].join("\n");
  }
}
