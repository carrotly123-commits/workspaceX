import type { Locator, Page } from "playwright-core";

export interface SiteInspectionCounts {
  emailInputs: number;
  passwordInputs: number;
  chatInputs: number;
  githubEntries: number;
}

export interface SiteInspection {
  /** Current page URL without credentials, query parameters, or fragment. */
  url: string;
  counts: SiteInspectionCounts;
  issues: string[];
}

export interface SiteInputAttributes {
  tagName?: string | null;
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
  role?: string | null;
  contenteditable?: string | null;
}

const GITHUB_AUTH_NAME = /(?=.*github)(?=.*(?:auth|log[ -]?in|sign[ -]?in|continue|sign[ -]?up|register|登录|注册|授权|继续))/iu;
const ACTIONABLE_ENTRY_SELECTOR = ':visible:not([aria-disabled="true"]):not(:disabled)';
const EMAIL_HINT = /e[ -]?mail/i;
const PASSWORD_HINT = /pass(?:word)?/i;
const CHAT_HINT = /chat|message|prompt|ask/i;

/** Identifies a single field candidate from its non-sensitive markup attributes. */
export function classifySiteInput(attributes: SiteInputAttributes): "email" | "password" | "chat" | null {
  const type = attributes.type?.toLowerCase() ?? "";
  const autocomplete = attributes.autocomplete?.toLowerCase() ?? "";
  const hints = [attributes.name, attributes.id, attributes.placeholder, attributes.ariaLabel]
    .filter(Boolean)
    .join(" ");

  if (type === "email" || autocomplete === "email" || EMAIL_HINT.test(hints)) return "email";
  if (type === "password" || autocomplete.includes("password") || PASSWORD_HINT.test(hints)) return "password";

  const tagName = attributes.tagName?.toLowerCase();
  if (
    tagName === "textarea" ||
    attributes.role?.toLowerCase() === "textbox" ||
    attributes.contenteditable?.toLowerCase() === "true" ||
    CHAT_HINT.test(hints)
  ) return "chat";

  return null;
}

/** Return visible, enabled GitHub sign-in or OAuth entry links/buttons. */
export function findGithubEntries(page: Page): Locator {
  const namedLinks = page.getByRole("link", { name: GITHUB_AUTH_NAME });
  const namedButtons = page.getByRole("button", { name: GITHUB_AUTH_NAME });
  const oauthLinks = page.locator([
    'a[href="https://github.com/login/oauth/authorize"]',
    'a[href^="https://github.com/login/oauth/authorize?"]',
    'a[href^="https://github.com/login/oauth/authorize#"]',
  ].join(", "));

  return namedLinks.or(namedButtons).or(oauthLinks).and(page.locator(ACTIONABLE_ENTRY_SELECTOR));
}

function sanitizeSiteUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname}`;
}

async function countVisible(locator: Locator, requireEditable: boolean): Promise<number> {
  let count = 0;
  for (let index = 0, length = await locator.count(); index < length; index++) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible())) continue;
    if (requireEditable && (!(await candidate.isEnabled()) || !(await candidate.isEditable()))) continue;
    count++;
  }
  return count;
}

/** Inspect an already-authorized page without interacting with or changing it. */
export async function inspectSite(page: Page): Promise<SiteInspection> {
  const counts: SiteInspectionCounts = {
    emailInputs: 0,
    passwordInputs: 0,
    chatInputs: 0,
    githubEntries: 0,
  };

  const fields = page.locator('input, textarea, [contenteditable="true"], [role="textbox"]');
  for (let index = 0, length = await fields.count(); index < length; index++) {
    const candidate = fields.nth(index);
    if (!(await candidate.isVisible()) || !(await candidate.isEnabled()) || !(await candidate.isEditable())) continue;

    const attributes: SiteInputAttributes = {
      tagName: await candidate.evaluate((element) => element.tagName),
      type: await candidate.getAttribute("type"),
      autocomplete: await candidate.getAttribute("autocomplete"),
      name: await candidate.getAttribute("name"),
      id: await candidate.getAttribute("id"),
      placeholder: await candidate.getAttribute("placeholder"),
      ariaLabel: await candidate.getAttribute("aria-label"),
      role: await candidate.getAttribute("role"),
      contenteditable: await candidate.getAttribute("contenteditable"),
    };

    const category = classifySiteInput(attributes);
    if (category === "email") counts.emailInputs++;
    else if (category === "password") counts.passwordInputs++;
    else if (category === "chat") counts.chatInputs++;
  }

  counts.githubEntries = await countVisible(findGithubEntries(page), false);

  const issues: string[] = [];
  for (const [label, count] of [
    ["email input", counts.emailInputs],
    ["password input", counts.passwordInputs],
    ["chat input", counts.chatInputs],
    ["GitHub OAuth entry", counts.githubEntries],
  ] as const) {
    if (count > 1) issues.push(`Multiple ${label} candidates (${count}) make selection ambiguous.`);
  }

  return { url: sanitizeSiteUrl(page.url()), counts, issues };
}
