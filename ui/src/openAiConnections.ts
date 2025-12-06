import { fetchOpenWebuiConfigApi, updateOpenWebuiConfigApi } from './openWebuiApi';
import { getOpenWebUIToken, reportOpenWebUIDebug } from './openWebuiHelpers';
import {
  cloneConfigEntry,
  isRecord,
  OpenWebUIConfig,
  OpenWebUIConfigEntry,
  toStringArray,
} from './openAiConfig';

export const DEFAULT_OPENAI_PROXY_BASE_URL = 'http://host.docker.internal:11700';
export const DEFAULT_OPENAI_PROXY_KEY = '0p3n-w3bu!';

export async function ensureOpenAiProxyConnection(
  baseUrl: string = DEFAULT_OPENAI_PROXY_BASE_URL,
  apiKey: string = DEFAULT_OPENAI_PROXY_KEY,
): Promise<void> {
  const token = getOpenWebUIToken();
  if (!token) {
    return;
  }
  const trimmedBaseUrl = baseUrl.trim();
  if (!trimmedBaseUrl || !apiKey) {
    return;
  }
  try {
    const config = await fetchOpenWebuiConfigApi();
    const baseUrls = toStringArray(config.OPENAI_API_BASE_URLS);
    const keys = toStringArray(config.OPENAI_API_KEYS);
    const normalizedTarget = normalizeBaseUrl(trimmedBaseUrl);
    let index = baseUrls.findIndex((url) => normalizeBaseUrl(url) === normalizedTarget);
    let changed = false;
    if (index === -1) {
      baseUrls.push(trimmedBaseUrl);
      index = baseUrls.length - 1;
      changed = true;
    }
    while (keys.length > baseUrls.length) {
      keys.pop();
    }
    while (keys.length < baseUrls.length) {
      keys.push('');
    }
    if (keys[index] !== apiKey) {
      keys[index] = apiKey;
      changed = true;
    }
    const rawConfigs = isRecord(config.OPENAI_API_CONFIGS) ? (config.OPENAI_API_CONFIGS as Record<string, unknown>) : {};
    const configsArray = baseUrls.map((_, idx) => cloneConfigEntry(rawConfigs[String(idx)]));
    const targetEntry = configsArray[index];
    const normalizedEntry: OpenWebUIConfigEntry = {
      ...targetEntry,
      enable: true,
      tags: Array.isArray(targetEntry.tags) ? [...targetEntry.tags] : [],
      prefix_id: typeof targetEntry.prefix_id === 'string' ? targetEntry.prefix_id : '',
      model_ids: Array.isArray(targetEntry.model_ids) ? [...targetEntry.model_ids] : [],
      connection_type: 'external',
      auth_type: 'bearer',
    };
    const entryChanged = JSON.stringify(targetEntry) !== JSON.stringify(normalizedEntry);
    if (entryChanged) {
      configsArray[index] = normalizedEntry;
      changed = true;
    }
    const configs: Record<string, OpenWebUIConfigEntry> = {};
    configsArray.forEach((entry, idx) => {
      configs[String(idx)] = entry;
    });
    if (!config.ENABLE_OPENAI_API) {
      changed = true;
    }
    if (!changed) {
      return;
    }
    const nextConfig: OpenWebUIConfig = {
      ...config,
      ENABLE_OPENAI_API: true,
      OPENAI_API_BASE_URLS: baseUrls,
      OPENAI_API_KEYS: keys,
      OPENAI_API_CONFIGS: configs,
    };
    await updateOpenWebuiConfigApi(nextConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportOpenWebUIDebug(`Failed to ensure OpenAI proxy connection: ${message}`);
    throw error;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}
