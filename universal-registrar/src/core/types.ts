/**
 * Core types for the universal registration engine.
 */

export type RegisterMode = "auto" | "semi" | "manual";

export type RegisterStatus =
  | "pending"
  | "running"
  | "awaiting_human"
  | "awaiting_email"
  | "awaiting_sms"
  | "awaiting_captcha"
  | "success"
  | "failed"
  | "skipped";

export interface AccountIdentity {
  email: string;
  password: string;
  /** Display / full name if the platform asks for one */
  name?: string;
  /** Phone number (E.164) when SMS verification is required */
  phone?: string;
  /** Extra free-form fields platforms may need */
  extra?: Record<string, string>;
}

export interface RegisteredAccount extends AccountIdentity {
  platformId: string;
  status: RegisterStatus;
  /** Captured session cookies / tokens after successful register+login */
  credentials?: Record<string, unknown>;
  /** Human-readable notes / failure reason */
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProgressFn {
  (msg: string, level?: "info" | "warn" | "error" | "success"): void;
}

export interface HumanPromptFn {
  (prompt: string, options?: { secret?: boolean; timeoutMs?: number }): Promise<string>;
}

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  receivedAt: Date;
}

export interface EmailProvider {
  readonly id: string;
  /** Allocate or return the next usable inbox address */
  acquireAddress(hint?: string): Promise<string>;
  /** Wait until a message matching the predicate arrives */
  waitForMessage(
    address: string,
    predicate: (msg: EmailMessage) => boolean,
    timeoutMs?: number,
  ): Promise<EmailMessage>;
  /** Optional cleanup */
  release?(address: string): Promise<void>;
}

export interface RegisterContext {
  identity: AccountIdentity;
  mode: RegisterMode;
  onProgress: ProgressFn;
  askHuman: HumanPromptFn;
  email?: EmailProvider;
  /** CDP endpoint, default http://127.0.0.1:9222 */
  cdpUrl: string;
  /** Headless only works for pure-API platforms; most web flows need headed Chrome */
  headless: boolean;
  /** Per-step timeout */
  timeoutMs: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface RegisterResult {
  success: boolean;
  status: RegisterStatus;
  identity: AccountIdentity;
  credentials?: Record<string, unknown>;
  message?: string;
  /** Optional raw debug payload */
  debug?: unknown;
}

/**
 * Platform adapter contract.
 * Implement one file per platform under src/platforms/.
 */
export interface PlatformAdapter {
  /** Stable id, e.g. "deepseek", "kimi" — should match token-free-gateway provider ids when possible */
  readonly id: string;
  readonly name: string;
  /** Homepage / signup entry URL */
  readonly signupUrl: string;
  /** Domains used for cookie capture */
  readonly domains: string[];
  /**
   * auto  = fully scripted (form fill + email code)
   * semi  = scripted until captcha/phone, then human
   * manual = open page, wait for human to finish, then capture session
   */
  readonly preferredMode: RegisterMode;
  /** Whether email verification is typically required */
  readonly needsEmail: boolean;
  /** Whether phone / SMS is typically required */
  readonly needsPhone: boolean;
  /** Free-text tips shown before registration */
  readonly tips?: string;

  /**
   * Run the registration (and ideally first login) flow.
   * Should return credentials compatible with token-free-gateway when possible.
   */
  register(ctx: RegisterContext): Promise<RegisterResult>;

  /**
   * Optional: only capture an already-logged-in session (no signup).
   * Useful when the user registered manually earlier.
   */
  captureSession?(ctx: RegisterContext): Promise<RegisterResult>;
}

export interface EngineConfig {
  cdpUrl: string;
  headless: boolean;
  timeoutMs: number;
  /** Delay between sequential registrations (ms) */
  delayBetweenMs: number;
  /** Max concurrent workers (keep low to avoid bans) */
  concurrency: number;
  /** Default password strategy */
  passwordLength: number;
  /** Account store path */
  storePath: string;
  /** Email provider id: "auto" | "manual" | "file" | "mailtm" | "mailhub" | "custom" */
  emailProvider: string;
  /** Path to email pool file (one address per line, optional password after :) */
  emailFile?: string;
  /** Mail.tm / other API base */
  emailApiBase?: string;
  /** Mail Hub base URL (default: http://127.0.0.1:3100) */
  mailHubUrl?: string;
  /** Mail Hub Bearer API key or API_SECRET */
  mailHubApiKey?: string;
  /** Optional Mail Hub upstream provider filter (e.g. "outlook", "yyds", "imap", "mailtm") */
  mailHubProvider?: string;
  /** Optional Mail Hub email domain filter */
  mailHubDomain?: string;
  /** Export path for token-free-gateway auth-profiles.json */
  tfgStorePath?: string;
  /** Default max retries per account in bulk registration */
  maxRetries?: number;
  /** Path for discovered external sites store */
  discoveredSitesPath?: string;
  /** Default 2API credentials export path */
  credentialsExportPath?: string;
}

/**
 * Phase 1: External Site Discovery types
 */
export type SiteFrameworkType =
  | "oneapi"
  | "newapi"
  | "voapi"
  | "supabase"
  | "clerk"
  | "nextauth"
  | "generic_ai"
  | "unknown";

export interface DiscoveredSite {
  id: string;
  url: string;
  origin: string;
  hostname: string;
  rootDomain: string;
  title?: string;
  reachable: boolean;
  statusCode?: number;
  framework: SiteFrameworkType;
  signupCandidates: string[];
  loginCandidates: string[];
  apiBaseCandidates: string[];
  openAiCompatible?: boolean;
  source: string;
  discoveredAt: string;
}

/**
 * Phase 2: Registration Route Probing types
 */
export type RegistrationRouteType =
  | "api_oneapi"
  | "api_rest"
  | "api_supabase"
  | "browser_email_direct"
  | "browser_email_otp"
  | "browser_email_link"
  | "browser_phone_sms"
  | "oauth_only"
  | "closed"
  | "unknown";

export type CaptchaBarrierType =
  | "none"
  | "turnstile"
  | "hcaptcha"
  | "recaptcha"
  | "geetest"
  | "slider"
  | "image_captcha";

export interface DetectedFormSelectors {
  openSignup?: string[];
  email?: string[];
  username?: string[];
  password?: string[];
  confirmPassword?: string[];
  name?: string[];
  phone?: string[];
  code?: string[];
  sendCode?: string[];
  inviteCode?: string[];
  submit?: string[];
}

export interface RegistrationRouteCandidate {
  type: RegistrationRouteType;
  endpointOrUrl: string;
  method: "POST" | "GET" | "BROWSER";
  requiresEmailVerification: boolean;
  requiresPhone: boolean;
  requiresInviteCode?: boolean;
  captchaType: CaptchaBarrierType;
  oauthProviders?: string[];
  feasibilityScore: number;
  estimatedSpeed: "fast" | "medium" | "slow" | "manual";
  notes: string[];
}

export interface OneApiStatusMetadata {
  systemName?: string;
  registerEnabled: boolean;
  emailVerification: boolean;
  turnstileCheck: boolean;
  turnstileSiteKey?: string;
  githubOAuth?: boolean;
  linuxdoOAuth?: boolean;
  wechatLogin?: boolean;
  serverAddress?: string;
}

export interface CredentialHint {
  supportsApiKeyCreation: boolean;
  tokenEndpoint?: string;
  userSelfEndpoint?: string;
  openAiModelsEndpoint?: string;
  chatCompletionsEndpoint?: string;
  expectedAuthType: "api_key" | "bearer_token" | "cookie_session";
}

export interface ProbeReport {
  platformId: string;
  siteUrl: string;
  origin: string;
  signupUrl: string;
  framework: SiteFrameworkType;
  registrationOpen: boolean;
  routes: RegistrationRouteCandidate[];
  detectedSelectors: DetectedFormSelectors;
  oneApiStatus?: OneApiStatusMetadata;
  credentialHints: CredentialHint;
  probedAt: string;
}

/**
 * Phase 3: Optimal Registration Strategy Selection types
 */
export type StrategyExecutionKind =
  | "api_protocol"
  | "browser_auto"
  | "browser_semi"
  | "manual";

export interface RegistrationStrategyPlan {
  platformId: string;
  siteUrl: string;
  signupUrl: string;
  framework: SiteFrameworkType;
  chosenRoute: RegistrationRouteCandidate;
  alternativeRoutes: RegistrationRouteCandidate[];
  strategyKind: StrategyExecutionKind;
  mode: RegisterMode;
  score: number;
  canBulkRegister: boolean;
  recommendedEmailProvider: "auto" | "mailhub" | "mailtm" | "manual";
  recommendedConcurrency: number;
  recommendedDelayMs: number;
  reasoning: string[];
  credentialHints: CredentialHint;
  detectedSelectors: DetectedFormSelectors;
  protocolEndpoints?: {
    registerUrl?: string;
    loginUrl?: string;
    sendCodeUrl?: string;
    tokenUrl?: string;
    userSelfUrl?: string;
  };
  plannedAt: string;
}

/**
 * Phase 5: Meaningful Credentials for 2API consumption
 */
export type CredentialAuthType =
  | "api_key"
  | "bearer_token"
  | "cookie_session"
  | "custom_header";

export interface MeaningfulCredentials extends Record<string, unknown> {
  /** Primary authentication mechanism usable for 2API requests */
  authType: CredentialAuthType;
  /** Most valuable secret (sk-... API key > Bearer accessToken > session token/cookie) */
  primarySecret: string;
  /** Explicit API key (e.g. sk-xxxx) minted or extracted for this account */
  apiKey?: string;
  /** Bearer / JWT / OAuth access token */
  accessToken?: string;
  /** Refresh token when available */
  refreshToken?: string;
  /** Alias for backward compatibility with token-free-gateway */
  bearer?: string;
  /** Session token or ID if distinct from accessToken */
  sessionToken?: string;
  /** Full Cookie header string */
  cookie: string;
  /** Filtered authentication-related cookies (key -> value) */
  authCookies: Record<string, string>;
  /** Ready-to-use HTTP request headers for 2API upstream calls */
  readyHeaders: Record<string, string>;
  /** Account identity & platform metadata */
  email: string;
  userId?: string;
  username?: string;
  quota?: number;
  origin: string;
  apiBaseUrl: string;
  observedApiEndpoints: string[];
  userAgent: string;
  capturedAt: string;
  /** Quality assessment of the extracted credential */
  quality: "high" | "medium" | "low";
  qualityReason: string;
}

export interface BulkRegistrationSummary {
  platformId: string;
  totalRequested: number;
  succeeded: number;
  failed: number;
  highQualityCredentials: number;
  apiKeysMinted: number;
  bearerTokensCaptured: number;
  durationMs: number;
  accounts: RegisteredAccount[];
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  cdpUrl: process.env.UR_CDP_URL ?? "http://127.0.0.1:9222",
  headless: false,
  timeoutMs: 300_000,
  delayBetweenMs: 5_000,
  concurrency: 1,
  passwordLength: 16,
  storePath:
    process.env.UR_STORE_PATH ??
    `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.universal-registrar/accounts.json`,
  emailProvider: process.env.UR_EMAIL_PROVIDER ?? "auto",
  mailHubUrl: process.env.MAIL_HUB_URL ?? "http://127.0.0.1:3100",
  mailHubApiKey: process.env.MAIL_HUB_API_KEY ?? process.env.API_SECRET ?? "",
  mailHubProvider: process.env.MAIL_HUB_PROVIDER,
  mailHubDomain: process.env.MAIL_HUB_DOMAIN,
  tfgStorePath:
    process.env.TFG_STORE_PATH ??
    `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.token-free-gateway/auth-profiles.json`,
  maxRetries: Number(process.env.UR_MAX_RETRIES ?? 1),
  discoveredSitesPath:
    process.env.UR_DISCOVERED_SITES_PATH ??
    `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.universal-registrar/discovered-sites.json`,
  credentialsExportPath:
    process.env.UR_CREDENTIALS_EXPORT_PATH ??
    `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.universal-registrar/credentials-2api.json`,
};
