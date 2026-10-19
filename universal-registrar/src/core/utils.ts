import { randomBytes } from "node:crypto";

const ADJECTIVES = [
  "swift",
  "quiet",
  "bright",
  "calm",
  "noble",
  "lunar",
  "solar",
  "amber",
  "coral",
  "misty",
  "vivid",
  "gentle",
  "crisp",
  "silver",
  "golden",
];

const NOUNS = [
  "fox",
  "owl",
  "pine",
  "river",
  "cloud",
  "stone",
  "wave",
  "leaf",
  "star",
  "field",
  "brook",
  "peak",
  "ember",
  "frost",
  "dawn",
];

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Generate a reasonably strong password (letters + digits + symbols). */
export function generatePassword(length = 16): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*_-";
  const all = upper + lower + digits + symbols;

  const bytes = randomBytes(length);
  const chars: string[] = [
    upper[bytes[0]! % upper.length]!,
    lower[bytes[1]! % lower.length]!,
    digits[bytes[2]! % digits.length]!,
    symbols[bytes[3]! % symbols.length]!,
  ];
  for (let i = 4; i < length; i++) {
    chars.push(all[bytes[i]! % all.length]!);
  }
  // Fisher–Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[i % bytes.length]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

/** Generate a human-looking display name. */
export function generateName(): string {
  const a = ADJECTIVES[randomInt(0, ADJECTIVES.length - 1)]!;
  const n = NOUNS[randomInt(0, NOUNS.length - 1)]!;
  return `${capitalize(a)} ${capitalize(n)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Extract first 4–8 digit verification code from free text. */
export function extractVerificationCode(text: string, lengthHint?: number): string | null {
  if (lengthHint) {
    const re = new RegExp(`\\b(\\d{${lengthHint}})\\b`);
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  // Prefer 6-digit, then 4–8
  const patterns = [/\b(\d{6})\b/, /\b(\d{4})\b/, /\b(\d{5})\b/, /\b(\d{7})\b/, /\b(\d{8})\b/];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  // Chinese-style "验证码：123456"
  const cn = text.match(/验证码[：:\s]*(\d{4,8})/);
  if (cn?.[1]) return cn[1];
  const en = text.match(/(?:code|otp|pin)[：:\s]*(\d{4,8})/i);
  if (en?.[1]) return en[1];
  return null;
}

/** Extract first http(s) verification link from email body. */
export function extractVerificationLink(text: string, hostHint?: string): string | null {
  const re = /https?:\/\/[^\s"'<>]+/gi;
  const links = text.match(re) ?? [];
  if (hostHint) {
    const hit = links.find((l) => l.toLowerCase().includes(hostHint.toLowerCase()));
    if (hit) return hit.replace(/[),.;]+$/, "");
  }
  const keywords = ["verify", "confirm", "activate", "validation", "signup", "register"];
  const ranked = links.find((l) => keywords.some((k) => l.toLowerCase().includes(k)));
  if (ranked) return ranked.replace(/[),.;]+$/, "");
  return links[0]?.replace(/[),.;]+$/, "") ?? null;
}

export function cookiesToString(
  cookies: Array<{ name: string; value: string }>,
): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export function parseCookieString(cookie: string): Array<{ name: string; value: string }> {
  return cookie
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const idx = p.indexOf("=");
      if (idx < 0) return { name: p, value: "" };
      return { name: p.slice(0, idx), value: p.slice(idx + 1) };
    });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function log(
  msg: string,
  level: "info" | "warn" | "error" | "success" = "info",
): void {
  const prefix =
    level === "success"
      ? "✓"
      : level === "warn"
        ? "!"
        : level === "error"
          ? "✗"
          : "·";
  const color =
    level === "success"
      ? "\x1b[32m"
      : level === "warn"
        ? "\x1b[33m"
        : level === "error"
          ? "\x1b[31m"
          : "\x1b[36m";
  console.log(`${color}${prefix}\x1b[0m ${msg}`);
}
