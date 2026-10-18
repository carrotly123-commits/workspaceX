import type { WaWorkflowResponse } from './wa-api';
import { accountReasonLabel, countdownLabel } from './wa-result-labels';
import type { WaProbeStatus } from './wa-result-model';
import { resolveWaPhoneTarget, type WaResolvedPhone } from './wa-utils';

export type WaAccountAddProbeState = { target: WaResolvedPhone; result: WaWorkflowResponse } | null;

export function probeMatchesValues(probe: WaAccountAddProbeState, phone: string, countryCallingCode: string) {
  if (!probe) return false;
  return resolveWaPhoneTarget(phone, countryCallingCode).target?.e164 === probe.target.e164;
}

export function workflowText(result: WaWorkflowResponse, key: keyof WaWorkflowResponse) {
  const value = result[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function registrationFailureMessage(result: WaWorkflowResponse, status: WaProbeStatus) {
  const detail = status.failureReason || result.error_message || result.status || '';
  const reason = accountReasonLabel(detail);
  if (status.blocked) return '号码被拒绝/封禁';
  if (status.accountFlow === 'invalid_number') return reason || '号码无效';
  if (status.smsWaitSeconds && status.smsWaitSeconds > 0) return `请求冷却中，${countdownLabel(status.smsWaitSeconds)} 后重试`;
  if (status.accountFlow === 'rate_limited') return reason || '请求冷却中';
  return reason || '注册失败';
}

export async function copyClipboardText(value: string, onDone: (message: string) => void, onError: (message: string) => void) {
  try {
    await navigator.clipboard.writeText(value);
    onDone('已复制');
  } catch {
    onError('复制失败');
  }
}
