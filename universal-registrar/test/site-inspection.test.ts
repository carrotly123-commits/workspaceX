import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "playwright-core";
import { classifySiteInput, findGithubEntries, inspectSite, type SiteInputAttributes } from "../src/core/site-inspection.js";

test("classifySiteInput recognizes email, password, and chat candidates", () => {
  assert.equal(classifySiteInput({ type: "email" }), "email");
  assert.equal(classifySiteInput({ autocomplete: "current-password" }), "password");
  assert.equal(classifySiteInput({ tagName: "TEXTAREA" }), "chat");
  assert.equal(classifySiteInput({ type: "text", placeholder: "Ask anything" }), "chat");
  assert.equal(classifySiteInput({ type: "text", name: "search" }), null);
});

interface StubCandidate extends SiteInputAttributes {
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
  accessibleName?: string;
  roleType?: "link" | "button";
  oauthHref?: "https" | "http" | boolean;
  ariaDisabled?: boolean;
}

class StubLocator {
  constructor(private readonly candidates: StubCandidate[]) {}

  async count(): Promise<number> { return this.candidates.length; }
  nth(index: number): StubLocator { return new StubLocator([this.candidates[index]!]); }
  async isVisible(): Promise<boolean> { return this.candidates[0]?.visible !== false; }
  async isEnabled(): Promise<boolean> {
    return this.candidates[0]?.enabled !== false && this.candidates[0]?.ariaDisabled !== true;
  }
  async isEditable(): Promise<boolean> { return this.candidates[0]?.editable !== false; }
  async getAttribute(name: string): Promise<string | null> {
    const keys: Record<string, keyof SiteInputAttributes> = {
      type: "type", autocomplete: "autocomplete", name: "name", id: "id",
      placeholder: "placeholder", "aria-label": "ariaLabel", role: "role", contenteditable: "contenteditable",
    };
    const key = keys[name];
    return key ? (this.candidates[0]?.[key] as string | null | undefined) ?? null : null;
  }
  async evaluate<T>(callback: (element: { tagName: string }) => T): Promise<T> {
    return callback({ tagName: this.candidates[0]?.tagName ?? "INPUT" });
  }
  or(other: StubLocator): StubLocator {
    return new StubLocator([...new Set([...this.candidates, ...other.candidates])]);
  }
  and(other: StubLocator): StubLocator {
    const candidates = new Set(other.candidates);
    return new StubLocator(this.candidates.filter((candidate) => candidates.has(candidate)));
  }
}

function stubPage(candidates: StubCandidate[], url: string): Page {
  const entries = candidates.filter((candidate) => candidate.roleType || candidate.oauthHref);
  const page = {
    url: () => url,
    locator: (selector: string) => {
      if (selector.startsWith("input,")) {
        return new StubLocator(candidates.filter((candidate) => !candidate.roleType && !candidate.oauthHref));
      }
      if (selector.includes(":visible")) {
        return new StubLocator(entries.filter((candidate) =>
          candidate.visible !== false && candidate.enabled !== false && candidate.ariaDisabled !== true));
      }
      return new StubLocator(entries.filter((candidate) => candidate.oauthHref === true || candidate.oauthHref === "https"));
    },
    getByRole: (role: "link" | "button", options: { name: RegExp }) => new StubLocator(
      entries.filter((candidate) => candidate.roleType === role && options.name.test(candidate.accessibleName ?? "")),
    ),
  };
  return page as unknown as Page;
}

test("inspectSite reports sanitized URL, actionable field counts, and ambiguity", async () => {
  const page = stubPage([
    { tagName: "INPUT", type: "email" },
    { tagName: "INPUT", type: "text", name: "email" },
    { tagName: "INPUT", type: "password", enabled: false },
    { tagName: "TEXTAREA" },
    { tagName: "TEXTAREA", visible: false },
    { roleType: "link", accessibleName: "Sign in with GitHub" },
    { roleType: "link", accessibleName: "GitHub repository" },
    { oauthHref: true },
  ], "https://user:secret@example.test/login?token=secret#form");

  assert.deepEqual(await inspectSite(page), {
    url: "https://example.test/login",
    counts: { emailInputs: 2, passwordInputs: 0, chatInputs: 1, githubEntries: 2 },
    issues: [
      "Multiple email input candidates (2) make selection ambiguous.",
      "Multiple GitHub OAuth entry candidates (2) make selection ambiguous.",
    ],
  });
});

test("findGithubEntries returns only visible enabled GitHub auth entries and secure OAuth links", async () => {
  const page = stubPage([
    { roleType: "button", accessibleName: "Sign in with GitHub" },
    { roleType: "link", accessibleName: "Continue with GitHub" },
    { roleType: "button", accessibleName: "使用 GitHub 登录" },
    { roleType: "link", accessibleName: "Continue with GitHub", visible: false },
    { roleType: "button", accessibleName: "Sign up with GitHub", enabled: false },
    { roleType: "button", accessibleName: "使用 GitHub 注册", ariaDisabled: true },
    { roleType: "link", accessibleName: "GitHub repository" },
    { oauthHref: "https" },
    { oauthHref: "http" },
  ], "https://example.test/");

  assert.equal(await findGithubEntries(page).count(), 4);
});
