export type WaIntegrityMode = 'error_code' | 'play_integrity_api';

export const DEFAULT_WA_INTEGRITY_MODE: WaIntegrityMode = 'error_code';

export function normalizeWaIntegrityMode(value?: string): WaIntegrityMode {
  return value === 'play_integrity_api' ? 'play_integrity_api' : DEFAULT_WA_INTEGRITY_MODE;
}
