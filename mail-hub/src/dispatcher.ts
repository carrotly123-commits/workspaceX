import { nanoid } from 'nanoid';
import { registry } from './providers/registry.js';
import { rateLimiter } from './rate-limiter.js';
import { allRows, getDb, getRow } from './db.js';
import { PROVIDER, type ProviderName, type BaseProvider, type InboxData } from './providers/base.js';
import { createLogger } from './logger.js';
import { errorMessage, httpStatus, isTransientUpstreamError, retryAfterHeader } from './errors.js';

const log = createLogger('dispatcher');

const PROVIDER_PAIRS: Partial<Record<string, ProviderName[]>> = {
  [PROVIDER.MAILTM]: [PROVIDER.MAILGW],
  [PROVIDER.MAILGW]: [PROVIDER.MAILTM],
  [PROVIDER.TEMPMAIL_LOL]: [PROVIDER.TEMPMAIL_ING],
  [PROVIDER.TEMPMAIL_ING]: [PROVIDER.TEMPMAIL_LOL],
};

interface DispatchOptions {
  for?: string;
  provider?: string;
  domain?: string;
  subdomain?: string;
  username?: string;
  duration?: number;
  needPolling?: boolean;
  ownerKey?: string;
}

interface DispatchResult {
  id: string;
  address: string;
  provider: string;
  expiresAt: string;
  features: Record<string, boolean>;
}

// Every inbox gets an expiry so pool resources (Outlook accounts, YYDS slots)
// can never leak permanently when a client crashes without DELETE.
const DEFAULT_INBOX_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_DURATION_S = 60;
const MAX_DURATION_S = 30 * 24 * 60 * 60;

function sanitizeDuration(duration: unknown): number | undefined {
  const n = Number(duration);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.max(Math.floor(n), MIN_DURATION_S), MAX_DURATION_S);
}

function resolveExpiresAt(providerExpiresAt: string | undefined, durationSeconds: number | undefined): string {
  const requestedMs = durationSeconds ? Date.now() + durationSeconds * 1000 : undefined;
  if (providerExpiresAt) {
    const upstreamMs = Date.parse(providerExpiresAt);
    // Upstream lifetime is authoritative; a shorter requested duration may tighten it.
    if (requestedMs && Number.isFinite(upstreamMs)) {
      return new Date(Math.min(upstreamMs, requestedMs)).toISOString();
    }
    return providerExpiresAt;
  }
  return new Date(requestedMs ?? Date.now() + DEFAULT_INBOX_TTL_MS).toISOString();
}

interface ProviderScore {
  provider: BaseProvider;
  score: number;
  reason: string;
  /** Unblocked domains fetched during scoring; undefined = not fetched (reuse requires a live fetch). */
  unblockedDomains?: string[];
}

// Scoring runs getDomains across all providers; one slow upstream must not
// stall every inbox creation, so scoring caps each fetch at 5s and the
// creation path reuses whatever scoring already fetched.
const SCORING_DOMAINS_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const domainCursor = new Map<string, number>();

function canCreateWithoutPreselectedDomain(provider: BaseProvider): boolean {
  return provider.getDomainMode() === 'from_create';
}

function recordProviderFailure(providerName: string, error: unknown): void {
  if (httpStatus(error, 0) === 429) {
    rateLimiter.recordRateLimitFailure(providerName, retryAfterHeader(error));
  } else if (isTransientUpstreamError(error)) {
    rateLimiter.recordTransientFailure(providerName);
  }
}

export function getDomainAtLevel(domain: string, level: number): string {
  const parts = domain.split('.');
  if (parts.length <= level) return domain;
  return parts.slice(-level).join('.');
}

function isDomainBlocked(domain: string, blockedSet: Set<string>): boolean {
  const parts = domain.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (blockedSet.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

function getBlockedDomains(service: string): Set<string> {
  const db = getDb();
  const rows = allRows<{ domain: string }>(db,
    `SELECT domain FROM blocks
     WHERE service = ? OR service = '*'`,
    service,
  );
  return new Set(rows.map((row) => row.domain));
}

function pickDomain(providerName: string, domains: string[]): string {
  const start = domainCursor.get(providerName) ?? Math.floor(Math.random() * domains.length);
  const domain = domains[start % domains.length];
  domainCursor.set(providerName, (start + 1) % domains.length);
  return domain;
}

async function selectAllowedDomain(
  provider: BaseProvider,
  requestedDomain: string | undefined,
  blockedDomains: Set<string>,
  targetService?: string
): Promise<string | undefined> {
  if (requestedDomain) {
    if (isDomainBlocked(requestedDomain, blockedDomains)) {
      throw new Error(`Domain '${requestedDomain}' is blocked for this service`);
    }
    return requestedDomain;
  }

  if (provider.meta.type === 'alias') return undefined;
  if (canCreateWithoutPreselectedDomain(provider)) return undefined;

  const domains = await provider.getDomains(targetService ? { for: targetService } : undefined);
  const allowed = domains.filter((d) => !isDomainBlocked(d, blockedDomains));
  if (allowed.length === 0) {
    throw new Error(`${provider.meta.name}: all domains blocked`);
  }
  return pickDomain(provider.meta.name, allowed);
}

function getProviderStats(name: string): { success: number; fail: number } {
  const db = getDb();
  const row = getRow<{ success_count: number; fail_count: number }>(
    db,
    `SELECT success_count, fail_count FROM provider_stats WHERE provider = ?`,
    name,
  );
  if (!row) return { success: 0, fail: 0 };
  return { success: row.success_count || 0, fail: row.fail_count || 0 };
}

function getAllProviderStats(): Map<string, { success: number; fail: number }> {
  const db = getDb();
  const rows = allRows<{ provider: string; success_count: number; fail_count: number }>(
    db,
    `SELECT provider, success_count, fail_count FROM provider_stats`,
  );
  return new Map(rows.map((r) => [r.provider, { success: r.success_count || 0, fail: r.fail_count || 0 }]));
}

async function scoreProviders(
  providers: BaseProvider[],
  blockedDomains: Set<string>,
  needPolling: boolean,
  targetService?: string
): Promise<ProviderScore[]> {
  const allStats = getAllProviderStats();

  const scored = await Promise.all(providers.map(async (p): Promise<ProviderScore | null> => {
    if (needPolling && !p.meta.features.pollInbox) return null;

    const cfg = registry.getConfig(p.meta.name);
    if (!cfg.autoDispatch) return null;
    const stats = allStats.get(p.meta.name) ?? { success: 0, fail: 0 };
    const rateOk = rateLimiter.isCreateAvailable(p.meta.name);

    let score = p.meta.trustLevel * 10;
    if (cfg.priority) score += cfg.priority;
    if (rateOk) score += 15;
    score -= Math.min(stats.fail, 10) * 5;

    let domains: string[] = [];
    let unblockedDomains: string[] | undefined;
    if (rateOk && !canCreateWithoutPreselectedDomain(p)) {
      try {
        domains = await withTimeout(
          p.getDomains(targetService ? { for: targetService } : undefined),
          SCORING_DOMAINS_TIMEOUT_MS,
        );
        unblockedDomains = domains.filter((d) => !isDomainBlocked(d, blockedDomains));
        if (unblockedDomains.length > 0) score += 20;
      } catch (e) {
        log.warn('getDomains failed during scoring', { provider: p.meta.name, error: errorMessage(e) });
      }
    }

    let reason = `trust=${p.meta.trustLevel}`;
    if (!rateOk) reason += ', rate-limited';
    if (unblockedDomains?.length === 0 && domains.length > 0) reason += ', all-domains-blocked';
    if (stats.fail > 0) reason += `, fails=${stats.fail}`;

    return { provider: p, score, reason, unblockedDomains };
  }));

  return scored
    .filter((entry): entry is ProviderScore => entry !== null)
    .sort((a, b) => b.score - a.score);
}

function saveInbox(
  id: string,
  inbox: InboxData,
  targetService?: string,
  ownerKey?: string
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO inboxes (id, provider, address, auth_data, api_base, target_service, owner_key, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
      id,
      inbox.provider,
      inbox.address,
      JSON.stringify(inbox.authData),
      inbox.apiBase,
      targetService ?? null,
      ownerKey ?? null,
      inbox.expiresAt ?? null
  );
}

type ProviderCreateOptions = Parameters<BaseProvider['createInbox']>[0] & {
  duration?: number;
  needPolling?: boolean;
};

async function tryCreateInbox(
  provider: BaseProvider,
  providerName: string,
  opts: DispatchOptions,
  domain?: string
): Promise<DispatchResult> {
  const id = nanoid(12);
  const duration = sanitizeDuration(opts.duration);
  const createOpts: ProviderCreateOptions = {
    ...(domain ? { domain } : {}),
    ...(opts.for ? { for: opts.for } : {}),
    ...(opts.subdomain ? { subdomain: opts.subdomain } : {}),
    ...(opts.username ? { username: opts.username } : {}),
    ...(duration ? { duration } : {}),
    inboxId: id,
  };
  if (!rateLimiter.tryRecordCreate(providerName)) {
    throw new Error(`Provider '${providerName}' is rate-limited`);
  }
  let inbox: InboxData;
  try {
    inbox = await provider.createInbox(createOpts);
  } catch (error) {
    // A create that failed deterministically produced no inbox, so refund the
    // slot it reserved: upstream 4xx (other than 429), or a local failure that
    // never reached the network (status 0, non-transient — e.g. empty pool).
    // 429 is left consumed: recordProviderFailure sets a cooldown separately.
    const status = httpStatus(error, 0);
    const deterministicUpstream = status >= 400 && status < 500 && status !== 429;
    const localFailure = status === 0 && !isTransientUpstreamError(error);
    if (deterministicUpstream || localFailure) {
      rateLimiter.refundCreate(providerName);
    }
    throw error;
  }
  const expiresAt = resolveExpiresAt(inbox.expiresAt, duration);
  try {
    saveInbox(id, { ...inbox, expiresAt }, opts.for, opts.ownerKey);
  } catch (error) {
    await provider.releaseInbox(inbox, id).catch(() => {});
    throw error;
  }
  rateLimiter.recordCreateSuccess(providerName);
  return {
    id,
    address: inbox.address,
    provider: providerName,
    expiresAt,
    features: provider.meta.features,
  };
}

export async function dispatch(opts: DispatchOptions): Promise<DispatchResult> {
  if (opts.for && /^(example\.(com|org|net)|test\.(com|org)|localhost)$/i.test(opts.for)) {
    throw new Error(`'${opts.for}' is an example domain, use a real target service`);
  }

  const enabledProviders = registry.getEnabled();
  const needPolling = opts.needPolling !== false;

  if (opts.provider) {
    const p = registry.get(opts.provider);
    if (!p) throw new Error(`Provider '${opts.provider}' not found`);
    const cfg = registry.getConfig(p.meta.name);
    if (!cfg.enabled) throw new Error(`Provider '${opts.provider}' is disabled`);
    if (!rateLimiter.isCreateAvailable(p.meta.name)) {
      throw new Error(`Provider '${opts.provider}' is rate-limited`);
    }
    const blockedDomains = opts.for ? getBlockedDomains(opts.for) : new Set<string>();
    const domain = await selectAllowedDomain(p, opts.domain, blockedDomains, opts.for);

    try {
      return await tryCreateInbox(p, p.meta.name, opts, domain);
    } catch (error) {
      recordProviderFailure(p.meta.name, error);
      throw error;
    }
  }

  const blockedDomains = opts.for ? getBlockedDomains(opts.for) : new Set<string>();
  const scored = await scoreProviders(enabledProviders, blockedDomains, needPolling, opts.for);
  const errors: string[] = [];

  for (const { provider: p, reason, unblockedDomains } of scored) {
    if (!rateLimiter.isCreateAvailable(p.meta.name)) {
      const pairs = PROVIDER_PAIRS[p.meta.name] ?? [];
      for (const pairName of pairs) {
        const pair = registry.get(pairName);
        const pairCfg = registry.getConfig(pairName);
        if (pair && pairCfg.enabled && rateLimiter.isCreateAvailable(pairName)) {
          try {
            let domain: string | undefined;
            if (!canCreateWithoutPreselectedDomain(pair)) {
              let domains = await pair.getDomains(opts.for ? { for: opts.for } : undefined);
              domains = domains.filter((d) => !isDomainBlocked(d, blockedDomains));
              if (domains.length === 0) continue;
              domain = domains.length ? pickDomain(pairName, domains) : undefined;
            }

            return await tryCreateInbox(pair, pairName, opts, domain);
          } catch (e) {
            errors.push(`${pairName}(pair): ${errorMessage(e)}`);
            recordProviderFailure(pairName, e);
            continue;
          }
        }
      }
      errors.push(`${p.meta.name}: rate-limited (${reason})`);
      continue;
    }

    try {
      let domain: string | undefined;
      if (!canCreateWithoutPreselectedDomain(p)) {
        // Reuse the domains scoring already fetched; fetch only when scoring
        // could not (rate-limited then, or the scoring fetch failed).
        let domains = unblockedDomains;
        if (domains === undefined) {
          domains = (await p.getDomains(opts.for ? { for: opts.for } : undefined))
            .filter((d) => !isDomainBlocked(d, blockedDomains));
        }

        if (domains.length === 0 && p.meta.type !== 'alias') {
          errors.push(`${p.meta.name}: all domains blocked`);
          continue;
        }
        domain = domains.length ? pickDomain(p.meta.name, domains) : undefined;
      }

      return await tryCreateInbox(p, p.meta.name, opts, domain);
    } catch (e) {
      errors.push(`${p.meta.name}: ${errorMessage(e)}`);
      recordProviderFailure(p.meta.name, e);
    }
  }

  throw new Error(
    `All providers exhausted.\n${errors.map((e) => `  - ${e}`).join('\n')}`
  );
}
