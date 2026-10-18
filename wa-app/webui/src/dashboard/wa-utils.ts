import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { WaPhoneInput, WaWorkflowResponse } from './wa-api';
import { accountReasonLabel } from './wa-result-labels';

const PHONE_NOT_POSSIBLE_MESSAGE = '手机号位数不符合国家规则，请检查国家拨号码和手机号。';

export type WaResolvedPhone = {
  e164: string;
  input: WaPhoneInput;
};

export type WaPhoneResolveResult = { target: WaResolvedPhone | null; error?: string };

export function resolveWaPhoneTarget(value: string, countryCallingCode = ''): WaPhoneResolveResult {
  const raw = value.trim();
  const digits = value.replace(/\D+/g, '');
  if (!digits) return { target: null, error: '请输入手机号' };
  const callingCode = countryCallingCode.replace(/\D+/g, '');
  if (!callingCode) return { target: null, error: '请输入国家拨号码，例如 992。' };
  const parseInput = raw.startsWith('+') ? raw : internationalNumberFromCallingCode(digits, callingCode);
  const phone = parsePhoneNumberFromString(parseInput);
  if (!phone?.countryCallingCode || !phone.nationalNumber) {
    return { target: null, error: '手机号无法解析，请输入手机号和国家拨号码。' };
  }
  if (phone.countryCallingCode !== callingCode) {
    return { target: null, error: `手机号与拨号码不一致：号码为 +${phone.countryCallingCode}，拨号码为 +${callingCode}。` };
  }
  if (!phone.isPossible()) {
    return { target: null, error: PHONE_NOT_POSSIBLE_MESSAGE };
  }
  const e164 = phone.number;
  const countryCode = phone.country || '';
  return {
    target: {
      e164,
      input: {
        region: countryCode,
        phone: phone.nationalNumber,
        e164_number: e164,
        country_calling_code: phone.countryCallingCode,
        country_iso2: countryCode
      }
    }
  };
}

export function resultStatus(result?: WaWorkflowResponse | null) {
  if (!result) return '未执行';
  if (result.success || result.passed) return '通过';
  return accountReasonLabel(result.error_message, result.status) || '失败';
}

export function proxyArea(result?: WaWorkflowResponse | null) {
  const proxy = result?.proxy || {};
  const mode = text(proxy.proxy_mode);
  if (mode === 'US_ROTATING_DYNAMIC_IP' || mode === 'US_RANDOM_DYNAMIC_IP') return '美国轮转动态 IP';
  if (mode === 'US_STICKY_DYNAMIC_IP') return '美国粘性动态 IP';
  if (mode === 'DIRECT') return '直连';
  return mode || '-';
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sensitiveKey(key) ? '***' : redactSensitive(nested)]));
}

export function displayValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

export function boolValue(value: unknown) {
  return value === true || value === 'true' || value === 'yes' || value === '1';
}

function sensitiveKey(key: string) {
  return /(otp|code|token|auth|key|cookie|secret|password|session|enc|body|proxy_url)/i.test(key);
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function internationalNumberFromCallingCode(digits: string, callingCode: string) {
  if (!callingCode) return '';
  return `+${digits.startsWith(callingCode) ? digits : `${callingCode}${digits}`}`;
}
