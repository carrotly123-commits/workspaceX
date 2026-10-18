const TEXT_KEYS = [
  'display_text',
  'display_title',
  'title',
  'text',
  'body',
  'description',
  'footer_text',
  'button_text',
  'cta_button_text',
  'url_text',
  'name',
  'message_origin',
  'formatted_amount',
  'formatted_amount_with_currency',
];

const URL_KEYS = ['url', 'merchant_url', 'consented_users_url', 'fallback_url', 'web_url', 'deeplink_url'];

export function normalizeWaMessageText(text: string) {
  const value = normalizeFramedWaText(text);
  if (!value.startsWith('{') || !value.endsWith('}')) return value;
  const parsed = parseJSONObject(value);
  if (!parsed) return value;
  const parts = richTextParts(parsed, 0);
  return parts.length > 0 ? unique(parts).join('\n') : value;
}

function normalizeFramedWaText(text: string) {
  let value = text.trim();
  if (/^2[\x20-\x7e](?=[*\d])/.test(value)) value = value.slice(2).trim();
  if (!/verification code/i.test(value)) return value;
  value = value.replace(/([.!?])[:;]$/, '$1');
  return value.replace(/([.!?])[A-Z]{1,3}$/, '$1');
}

function richTextParts(value: unknown, depth: number): string[] {
  if (depth > 4) return [];
  if (Array.isArray(value)) return unique(value.flatMap((item) => richTextParts(item, depth + 1)));
  if (!isRecord(value)) return [];
  const direct = [...TEXT_KEYS.map((key) => textValue(value[key])), ...URL_KEYS.map((key) => urlValue(value[key]))].filter(Boolean);
  if (direct.length > 0) return unique(direct);
  return unique(Object.values(value).flatMap((item) => richTextParts(item, depth + 1)));
}

function parseJSONObject(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textValue(value: unknown) {
  if (typeof value !== 'string') return '';
  const text = normalizeFramedWaText(value);
  if (!text || text.includes('\0') || isMachineToken(text) || isURL(text)) return '';
  return text;
}

function urlValue(value: unknown) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return isURL(text) ? text : '';
}

function isURL(value: string) {
  const lower = value.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

function isMachineToken(value: string) {
  if (value.length < 16 || value.includes(' ')) return false;
  let matched = 0;
  for (const char of value) if (/^[A-Za-z0-9+/=_-]$/.test(char)) matched++;
  return (matched * 100) / value.length > 95;
}

function unique(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
