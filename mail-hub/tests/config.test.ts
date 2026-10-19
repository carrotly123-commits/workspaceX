import { describe, expect, it } from 'vitest';
import { isLoopbackHost, loadConfig, PLACEHOLDER_API_SECRET, validateConfig } from '../src/config.js';

describe('configuration validation', () => {
  it('accepts default configuration', () => {
    const cfg = loadConfig({});
    const result = validateConfig(cfg);

    expect(result.errors).toEqual([]);
  });

  it('rejects invalid port and proxy values', () => {
    const cfg = loadConfig({
      PORT: '99999',
      PROXY_URL: 'not-a-url',
    });
    const result = validateConfig(cfg);

    expect(result.errors).toContain('PORT must be an integer between 1 and 65535');
    expect(result.errors).toContain('PROXY_URL must be a valid URL');
  });

  it('warns when API_SECRET is empty', () => {
    const cfg = loadConfig({ API_SECRET: '' });
    const result = validateConfig(cfg);

    expect(result.warnings).toContain('API_SECRET is empty; all API routes will run with admin access');
  });

  it('defaults to loopback host', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
  });

  it('rejects empty or placeholder API_SECRET on non-loopback hosts', () => {
    for (const secret of ['', PLACEHOLDER_API_SECRET]) {
      const result = validateConfig(loadConfig({ HOST: '0.0.0.0', API_SECRET: secret }));
      expect(result.errors.some((e) => e.startsWith('API_SECRET must be set'))).toBe(true);
    }
  });

  it('allows non-loopback hosts with a real API_SECRET', () => {
    const result = validateConfig(loadConfig({ HOST: '0.0.0.0', API_SECRET: 's3cret-value' }));
    expect(result.errors).toEqual([]);
  });

  it('warns about placeholder API_SECRET on loopback', () => {
    const result = validateConfig(loadConfig({ HOST: 'localhost', API_SECRET: PLACEHOLDER_API_SECRET }));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain('API_SECRET is still the example placeholder; change it to a random string');
  });

  it('recognises loopback addresses', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '192.168.1.2', '::', 'example.com']) expect(isLoopbackHost(h)).toBe(false);
  });

  it('validates request log volume controls', () => {
    const cfg = loadConfig({
      REQUEST_LOG_SAMPLE_RATE: '2',
      REQUEST_LOG_SLOW_MS: '-1',
    });
    const result = validateConfig(cfg);

    expect(result.errors).toContain('REQUEST_LOG_SAMPLE_RATE must be a number between 0 and 1');
    expect(result.errors).toContain('REQUEST_LOG_SLOW_MS must be a non-negative number');
  });
});
