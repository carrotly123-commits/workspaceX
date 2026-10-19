/**
 * Built-in platform adapter registry.
 */

import type { PlatformAdapter } from "../core/types.ts";
import { chatgptAdapter } from "./chatgpt.ts";
import { claudeAdapter } from "./claude.ts";
import { deepseekAdapter } from "./deepseek.ts";
import { doubaoAdapter } from "./doubao.ts";
import { geminiAdapter } from "./gemini.ts";
import { glmAdapter, glmIntlAdapter } from "./glm.ts";
import { grokAdapter } from "./grok.ts";
import { kimiAdapter } from "./kimi.ts";
import { loadGenericAdaptersFromDir } from "./generic.ts";
import { perplexityAdapter } from "./perplexity.ts";
import { qwenAdapter, qwenCnAdapter } from "./qwen.ts";
import { xiaomimoAdapter } from "./xiaomimo.ts";
import { join } from "node:path";

export const BUILTIN_ADAPTERS: PlatformAdapter[] = [
  claudeAdapter,
  chatgptAdapter,
  deepseekAdapter,
  doubaoAdapter,
  geminiAdapter,
  glmAdapter,
  glmIntlAdapter,
  grokAdapter,
  kimiAdapter,
  perplexityAdapter,
  qwenAdapter,
  qwenCnAdapter,
  xiaomimoAdapter,
];

/**
 * All adapters = builtins + optional JSON defs from config/platforms.
 */
export function loadAllAdapters(extraDir?: string): PlatformAdapter[] {
  const here = typeof import.meta.dirname === "string"
    ? import.meta.dirname
    : join(process.cwd(), "src", "platforms");
  const dir =
    extraDir ||
    process.env.UR_PLATFORMS_DIR ||
    join(here, "..", "..", "config", "platforms");
  const generic = loadGenericAdaptersFromDir(dir);
  const map = new Map<string, PlatformAdapter>();
  for (const a of BUILTIN_ADAPTERS) map.set(a.id, a);
  for (const a of generic) map.set(a.id, a); // JSON can override
  return [...map.values()];
}
