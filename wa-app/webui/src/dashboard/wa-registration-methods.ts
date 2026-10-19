import { RegistrationLoginMethod, VerificationDeliveryMethod } from '../proto/byte/v/forge/waapp/v1/registration';
import { methodLabel } from './wa-result-labels';
import type { VerificationMethodStatus, WaProbeStatus } from './wa-result-model';

export type RegistrationMethodOption = {
  value: VerificationDeliveryMethod | RegistrationLoginMethod;
  code: string;
  label: string;
};
export type SelectableRegistrationMethodOption = Omit<RegistrationMethodOption, 'value'> & {
  value: VerificationDeliveryMethod;
};
export type RegistrationChannelMethodOption = SelectableRegistrationMethodOption & {
  directRequest: boolean;
};

export const selectableRegistrationMethods: SelectableRegistrationMethodOption[] = [
  methodOption(VerificationDeliveryMethod.VERIFICATION_DELIVERY_METHOD_SMS, 'sms'),
  methodOption(VerificationDeliveryMethod.VERIFICATION_DELIVERY_METHOD_VOICE, 'voice'),
  methodOption(VerificationDeliveryMethod.VERIFICATION_DELIVERY_METHOD_WA_OLD, 'wa_old'),
  methodOption(VerificationDeliveryMethod.VERIFICATION_DELIVERY_METHOD_EMAIL_OTP, 'email_otp'),
  methodOption(VerificationDeliveryMethod.VERIFICATION_DELIVERY_METHOD_SEND_SMS, 'send_sms'),
];
export const visibleRegistrationChannelMethods: RegistrationChannelMethodOption[] = [
  ...selectableRegistrationMethods.map((method) => ({ ...method, directRequest: true })),
  channelMethodOption(VerificationDeliveryMethod.VERIFICATION_DELIVERY_METHOD_FLASH, 'flash', false),
];

export const apkSupportedLoginRegistrationMethods = [
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_SMS, 'sms'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_VOICE, 'voice'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_WA_OLD, 'wa_old'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_EMAIL_OTP, 'email_otp'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_SEND_SMS, 'send_sms'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_FLASH, 'flash'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_SILENT_AUTH, 'silent_auth'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_SILENT_AUTH_TS43, 'silent_auth_ts_43'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_AUTOCONF, 'autoconf'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_DEEPLINK_OTP, 'deeplink_otp'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_PASSKEY, 'passkey'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_DISCOVERABLE_CREDENTIAL, 'discoverable_credential'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_OAUTH_EMAIL, 'oauth_email'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_RECAPTCHA, 'recaptcha'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_TWO_FACTOR_PIN, 'twofac_pin'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_PASSWORD, 'password'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_WIPE_FULL, 'wipe_full'),
  loginMethodOption(RegistrationLoginMethod.REGISTRATION_LOGIN_METHOD_WIPE_OFFLINE, 'wipe_offline'),
];

export function registrationMethodStatus(status: WaProbeStatus, method: VerificationDeliveryMethod) {
  return status.methodStatuses.find((item) => methodStatusMatches(item, method));
}

export function registrationMethodCooldownSeconds(status: WaProbeStatus, method: VerificationDeliveryMethod, elapsedSeconds = 0) {
  const methodStatus = registrationMethodStatus(status, method);
  const smsFallback = method === VerificationDeliveryMethod.VERIFICATION_DELIVERY_METHOD_SMS ? status.smsWaitSeconds || 0 : 0;
  const base = methodStatus?.cooldownSeconds || smsFallback;
  return base > 0 ? Math.max(0, Math.ceil(base - elapsedSeconds)) : 0;
}

export function registrationMethodAvailable(status: WaProbeStatus, method: VerificationDeliveryMethod, elapsedSeconds = 0) {
  const methodStatus = registrationMethodStatus(status, method);
  if (!methodStatus) return false;
  if (registrationMethodCooldownSeconds(status, method, elapsedSeconds) > 0) return false;
  if (methodStatus.cooldownSeconds && methodStatus.cooldownSeconds > 0) return true;
  return methodStatus.available === true;
}

export function registrationAnyMethodAvailable(status: WaProbeStatus | null, elapsedSeconds = 0) {
  return Boolean(status && selectableRegistrationMethods.some((option) => registrationMethodAvailable(status, option.value, elapsedSeconds)));
}

export function registrationMinimumCooldownSeconds(status: WaProbeStatus | null, elapsedSeconds = 0) {
  if (!status) return 0;
  const values = selectableRegistrationMethods
    .map((option) => registrationMethodCooldownSeconds(status, option.value, elapsedSeconds))
    .filter((value) => value > 0);
  return values.length ? Math.min(...values) : 0;
}

export function registrationChannelsHardBlocked(status: WaProbeStatus | null) {
  return Boolean(status?.blocked === true || status?.accountFlow === 'invalid_number');
}

function methodOption(value: VerificationDeliveryMethod, code: string): SelectableRegistrationMethodOption {
  return { value, code, label: methodLabel(code) };
}

function channelMethodOption(value: VerificationDeliveryMethod, code: string, directRequest: boolean): RegistrationChannelMethodOption {
  return { ...methodOption(value, code), directRequest };
}

function loginMethodOption(value: RegistrationLoginMethod, code: string): RegistrationMethodOption {
  return { value, code, label: methodLabel(code) };
}

function methodStatusMatches(status: VerificationMethodStatus, method: VerificationDeliveryMethod) {
  return status.key === methodLabel(method).toLowerCase() || status.key === methodLabel(methodCode(method)).toLowerCase();
}

function methodCode(method: VerificationDeliveryMethod) {
  return selectableRegistrationMethods.find((item) => item.value === method)?.code || '';
}
