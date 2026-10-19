/**
 * Mail Hub email provider — integrates with the companion `mail-hub` service
 * (default http://127.0.0.1:3100) for multi-provider inbox allocation,
 * polling, verification code extraction, and automatic quality reporting.
 */

import type { EmailMessage, EmailProvider } from "../types.ts";
import { sleep } from "../utils.ts";

const DEFAULT_MAIL_HUB_URL = "http://127.0.0.1:3100";

/** Map platform IDs to canonical target service domains for Mail Hub routing/blocking */
const PLATFORM_SERVICE_DOMAINS: Record<string, string> = {
  chatgpt: "openai.com",
  claude: "claude.ai",
  deepseek: "deepseek.com",
  doubao: "doubao.com",
  gemini: "google.com",
  glm: "chatglm.cn",
  grok: "x.ai",
  kimi: "moonshot.cn",
  perplexity: "perplexity.ai",
  qwen: "aliyun.com",
  xiaomimo: "xiaomi.com",
};

export interface MailHubOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Optional upstream provider filter in mail-hub (e.g. "outlook", "yyds", "imap", "mailtm") */
  provider?: string;
  /** Optional specific email domain to request from mail-hub */
  domain?: string;
}

interface AllocatedInbox {
  id: string;
  address: string;
  provider: string;
  targetService: string;
  matched: boolean;
  seenMessageIds: Set<string>;
}

export class MailHubProvider implements EmailProvider {
  readonly id = "mailhub";
  private baseUrl: string;
  private apiKey: string;
  private upstreamProvider?: string;
  private domain?: string;
  private inboxes = new Map<string, AllocatedInbox>();

  constructor(opts: MailHubOptions = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_MAIL_HUB_URL).replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.upstreamProvider = opts.provider;
    this.domain = opts.domain;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`mail-hub ${init.method ?? "GET"} ${path} → ${res.status}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private resolveTargetService(hint?: string): string {
    if (!hint) return "ai-platform.local";
    const normalized = hint.trim().toLowerCase();
    if (PLATFORM_SERVICE_DOMAINS[normalized]) {
      return PLATFORM_SERVICE_DOMAINS[normalized]!;
    }
    return normalized.includes(".") ? normalized : `${normalized}.com`;
  }

  async acquireAddress(hint?: string): Promise<string> {
    const targetService = this.resolveTargetService(hint);
    const payload: Record<string, unknown> = {
      for: targetService,
      needPolling: true,
    };
    if (this.upstreamProvider) payload.provider = this.upstreamProvider;
    if (this.domain) payload.domain = this.domain;

    const created = await this.api<{
      id: string;
      address: string;
      provider: string;
    }>("/api/inbox", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    this.inboxes.set(created.address, {
      id: created.id,
      address: created.address,
      provider: created.provider,
      targetService,
      matched: false,
      seenMessageIds: new Set<string>(),
    });

    return created.address;
  }

  async waitForMessage(
    address: string,
    predicate: (msg: EmailMessage) => boolean,
    timeoutMs = 180_000,
  ): Promise<EmailMessage> {
    const inbox = this.inboxes.get(address);
    if (!inbox) {
      throw new Error(`mail-hub: unknown inbox address ${address}`);
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // 1. Poll message list so full message bodies can be evaluated against predicate
      try {
        const list = await this.api<{
          messages?: Array<{
            id: string;
            from: string;
            subject: string;
            excerpt?: string;
            receivedAt?: string;
          }>;
        }>(`/api/inbox/${encodeURIComponent(inbox.id)}/messages`);

        for (const summary of list.messages ?? []) {
          if (inbox.seenMessageIds.has(summary.id)) continue;
          const detail = await this.api<{
            id: string;
            from: string;
            subject: string;
            excerpt?: string;
            text?: string;
            html?: string;
            receivedAt?: string;
          }>(
            `/api/inbox/${encodeURIComponent(inbox.id)}/messages/${encodeURIComponent(summary.id)}`,
          );
          inbox.seenMessageIds.add(summary.id);

          const bodyText = detail.text || detail.html || detail.excerpt || "";
          const msg: EmailMessage = {
            id: detail.id,
            from: detail.from ?? "",
            subject: detail.subject ?? "",
            bodyText,
            bodyHtml: detail.html,
            receivedAt: detail.receivedAt ? new Date(detail.receivedAt) : new Date(),
          };

          if (predicate(msg)) {
            inbox.matched = true;
            return msg;
          }
        }
      } catch {
        // Fall back to /code endpoint below if direct message polling hits rate-limit or upstream error
      }

      // 2. Also query mail-hub's built-in verification code extractor
      try {
        const codeRes = await this.api<{
          codes?: Array<{ type: string; value: string; confidence: number; context?: string }>;
          email?: { from?: string; subject?: string } | null;
          messageId?: string | null;
          receivedAt?: string | null;
        }>(`/api/inbox/${encodeURIComponent(inbox.id)}/code`);

        const topCode = codeRes.codes?.[0];
        if (topCode?.value) {
          const msg: EmailMessage = {
            id: codeRes.messageId || `code-${Date.now()}`,
            from: codeRes.email?.from ?? "",
            subject: codeRes.email?.subject ?? "",
            bodyText: `${topCode.context ?? ""} ${topCode.value}`.trim(),
            receivedAt: codeRes.receivedAt ? new Date(codeRes.receivedAt) : new Date(),
          };
          if (predicate(msg)) {
            inbox.matched = true;
            return msg;
          }
        }
      } catch {
        // Ignore transient poll errors until timeout
      }

      await sleep(3000);
    }

    throw new Error(`mail-hub: timed out waiting for verification email at ${address}`);
  }

  async release(address: string): Promise<void> {
    const inbox = this.inboxes.get(address);
    if (!inbox) return;
    this.inboxes.delete(address);

    // Report outcome to mail-hub for provider reliability scoring & auto-blocking
    await this.api(`/api/inbox/${encodeURIComponent(inbox.id)}/report`, {
      method: "POST",
      body: JSON.stringify({
        success: inbox.matched,
        service: inbox.targetService,
      }),
    }).catch(() => {});

    // Close inbox to release pooled accounts (e.g. Outlook)
    await this.api(`/api/inbox/${encodeURIComponent(inbox.id)}`, {
      method: "DELETE",
    }).catch(() => {});
  }
}
