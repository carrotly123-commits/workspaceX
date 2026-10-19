/**
 * Mail.tm disposable inbox provider (public API, no key required).
 * Docs: https://docs.mail.tm/
 *
 * Suitable for platforms that accept disposable mail.
 * Many major AI platforms block these domains — use real mail when needed.
 */

import type { EmailMessage, EmailProvider } from "../types.ts";
import { sleep } from "../utils.ts";

const DEFAULT_BASE = "https://api.mail.tm";

interface MailTmAccount {
  address: string;
  password: string;
  token: string;
  id: string;
}

export class MailTmProvider implements EmailProvider {
  readonly id = "mailtm";
  private base: string;
  private accounts = new Map<string, MailTmAccount>();

  constructor(base = DEFAULT_BASE) {
    this.base = base.replace(/\/$/, "");
  }

  private async api<T>(
    path: string,
    init: RequestInit & { token?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`mail.tm ${init.method ?? "GET"} ${path} → ${res.status}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async acquireAddress(_hint?: string): Promise<string> {
    const domains = await this.api<{ "hydra:member"?: Array<{ domain: string }> } | Array<{ domain: string }>>(
      "/domains",
    );
    const list = Array.isArray(domains)
      ? domains
      : (domains["hydra:member"] ?? []);
    const domain = list[0]?.domain;
    if (!domain) throw new Error("mail.tm: no domains available");

    const local = `ur${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const address = `${local}@${domain}`;
    const password = `Ur${Math.random().toString(36).slice(2)}!9A`;

    const created = await this.api<{ id: string; address: string }>("/accounts", {
      method: "POST",
      body: JSON.stringify({ address, password }),
    });

    const tokenRes = await this.api<{ token: string }>("/token", {
      method: "POST",
      body: JSON.stringify({ address, password }),
    });

    this.accounts.set(address, {
      address,
      password,
      token: tokenRes.token,
      id: created.id,
    });
    return address;
  }

  async waitForMessage(
    address: string,
    predicate: (msg: EmailMessage) => boolean,
    timeoutMs = 180_000,
  ): Promise<EmailMessage> {
    const acc = this.accounts.get(address);
    if (!acc) throw new Error(`mail.tm: unknown address ${address}`);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const list = await this.api<
        | { "hydra:member"?: Array<{ id: string; from: { address: string }; subject: string; intro?: string }> }
        | Array<{ id: string; from: { address: string }; subject: string; intro?: string }>
      >("/messages", { token: acc.token });

      const members = Array.isArray(list) ? list : (list["hydra:member"] ?? []);
      for (const m of members) {
        const full = await this.api<{
          id: string;
          from: { address: string };
          subject: string;
          text?: string;
          html?: string | string[];
          intro?: string;
        }>(`/messages/${m.id}`, { token: acc.token });

        const bodyText =
          full.text ||
          (Array.isArray(full.html) ? full.html.join("\n") : full.html) ||
          full.intro ||
          "";
        const msg: EmailMessage = {
          id: full.id,
          from: full.from?.address ?? "",
          subject: full.subject ?? "",
          bodyText: String(bodyText),
          bodyHtml: Array.isArray(full.html) ? full.html.join("\n") : full.html,
          receivedAt: new Date(),
        };
        if (predicate(msg)) return msg;
      }
      await sleep(3000);
    }
    throw new Error(`mail.tm: timed out waiting for mail at ${address}`);
  }
}
