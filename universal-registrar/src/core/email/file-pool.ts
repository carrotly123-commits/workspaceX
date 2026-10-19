/**
 * File-based email pool.
 * Format (one per line):
 *   user@example.com
 *   user@example.com:mailbox-password
 *
 * Codes still come from the human (or pair with mailtm for full auto).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { EmailMessage, EmailProvider, HumanPromptFn } from "../types.ts";
import { ManualEmailProvider } from "./manual.ts";

export class FileEmailPool implements EmailProvider {
  readonly id = "file";
  private path: string;
  private ask: HumanPromptFn;
  private manual: ManualEmailProvider;
  private used = new Set<string>();

  constructor(path: string, ask: HumanPromptFn) {
    this.path = path;
    this.ask = ask;
    this.manual = new ManualEmailProvider(ask);
  }

  private loadLines(): string[] {
    if (!existsSync(this.path)) {
      throw new Error(`Email pool file not found: ${this.path}`);
    }
    return readFileSync(this.path, "utf-8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }

  async acquireAddress(_hint?: string): Promise<string> {
    const lines = this.loadLines();
    for (const line of lines) {
      const email = line.split(":")[0]!.trim();
      if (!this.used.has(email) && email.includes("@")) {
        this.used.add(email);
        // Mark as used by rewriting with a prefix (non-destructive comment style)
        return email;
      }
    }
    // Fallback to manual
    console.log("  ! Email pool exhausted, falling back to manual input.");
    return this.manual.acquireAddress();
  }

  async waitForMessage(
    address: string,
    predicate: (msg: EmailMessage) => boolean,
    timeoutMs?: number,
  ): Promise<EmailMessage> {
    return this.manual.waitForMessage(address, predicate, timeoutMs);
  }

  async release(address: string): Promise<void> {
    // Append a used marker file for bookkeeping
    const usedPath = `${this.path}.used`;
    const prev = existsSync(usedPath) ? readFileSync(usedPath, "utf-8") : "";
    writeFileSync(usedPath, `${prev}${address}\t${new Date().toISOString()}\n`, "utf-8");
  }
}
