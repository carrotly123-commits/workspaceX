import type { Page } from "playwright-core";
import { BrowserManager } from "../../browser/manager.ts";
import type { BrowserCookie } from "./cookie-parser.ts";

export interface PageConfig {
	hostKey: string;
	startUrl: string;
	cookies: BrowserCookie[];
	localStorage?: Record<string, string>;
}

/**
 * Return a healthy browser page for the given provider, re-creating it
 * when the previous one has been closed or navigated away.
 *
 * 1. If `currentPage` is alive (readyState evaluates), return it.
 * 2. Otherwise ask `BrowserManager` for a fresh page and inject cookies.
 */
export async function ensurePage(currentPage: Page | null, config: PageConfig): Promise<Page> {
	if (currentPage) {
		try {
			await currentPage.evaluate(() => document.readyState);
			return currentPage;
		} catch {
			// page is dead — fall through
		}
	}

	const bm = BrowserManager.getInstance();
	if (config.cookies.length > 0) {
		await bm.addCookies(config.cookies);
	}
	const page = await bm.getPage(config.hostKey, config.startUrl);
	if (config.localStorage && Object.keys(config.localStorage).length > 0) {
		await page
			.evaluate((entries) => {
				for (const [k, v] of Object.entries(entries)) {
					try {
						window.localStorage.setItem(k, v);
					} catch {
						// ignore quota / security errors
					}
				}
			}, config.localStorage)
			.catch(() => {});
	}
	return page;
}
