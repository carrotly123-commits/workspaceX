/**
 * Manual email provider — asks the human for an address and verification codes.
 * Safest default; no third-party mailbox dependency.
 */

import type { EmailMessage, EmailProvider, HumanPromptFn } from "../types.ts";
import { extractVerificationCode, extractVerificationLink } from "../utils.ts";

export class ManualEmailProvider implements EmailProvider {
  readonly id = "manual";
  private ask: HumanPromptFn;
  private lastAddress = "";

  constructor(ask: HumanPromptFn) {
    this.ask = ask;
  }

  async acquireAddress(hint?: string): Promise<string> {
    const prompt = hint
      ? `Enter an email address to use (${hint}): `
      : "Enter an email address for registration: ";
    const addr = (await this.ask(prompt)).trim();
    if (!addr || !addr.includes("@")) {
      throw new Error("Invalid email address");
    }
    this.lastAddress = addr;
    return addr;
  }

  async waitForMessage(
    address: string,
    predicate: (msg: EmailMessage) => boolean,
    _timeoutMs = 300_000,
  ): Promise<EmailMessage> {
    console.log(`\n  📬 Waiting for email at: ${address}`);
    console.log("  Open your inbox, then paste the verification code OR the full email body.\n");

    const input = (
      await this.ask("Paste verification code or email body: ")
    ).trim();

    // If user pasted only a short code
    if (/^\d{4,8}$/.test(input)) {
      const msg: EmailMessage = {
        id: `manual-${Date.now()}`,
        from: "manual",
        subject: "manual-code",
        bodyText: input,
        receivedAt: new Date(),
      };
      if (predicate(msg) || true) return msg;
    }

    const msg: EmailMessage = {
      id: `manual-${Date.now()}`,
      from: "manual",
      subject: "manual-body",
      bodyText: input,
      receivedAt: new Date(),
    };

    // Always accept manual paste; caller will extract code/link
    void predicate;
    return msg;
  }
}

/** Convenience: ask human + extract code from their paste. */
export async function askForCode(
  ask: HumanPromptFn,
  label = "verification code",
  lengthHint?: number,
): Promise<string> {
  const raw = (await ask(`Enter ${label}: `)).trim();
  if (/^\d{4,8}$/.test(raw)) return raw;
  const code = extractVerificationCode(raw, lengthHint);
  if (!code) throw new Error(`Could not find a ${label} in the input`);
  return code;
}

export async function askForLink(
  ask: HumanPromptFn,
  hostHint?: string,
): Promise<string> {
  const raw = (await ask("Paste verification link or email body: ")).trim();
  if (/^https?:\/\//i.test(raw)) return raw.split(/\s/)[0]!;
  const link = extractVerificationLink(raw, hostHint);
  if (!link) throw new Error("Could not find a verification link in the input");
  return link;
}
