/**
 * Smart multi-provider email pool with automatic failover.
 * Priority order:
 *   1. Mail Hub (if reachable)
 *   2. Mail.tm (zero-config public temporary email API)
 *   3. File pool (if emailFile configured)
 *   4. Manual fallback
 */

import type { EmailMessage, EmailProvider, HumanPromptFn, ProgressFn } from "../types.ts";
import { FileEmailPool } from "./file-pool.ts";
import { MailHubProvider, type MailHubOptions } from "./mailhub.ts";
import { MailTmProvider } from "./mailtm.ts";
import { ManualEmailProvider } from "./manual.ts";

export interface AutoEmailPoolOptions {
  mailHub?: MailHubOptions;
  mailTmApiBase?: string;
  emailFile?: string;
  ask?: HumanPromptFn;
  onProgress?: ProgressFn;
}

export class AutoEmailProvider implements EmailProvider {
  readonly id = "auto";
  private mailHub: MailHubProvider;
  private mailTm: MailTmProvider;
  private filePool?: FileEmailPool;
  private manual?: ManualEmailProvider;
  private addressOwners = new Map<string, EmailProvider>();
  private mailHubHealthy: boolean | null = null;
  private onProgress?: ProgressFn;

  constructor(opts: AutoEmailPoolOptions = {}) {
    this.mailHub = new MailHubProvider(opts.mailHub);
    this.mailTm = new MailTmProvider(opts.mailTmApiBase);
    if (opts.emailFile) {
      this.filePool = new FileEmailPool(
        opts.emailFile,
        opts.ask ?? (async () => ""),
      );
    }
    if (opts.ask) {
      this.manual = new ManualEmailProvider(opts.ask);
    }
    this.onProgress = opts.onProgress;
  }

  async acquireAddress(hint?: string): Promise<string> {
    // 1. Try Mail Hub first unless previously confirmed unreachable
    if (this.mailHubHealthy !== false) {
      try {
        const addr = await this.mailHub.acquireAddress(hint);
        this.mailHubHealthy = true;
        this.addressOwners.set(addr, this.mailHub);
        return addr;
      } catch (err) {
        this.mailHubHealthy = false;
        this.onProgress?.(
          `[email:auto] Mail Hub unavailable (${err instanceof Error ? err.message : err}), failing over to Mail.tm...`,
          "warn",
        );
      }
    }

    // 2. Try File pool if provided
    if (this.filePool) {
      try {
        const addr = await this.filePool.acquireAddress(hint);
        this.addressOwners.set(addr, this.filePool);
        return addr;
      } catch {
        // Exhausted or unreadable; continue to Mail.tm
      }
    }

    // 3. Try Mail.tm
    try {
      const addr = await this.mailTm.acquireAddress(hint);
      this.addressOwners.set(addr, this.mailTm);
      return addr;
    } catch (err) {
      this.onProgress?.(
        `[email:auto] Mail.tm failed (${err instanceof Error ? err.message : err})`,
        "warn",
      );
    }

    // 4. Fallback to manual prompt
    if (this.manual) {
      const addr = await this.manual.acquireAddress(hint);
      this.addressOwners.set(addr, this.manual);
      return addr;
    }

    throw new Error("All automatic email providers (Mail Hub, File Pool, Mail.tm) failed to allocate an inbox");
  }

  async waitForMessage(
    address: string,
    predicate: (msg: EmailMessage) => boolean,
    timeoutMs?: number,
  ): Promise<EmailMessage> {
    const owner = this.addressOwners.get(address);
    if (!owner) {
      throw new Error(`auto-email: unknown owner for address ${address}`);
    }
    return owner.waitForMessage(address, predicate, timeoutMs);
  }

  async release(address: string): Promise<void> {
    const owner = this.addressOwners.get(address);
    this.addressOwners.delete(address);
    if (owner?.release) {
      await owner.release(address).catch(() => {});
    }
  }
}
