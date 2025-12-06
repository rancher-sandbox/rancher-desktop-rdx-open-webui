export interface OpenWebUIConfigEntry {
  enable?: boolean;
  tags?: string[];
  prefix_id?: string;
  model_ids?: string[];
  connection_type?: string;
  auth_type?: string;
  [key: string]: unknown;
}

export interface OpenWebUIConfig {
  ENABLE_OPENAI_API?: boolean;
  OPENAI_API_BASE_URLS?: unknown;
  OPENAI_API_KEYS?: unknown;
  OPENAI_API_CONFIGS?: unknown;
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export function cloneConfigEntry(value: unknown): OpenWebUIConfigEntry {
  if (!isRecord(value)) {
    return {};
  }
  const entry = value as OpenWebUIConfigEntry;
  const clone: OpenWebUIConfigEntry = { ...entry };
  if (Array.isArray(entry.tags)) {
    clone.tags = entry.tags.filter((item): item is string => typeof item === 'string');
  } else {
    delete clone.tags;
  }
  if (Array.isArray(entry.model_ids)) {
    clone.model_ids = entry.model_ids.filter((item): item is string => typeof item === 'string');
  } else {
    delete clone.model_ids;
  }
  if (typeof entry.prefix_id !== 'string') {
    delete clone.prefix_id;
  }
  if (typeof entry.connection_type !== 'string') {
    delete clone.connection_type;
  }
  if (typeof entry.auth_type !== 'string') {
    delete clone.auth_type;
  }
  if (typeof entry.enable !== 'boolean') {
    delete clone.enable;
  }
  return clone;
}
