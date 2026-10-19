import { api } from './wa-api';

export type WaDashboardHealth = {
  ok?: boolean;
  capabilities?: { play_integrity_api?: boolean };
  registration?: { integrity_modes?: string[] };
};

export type WaPlayIntegrityVMStatus = {
  enabled?: boolean;
  state?: string;
  processRunning?: boolean;
  busy?: boolean;
  prewarmStarted?: boolean;
  prewarmCompleted?: boolean;
  prewarmElapsedMs?: number;
  requestCount?: number;
  successCount?: number;
  failureCount?: number;
  warmupTimings?: Record<string, number | boolean | string | null>;
  lastTimings?: Record<string, number | boolean | string | null>;
  lastErrorLen?: number;
  rawValuesPrinted?: boolean;
};

export type WaPlayIntegrityAPIStatus = {
  configured?: boolean;
  ok?: boolean;
  available?: boolean;
  dgRunnerMode?: string;
  maxConcurrency?: number;
  totalRequests?: number;
  successRequests?: number;
  failedRequests?: number;
  poTokenBackendConfigured?: boolean;
  vm?: WaPlayIntegrityVMStatus;
  rawValuesPrinted?: boolean;
  unavailableReasonLen?: number;
};

export function getWaDashboardHealth() {
  return api<WaDashboardHealth>('/api/wa/health');
}

export function getWaPlayIntegrityAPIStatus() {
  return api<WaPlayIntegrityAPIStatus>('/api/wa/play-integrity/status');
}

export function waPlayIntegrityAvailable(health: WaDashboardHealth | null) {
  return Boolean(health?.capabilities?.play_integrity_api);
}
