import { useEffect, useState } from 'react';
import {
  getWaDashboardHealth,
  getWaPlayIntegrityAPIStatus,
  type WaDashboardHealth,
  type WaPlayIntegrityAPIStatus,
} from './wa-dashboard-config';
import type { WaIntegrityMode } from './wa-integrity';

export function useWaDashboardHealth() {
  const [health, setHealth] = useState<WaDashboardHealth | null>(null);
  useEffect(() => {
    let active = true;
    getWaDashboardHealth().then((value) => {
      if (active) setHealth(value);
    }).catch(() => {
      if (active) setHealth(null);
    });
    return () => {
      active = false;
    };
  }, []);
  return health;
}

export function useWaPlayIntegrityAPIStatus(enabled: boolean, mode: WaIntegrityMode) {
  const [status, setStatus] = useState<WaPlayIntegrityAPIStatus | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || mode !== 'play_integrity_api') {
      setStatus(null);
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    getWaPlayIntegrityAPIStatus().then((value) => {
      if (active) setStatus(value);
    }).catch(() => {
      if (active) setStatus(null);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [enabled, mode]);
  return { status, loading };
}
