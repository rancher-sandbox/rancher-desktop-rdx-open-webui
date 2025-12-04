import { toast } from 'react-toastify';

export type CatalogSourceType = 'http' | 'registry';

export interface CatalogSourceDefinition {
  id: string;
  url: string;
  type: CatalogSourceType;
  key?: string;
  label?: string;
  isDefault?: boolean;
}

export const CATALOG_SOURCES_STORAGE_KEY = 'rdx.catalog-sources';
export const CATALOG_SOURCES_EVENT = 'rdx:catalog-sources-updated';

export const DEFAULT_CATALOG_SOURCE: CatalogSourceDefinition = {
  id: 'docker-hub-mcp-default',
  url: 'https://hub.docker.com/v2/namespaces/mcp/repositories',
  type: 'http',
  label: 'Docker Hub (mcp)',
  isDefault: true,
};

const SOURCE_TYPE_FALLBACK: CatalogSourceType = 'http';

function normalizeType(value: string | undefined): CatalogSourceType {
  if (!value) {
    return SOURCE_TYPE_FALLBACK;
  }
  const normalized = value.toLowerCase();
  if (normalized === 'registry') {
    return 'registry';
  }
  return SOURCE_TYPE_FALLBACK;
}

function cloneSource(source: CatalogSourceDefinition): CatalogSourceDefinition {
  return {
    id: source.id,
    url: source.url,
    type: source.type,
    key: source.key ?? '',
    label: source.label,
    isDefault: source.isDefault,
  };
}

function sanitizeSource(source: Partial<CatalogSourceDefinition> | null | undefined): CatalogSourceDefinition | null {
  if (!source || typeof source !== 'object') {
    return null;
  }
  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : generateSourceId();
  const url = typeof source.url === 'string' ? source.url.trim() : '';
  if (!url) {
    return null;
  }
  const key = typeof source.key === 'string' ? source.key : '';
  const type = normalizeType(typeof source.type === 'string' ? source.type : undefined);
  const sanitized: CatalogSourceDefinition = {
    id,
    url,
    type,
    key,
  };
  if (source.label && typeof source.label === 'string') {
    sanitized.label = source.label;
  }
  return sanitized;
}

function ensureDefaultSource(sources: CatalogSourceDefinition[]): CatalogSourceDefinition[] {
  const cloned = sources.map((source) => ({ ...source }));
  const existingIndex = cloned.findIndex((source) => source.id === DEFAULT_CATALOG_SOURCE.id);
  if (existingIndex >= 0) {
    const current = cloned[existingIndex];
    cloned[existingIndex] = {
      ...current,
      url: DEFAULT_CATALOG_SOURCE.url,
      type: DEFAULT_CATALOG_SOURCE.type,
      label: DEFAULT_CATALOG_SOURCE.label,
      isDefault: true,
    };
  } else {
    cloned.unshift({ ...DEFAULT_CATALOG_SOURCE });
  }
  return cloned;
}

export function readStoredCatalogSources(): CatalogSourceDefinition[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return ensureDefaultSource([]);
  }
  try {
    const raw = window.localStorage.getItem(CATALOG_SOURCES_STORAGE_KEY);
    if (!raw) {
      return ensureDefaultSource([]);
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return ensureDefaultSource([]);
    }
    const sanitized = parsed
      .map((entry) => sanitizeSource(entry))
      .filter((entry): entry is CatalogSourceDefinition => Boolean(entry));
    return ensureDefaultSource(sanitized);
  } catch (error) {
    console.warn('[catalog-sources] Failed to read stored sources', error);
    toast.error('Unable to read stored catalog sources. Using defaults.');
    return ensureDefaultSource([]);
  }
}

export function getEffectiveCatalogSources(): CatalogSourceDefinition[] {
  return readStoredCatalogSources();
}

function sanitizeForStorage(sources: CatalogSourceDefinition[]): CatalogSourceDefinition[] {
  return ensureDefaultSource(
    sources
      .map((source) => sanitizeSource(source))
      .filter((entry): entry is CatalogSourceDefinition => Boolean(entry))
      .map((entry) => {
        if (entry.id === DEFAULT_CATALOG_SOURCE.id) {
          return {
            ...DEFAULT_CATALOG_SOURCE,
            key: entry.key ?? '',
          };
        }
        return entry;
      }),
  );
}

export function writeStoredCatalogSources(sources: CatalogSourceDefinition[]): CatalogSourceDefinition[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return ensureDefaultSource(sources);
  }
  try {
    const sanitized = sanitizeForStorage(sources);
    const payload = sanitized.map(({ isDefault, label, ...entry }) => ({ ...entry }));
    window.localStorage.setItem(CATALOG_SOURCES_STORAGE_KEY, JSON.stringify(payload));
    notifyCatalogSourcesChanged();
    return ensureDefaultSource(payload);
  } catch (error) {
    console.warn('[catalog-sources] Failed to persist sources', error);
    toast.error('Unable to save catalog sources.');
    return readStoredCatalogSources();
  }
}

export function createCatalogSource(overrides?: Partial<CatalogSourceDefinition>): CatalogSourceDefinition {
  const base: CatalogSourceDefinition = {
    id: generateSourceId(),
    url: '',
    type: 'http',
    key: '',
  };
  return {
    ...base,
    ...overrides,
    type: normalizeType(overrides?.type),
    isDefault: overrides?.isDefault ?? false,
  };
}

function generateSourceId(): string {
  return `catalog-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function notifyCatalogSourcesChanged() {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(CATALOG_SOURCES_EVENT));
}

export function subscribeToCatalogSources(callback: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  const handler = () => callback();
  const storageHandler = (event: StorageEvent) => {
    if (event.key === CATALOG_SOURCES_STORAGE_KEY) {
      callback();
    }
  };
  window.addEventListener(CATALOG_SOURCES_EVENT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(CATALOG_SOURCES_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}

export function describeCatalogSource(source: CatalogSourceDefinition): string {
  const typeLabel = source.type === 'registry' ? 'Registry' : 'HTTP';
  if (source.label) {
    return `${source.label} (${typeLabel})`;
  }
  try {
    const parsed = new URL(source.url);
    return `${parsed.host} (${typeLabel})`;
  } catch {
    return `${source.url} (${typeLabel})`;
  }
}
