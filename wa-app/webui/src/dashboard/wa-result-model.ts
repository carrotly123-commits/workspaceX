import type { WaWorkflowResponse } from './wa-api';
import { accountFlowLabel, accountReasonLabel, accountStatusLabel, countdownLabel, methodLabel, methodLabels } from './wa-result-labels';
import { compactJoin, extraValues, firstBool, firstNumber, firstText, record, statusIn } from './wa-result-normalize';
export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';
export type ResultTone = 'ok' | 'warn' | 'bad' | 'idle';
export type VerificationMethodStatus = { key: string; label: string; available?: boolean; cooldownSeconds: number | null };
export type WaProbeStatus = {
  requestFailed: boolean;
  failureReason: string;
  registered?: boolean;
  blocked?: boolean;
  accountReachable?: boolean;
  smsAvailable?: boolean;
  smsWaitSeconds: number | null;
  smsWaitUntil: string;
  canRegister?: boolean;
  accountFlow: string;
  accountStatus: string;
  accountRawStatus: string;
  accountRawReason: string;
  accountError: string;
  smsStatus: string;
  methodStatuses: VerificationMethodStatus[];
  proxyText: string;
  rejectReason: string;
};
export type MetaItem = { label: string; value: string; tone?: ResultTone };
export function waProbeStatus(result?: WaWorkflowResponse | null): WaProbeStatus {
  const phoneStatus = record(result?.phone_status);
  const accountProbe = record(result?.account_probe);
  const smsProbe = record(result?.sms_probe);
  const proxy = record(result?.proxy);
  const verificationRequest = record(result?.verification_request);
  const registered = firstBool(phoneStatus.registered, accountProbe.registered) ?? registeredSignal(phoneStatus.account_raw_status, accountProbe.raw_status, accountProbe.status);
  const blocked = firstBool(phoneStatus.blocked, accountProbe.blocked) ?? blockedSignal(result?.reject_reason, result?.error_message, result?.status, phoneStatus.account_raw_status, accountProbe.raw_status, accountProbe.status, phoneStatus.account_raw_reason, accountProbe.raw_reason);
  const accountReachable = firstBool(phoneStatus.account_reachable, accountProbe.success) ?? statusIn(['reachable', 'account_probe_status_reachable', 'ok', 'sent', 'valid', 'exists', 'incorrect'], phoneStatus.account_status, accountProbe.account_status, accountProbe.status, accountProbe.raw_status, accountProbe.raw_reason);
  const smsAvailable = firstBool(phoneStatus.sms_available, phoneStatus.can_receive_sms, smsProbe.sms_available, smsProbe.can_send_sms, smsProbe.can_receive_sms, accountProbe.can_send_sms) ?? statusIn(['available', 'sms_available', 'sent', 'waiting', 'ok'], phoneStatus.sms_status, smsProbe.sms_status, smsProbe.status);
  const smsWaitSeconds = firstNumber(phoneStatus.sms_wait_seconds, result?.retry_after_seconds, smsProbe.sms_wait_seconds, smsProbe.wait_seconds, smsProbe.retry_after_seconds, smsProbe.cooldown_seconds, smsProbe.remaining_seconds, accountProbe.sms_wait_seconds);
  const smsWaitUntil = firstText(phoneStatus.sms_wait_until, smsProbe.sms_wait_until, smsProbe.wait_until, smsProbe.retry_after_at, smsProbe.cooldown_until);
  const canRegister = firstBool(phoneStatus.can_register);
  const accountStatus = firstText(phoneStatus.account_status, accountProbe.account_status, accountProbe.status);
  const accountFlow = firstText(phoneStatus.account_flow, accountProbe.account_flow) || deriveAccountFlow({ registered, blocked, smsAvailable, accountStatus, rawReason: firstText(result?.reject_reason, result?.error_message, phoneStatus.account_raw_reason, accountProbe.raw_reason) });
  const accountRawStatus = firstText(phoneStatus.account_raw_status, accountProbe.raw_status);
  const accountRawReason = firstText(phoneStatus.account_raw_reason, accountProbe.raw_reason, phoneStatus.account_error, accountProbe.error_message);
  const accountError = firstText(phoneStatus.account_error, accountProbe.error_message);
  const rejectReason = firstText(phoneStatus.reject_reason, result?.reject_reason, result?.error_message, result?.status);
  const explicitRequestFailed = firstBool(phoneStatus.request_failed, result?.request_failed);
  const requestFailed = explicitRequestFailed ?? (result?.success === false || (accountFlow !== 'registered' && (accountRejected(accountStatus, accountRawReason, accountError) || requestFailure(rejectReason, result?.error_message, result?.status))));
  const methodStatuses = verificationMethodStatuses(phoneStatus.method_statuses, accountProbe.method_statuses, result?.method_statuses, verificationRequest.method_statuses);
  return {
    requestFailed, failureReason: rejectReason || accountRawReason || accountError,
    registered, blocked, accountReachable, smsAvailable, smsWaitSeconds, smsWaitUntil, canRegister, accountFlow,
    accountStatus, accountRawStatus, accountRawReason, accountError,
    smsStatus: firstText(phoneStatus.sms_status, smsProbe.sms_status, smsProbe.status),
    methodStatuses,
    proxyText: compactJoin([firstText(proxy.proxy_mode), firstText(proxy.country_code)], ' · '),
    rejectReason
  };
}
export function outcomeMeta(status: WaProbeStatus, result?: WaWorkflowResponse | null, loading?: boolean): { label: string; variant: BadgeVariant } {
  if (loading) return { label: '执行中', variant: 'secondary' };
  if (!result) return { label: '等待', variant: 'outline' };
  if (status.blocked === true) return { label: '已封禁', variant: 'destructive' };
  if (status.accountFlow === 'invalid_number') return { label: '号码异常', variant: 'secondary' };
  if (status.accountFlow === 'rate_limited') return { label: '限流', variant: 'secondary' };
  if (status.requestFailed) return { label: '请求失败', variant: 'destructive' };
  if (status.registered === true || status.accountFlow === 'registered') return { label: '旧设备可用', variant: 'secondary' };
  if (status.smsAvailable === true) return { label: 'SMS 可发', variant: 'default' };
  if (status.smsAvailable === false) return { label: 'SMS 不可发', variant: 'secondary' };
  if (status.accountFlow === 'not_registered') return { label: '旧设备未知', variant: 'secondary' };
  return { label: '完成', variant: 'secondary' };
}
export function metaItems(status: WaProbeStatus, result?: WaWorkflowResponse | null, showSmsExtra = true): MetaItem[] {
  const entries: MetaItem[] = [];
  if (status.accountFlow === 'rate_limited') {
    addItem(entries, '处理阶段', accountFlowLabel(status.accountFlow), 'warn');
    addItem(entries, 'WA 反馈', accountReasonLabel(status.accountRawReason, status.accountError, status.rejectReason, result?.error_message), 'warn');
    addItem(entries, '代理', status.proxyText);
    return entries;
  }
  if (status.requestFailed) {
    addItem(entries, '账号状态', accountStatusLabel(status.accountStatus || status.accountRawStatus), 'bad');
    addItem(entries, '处理阶段', accountFlowLabel(status.accountFlow), 'bad');
    addItem(entries, 'WA 反馈', accountReasonLabel(status.accountRawReason, status.accountError, status.rejectReason, result?.error_message), 'bad');
    addItem(entries, '失败说明', accountReasonLabel(status.accountError, status.rejectReason, result?.error_message || result?.status), 'bad');
    addItem(entries, '代理', status.proxyText);
    return entries;
  }
  const account = accountFeedback(status);
  addItem(entries, '账号反馈', account, account ? 'warn' : 'idle');
  if (showSmsExtra) addItem(entries, 'SMS补充', smsExtra(status));
  addItem(entries, '代理', status.proxyText);
  return entries;
}
function accountFeedback(status: WaProbeStatus) {
  if (['registered', 'not_registered', 'blocked', 'invalid_number', 'rate_limited'].includes(status.accountFlow)) return '';
  const raw = compactJoin([status.accountStatus, status.accountRawStatus, status.accountRawReason, status.accountError], ' / ');
  const normalized = raw.toLowerCase();
  if (!raw) return '';
  if (normalized.includes('account_probe_status_rejected') || normalized.includes('invalid_skey') || normalized.includes('bad_token')) return accountReasonLabel(status.accountStatus, status.accountRawStatus, status.accountRawReason, status.accountError);
  return accountReasonLabel(...extraValues(status.accountStatus, status.accountRawStatus, status.accountRawReason, status.accountError));
}
function blockedSignal(...values: unknown[]) {
  const normalized = values.map(firstText).join(' ').toLowerCase();
  return normalized ? normalized.includes('blocked') : undefined;
}
function accountRejected(...values: string[]) {
  const normalized = compactJoin(values, ' ').toLowerCase();
  return normalized.includes('account_probe_status_rejected') || normalized.includes('invalid_skey') || normalized.includes('bad_token') || normalized.includes('missing_param') || normalized.includes('bad_param') || normalized.includes('old_version');
}
function requestFailure(...values: unknown[]) {
  const normalized = values.map(firstText).join(' ').toLowerCase();
  if (!normalized || normalized.includes('already registered') || normalized.includes('number is blocked') || normalized.includes('cooling down') || normalized.includes('sms route unavailable')) return false;
  return normalized.startsWith('account probe rejected') || normalized.startsWith('account probe request') || normalized.includes('network') || normalized.includes('unreachable') || normalized.includes('dynamic ip') || normalized.includes('proxy') || normalized.includes(' eof') || normalized.includes('invalid_skey') || normalized.includes('bad_token') || normalized.includes('missing_param') || normalized.includes('bad_param');
}
function smsExtra(status: WaProbeStatus) {
  if (status.smsWaitUntil) return `冷却到 ${status.smsWaitUntil}`;
  if (status.smsWaitSeconds && status.smsWaitSeconds > 0) return `冷却 ${countdownLabel(status.smsWaitSeconds)}`;
  return extraValues(status.smsStatus).join(' / ');
}
function verificationMethodStatuses(...values: unknown[]) {
  const seen = new Map<string, VerificationMethodStatus>();
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) addMethodStatus(seen, item);
      continue;
    }
    addMethodStatus(seen, value);
  }
  return [...seen.values()];
}
function addMethodStatus(seen: Map<string, VerificationMethodStatus>, value: unknown) {
  if (typeof value === 'string') {
    for (const label of methodLabels(value)) upsertMethodStatus(seen, label, true, null);
    return;
  }
  const item = record(value);
  if (!Object.keys(item).length) return;
  const label = methodLabel(firstText(item.method, item.delivery_method, item.name, item.type));
  if (!label) return;
  upsertMethodStatus(seen, label, firstBool(item.available, item.eligible, item.enabled), firstNumber(item.cooldown_seconds, item.wait_seconds, item.retry_after_seconds, durationSeconds(item.cooldown)));
}
function upsertMethodStatus(seen: Map<string, VerificationMethodStatus>, label: string, available?: boolean, cooldownSeconds: number | null = null) {
  const key = label.toLowerCase();
  const previous = seen.get(key);
  seen.set(key, {
    key,
    label,
    available: previous?.available ?? available,
    cooldownSeconds: firstNumber(cooldownSeconds, previous?.cooldownSeconds)
  });
}
function addItem(entries: MetaItem[], label: string, value?: string, tone: ResultTone = 'idle') {
  const text = value?.trim();
  if (text) entries.push({ label, value: text, tone });
}
function registeredSignal(...values: unknown[]) {
  return statusIn(['registered', 'exists', 'account_exists'], ...values) ? true : undefined;
}

function durationSeconds(value: unknown) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function deriveAccountFlow(input: { registered?: boolean; blocked?: boolean; smsAvailable?: boolean; accountStatus: string; rawReason: string }) {
  const raw = compactJoin([input.accountStatus, input.rawReason], ' ').toLowerCase();
  if (input.registered === true || raw.includes('exists') || raw.includes('registered')) return 'registered';
  if (input.blocked === true || raw.includes('blocked')) return 'blocked';
  if (raw.includes('length_short') || raw.includes('length_long') || raw.includes('format_wrong')) return 'invalid_number';
  if (raw.includes('too_recent') || raw.includes('too_many') || raw.includes('temporarily_unavailable')) return 'rate_limited';
  return 'unknown';
}

export function waProbeCanStartRegistration(result?: WaWorkflowResponse | null, method = 'VERIFICATION_DELIVERY_METHOD_SMS', elapsedSeconds = 0) {
  const status = waProbeStatus(result);
  const selectedMethod = methodLabel(method);
  if (!['SMS', '语音', '旧设备', '邮箱', '发送 SMS 至 WA'].includes(selectedMethod)) return false;
  const methodAvailable = status.methodStatuses.some((item) => item.label === selectedMethod && (item.available === true || cooldownExpired(item.cooldownSeconds, elapsedSeconds)) && !cooldownActive(item.cooldownSeconds, elapsedSeconds));
  return Boolean(result)
    && !status.requestFailed
    && methodAvailable
    && status.accountReachable !== false
    && status.blocked !== true
    && status.accountFlow !== 'invalid_number'
    && status.accountFlow !== 'rate_limited';
}

function cooldownActive(value: number | null, elapsedSeconds: number) {
  return Boolean(value && value > elapsedSeconds);
}

function cooldownExpired(value: number | null, elapsedSeconds: number) {
  return Boolean(value && value > 0 && value <= elapsedSeconds);
}
