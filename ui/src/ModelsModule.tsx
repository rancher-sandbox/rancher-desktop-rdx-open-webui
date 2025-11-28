import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import { toast } from 'react-toastify';
import './ModuleContent.css';
import './ModelsModule.css';

const ddClient = createDockerDesktopClient();

type EngineId = 'ollama' | 'llamaedge';
type Status =
  | 'ready'
  | 'downloading'
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'deleting'
  | 'error'
  | 'not running';

interface RowItem {
  id: string;
  name: string;
  status: Status;
  port?: number;
  sizeBytes?: number;
  createdAt?: string;
  engine: EngineId;
  extra?: Record<string, unknown>;
}

function isLlamaEdgePresetRow(row: RowItem): boolean {
  return row.engine === 'llamaedge' && row.id.startsWith('preset:');
}

function isDefaultLlamaEdgeRow(row: RowItem): boolean {
  if (row.engine !== 'llamaedge') {
    return false;
  }
  if (isLlamaEdgePresetRow(row)) {
    return true;
  }
  const imageRef = typeof row.extra?.Image === 'string' ? row.extra.Image : row.name;
  return DEFAULT_LLAMAEDGE_IMAGE_SET.has(imageRef);
}

interface EngineState {
  items: RowItem[];
  loading: boolean;
  error: string;
}

interface ModalState {
  engine: EngineId;
  value: string;
  error: string;
  busy: boolean;
  progress?: string;
}

const ENGINE_CONFIG: Record<EngineId, {
  label: string;
  modalTitle: string;
  modalDescription: string;
  inputLabel: string;
  placeholder: string;
  helperText: string;
  submitLabel: string;
  emptyMessage: string;
}> = {
  ollama: {
    label: 'Ollama',
    modalTitle: 'Download Ollama Model',
    modalDescription: 'Provide a model name as listed on Ollama (for example llama3.1:8b).',
    inputLabel: 'Model name',
    placeholder: 'llama3.1:8b',
    helperText: 'Find model names at https://ollama.com/library or via `ollama list`.',
    submitLabel: 'Download',
    emptyMessage: 'No models yet. Click Download/Run to get started.',
  },
  llamaedge: {
    label: 'LlamaEdge',
    modalTitle: 'Run LlamaEdge Container',
    modalDescription: 'Enter a container image that exposes port 8080 inside the container.',
    inputLabel: 'Container image',
    placeholder: 'myrepo/llamaedge-phi4:latest',
    helperText: 'Image must expose port 8080. A host port in 11900–12000 will be assigned automatically.',
    submitLabel: 'Run',
    emptyMessage: 'No LlamaEdge containers found. Click Download/Run to start one.',
  },
};

const OLLAMA_BASE_URLS = ['http://localhost:11434', 'http://host.docker.internal:11434'];

const buildOllamaUrls = (path: string) => OLLAMA_BASE_URLS.map((base) => `${base}${path}`);

async function fetchWithFallback(urls: string[], init?: RequestInit) {
  let lastError: unknown;

  for (const url of urls) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`Unable to reach service at ${urls.join(', ')}: ${lastError.message}`);
  }
  throw new Error(`Unable to reach service at ${urls.join(', ')}`);
}

const OPEN_WEBUI_CONFIG_URL = 'http://localhost:12000/api/openai/config';
const OPEN_WEBUI_CONFIG_UPDATE_URL = 'http://localhost:12000/api/openai/config/update';
const LLAMAEDGE_CONNECTION_BASE = 'http://host.docker.internal';
export const OPEN_WEBUI_TOKEN_STORAGE_KEY = 'rdx.open-webui-token';
const DEFAULT_LLAMAEDGE_IMAGES = [
  'matamagu/qwen2-0.5b-instruct:0.1.0',
  'matamagu/deepseek-r1-distill-qwen-7b:0.1.0',
  'matamagu/gemma-3-12b-it:0.1.0',
  'matamagu/llama-3.2-3b-instruct:0.1.0',
];
const DEFAULT_LLAMAEDGE_IMAGE_SET = new Set(DEFAULT_LLAMAEDGE_IMAGES);

const reportedDebugMessages = new Set<string>();

function reportOpenWebUIDebug(message: string) {
  const id = `openwebui-debug-${message}`;
  if (reportedDebugMessages.has(id)) {
    return;
  }
  reportedDebugMessages.add(id);
  toast.info(message, { toastId: id, autoClose: 15000 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readStoredOpenWebUIToken(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    return window.localStorage.getItem(OPEN_WEBUI_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredOpenWebUIToken(token: string | null) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    if (!token) {
      window.localStorage.removeItem(OPEN_WEBUI_TOKEN_STORAGE_KEY);
    } else {
      window.localStorage.setItem(OPEN_WEBUI_TOKEN_STORAGE_KEY, token);
    }
  } catch (error) {
    reportOpenWebUIDebug(
      `Failed to persist token override: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function getOpenWebUIToken(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  const stored = readStoredOpenWebUIToken();
  if (stored) {
    return stored;
  }
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) {
        keys.push(key);
      }
    }
  } catch (error) {
    reportOpenWebUIDebug(`Failed to enumerate localStorage keys: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const raw = window.localStorage.getItem('token');
    if (!raw) {
      reportOpenWebUIDebug('Token entry missing from localStorage');
      return null;
    }
    
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') {        
        return parsed;
      }
      if (isRecord(parsed)) {
        if (typeof parsed.token === 'string') {
          return parsed.token;
        }
        if (typeof parsed.access_token === 'string') {
          return parsed.access_token;
        }
      }
      return raw;
    } catch (error) {
      reportOpenWebUIDebug(`Failed to parse token JSON; using raw string (${error instanceof Error ? error.message : String(error)})`);
      return raw;
    }
  } catch (error) {
    reportOpenWebUIDebug(`Unexpected error while reading token: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

interface OpenWebUIConfigEntry {
  enable?: boolean;
  tags?: string[];
  prefix_id?: string;
  model_ids?: string[];
  connection_type?: string;
  auth_type?: string;
  [key: string]: unknown;
}

interface OpenWebUIConfig {
  ENABLE_OPENAI_API?: boolean;
  OPENAI_API_BASE_URLS?: string[];
  OPENAI_API_KEYS?: string[];
  OPENAI_API_CONFIGS?: Record<string, OpenWebUIConfigEntry>;
  [key: string]: unknown;
}

const LLAMAEDGE_CONFIG_TEMPLATE: OpenWebUIConfigEntry = {
  enable: true,
  tags: [],
  prefix_id: '',
  model_ids: [],
  connection_type: 'external',
  auth_type: 'bearer',
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function cloneConfigEntry(value: unknown): OpenWebUIConfigEntry {
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

async function fetchOpenWebUIConfig(): Promise<OpenWebUIConfig> {
  const token = getOpenWebUIToken();
  if (!token) {
    throw new Error(
      'Unable to access Open WebUI config: no auth token configured. Use Settings to provide one.',
    );
  }
  try {
    return await fetchOpenWebUIConfigViaBrowser(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportOpenWebUIDebug(`Browser config fetch failed: ${message}`);
    throw (error instanceof Error ? error : new Error(message));
  }
}

async function saveOpenWebUIConfig(config: OpenWebUIConfig): Promise<void> {
  const token = getOpenWebUIToken();
  if (!token) {
    reportOpenWebUIDebug('No auth token available for config update');
    throw new Error(
      'Unable to update Open WebUI config: no auth token configured. Use Settings to provide one.',
    );
  }
  
  try {
    await saveOpenWebUIConfigViaBrowser(token, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportOpenWebUIDebug(`Browser config update failed: ${message}`);
    throw (error instanceof Error ? error : new Error(message));
  }
}

async function fetchOpenWebUIConfigViaBrowser(token: string): Promise<OpenWebUIConfig> {
  let response: Response;
  try {
    response = await fetch(OPEN_WEBUI_CONFIG_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to reach Open WebUI at ${OPEN_WEBUI_CONFIG_URL}: ${message}`);
  }
  if (!response.ok) {
    let message = '';
    try {
      message = (await response.text()).trim();
    } catch {
      message = '';
    }
    throw new Error(message || `Open WebUI config request failed (${response.status})`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Open WebUI config is not valid JSON: ${message}`);
  }
  if (!isRecord(payload)) {
    throw new Error('Open WebUI config response is not an object');
  }
  return payload as OpenWebUIConfig;
}

async function saveOpenWebUIConfigViaBrowser(token: string, config: OpenWebUIConfig): Promise<void> {
  let response: Response;
  try {
    response = await fetch(OPEN_WEBUI_CONFIG_UPDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(config),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to update Open WebUI config: ${message}`);
  }
  if (!response.ok) {
    let message = '';
    try {
      message = (await response.text()).trim();
    } catch {
      message = '';
    }
    throw new Error(message || `Open WebUI config update failed (${response.status})`);
  }
}

async function ensureLlamaEdgeConnection(port: number): Promise<void> {
  const config = await fetchOpenWebUIConfig();
  const baseUrls = toStringArray(config.OPENAI_API_BASE_URLS);
  const keys = toStringArray(config.OPENAI_API_KEYS);
  const targetUrl = `${LLAMAEDGE_CONNECTION_BASE}:${port}/v1`;
  let index = baseUrls.findIndex((url) => url === targetUrl);
  if (index === -1) {
    index = baseUrls.length;
    baseUrls.push(targetUrl);
  }
  while (keys.length > baseUrls.length) {
    keys.pop();
  }
  while (keys.length < baseUrls.length) {
    keys.push('');
  }
  const rawConfigs = isRecord(config.OPENAI_API_CONFIGS) ? config.OPENAI_API_CONFIGS : {};
  const existing = cloneConfigEntry(rawConfigs[String(index)]);
  const nextEntry: OpenWebUIConfigEntry = {
    ...existing,
    enable: true,
    tags: Array.isArray(existing.tags) ? [...existing.tags] : [],
    prefix_id: typeof existing.prefix_id === 'string' ? existing.prefix_id : '',
    model_ids: Array.isArray(existing.model_ids) ? [...existing.model_ids] : [],
    connection_type: 'external',
    auth_type: 'bearer',
  };
  const configsArray = baseUrls.map((_, idx) =>
    idx === index ? nextEntry : cloneConfigEntry(rawConfigs[String(idx)]),
  );
  const configs: Record<string, OpenWebUIConfigEntry> = {};
  configsArray.forEach((entry, idx) => {
    configs[String(idx)] = entry;
  });
  await saveOpenWebUIConfig({
    ...config,
    ENABLE_OPENAI_API: true,
    OPENAI_API_BASE_URLS: baseUrls,
    OPENAI_API_KEYS: keys,
    OPENAI_API_CONFIGS: configs,
  });
}

async function removeLlamaEdgeConnection(port?: number): Promise<void> {
  if (!port) {
    return;
  }
  const config = await fetchOpenWebUIConfig();
  const baseUrls = toStringArray(config.OPENAI_API_BASE_URLS);
  const keys = toStringArray(config.OPENAI_API_KEYS);
  const rawConfigs = isRecord(config.OPENAI_API_CONFIGS) ? config.OPENAI_API_CONFIGS : {};
  const configsArray = baseUrls.map((_, idx) => cloneConfigEntry(rawConfigs[String(idx)]));
  const targetUrl = `${LLAMAEDGE_CONNECTION_BASE}:${port}`;
  const targetUrlWithPath = `${targetUrl}/v1`;
  const index = baseUrls.findIndex((url) => url === targetUrlWithPath || url === targetUrl);
  if (index === -1) {
    return;
  }
  baseUrls.splice(index, 1);
  if (index < configsArray.length) {
    configsArray.splice(index, 1);
  }
  if (index < keys.length) {
    keys.splice(index, 1);
  }
  while (keys.length > baseUrls.length) {
    keys.pop();
  }
  while (keys.length < baseUrls.length) {
    keys.push('');
  }
  const configs: Record<string, OpenWebUIConfigEntry> = {};
  configsArray.forEach((entry, idx) => {
    configs[String(idx)] = entry;
  });
  await saveOpenWebUIConfig({
    ...config,
    OPENAI_API_BASE_URLS: baseUrls,
    OPENAI_API_KEYS: keys,
    OPENAI_API_CONFIGS: configs,
  });
}

function formatBytes(bytes?: number): string {
  if (!bytes || Number.isNaN(bytes)) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const precision = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[index]}`;
}

function formatStatus(status: Status): string {
  return status
    .split(' ')
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function statusClass(status: Status): string {
  switch (status) {
    case 'running':
      return 'is-running';
    case 'starting':
    case 'downloading':
    case 'stopping':
    case 'deleting':
      return 'is-downloading';
    case 'error':
      return 'is-error';
    default:
      return '';
  }
}

async function listOllamaModels(): Promise<RowItem[]> {
  const response = await fetchWithFallback(buildOllamaUrls('/api/tags'));
  if (!response.ok) {
    throw new Error(`Ollama list failed (${response.status})`);
  }
  const payload = await response.json();
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models
    .map((model: any): RowItem => ({
      id: String(model?.name ?? ''),
      name: String(model?.name ?? ''),
      status: 'ready',
      sizeBytes: typeof model?.size === 'number' ? model.size : undefined,
      engine: 'ollama',
      extra: model ?? undefined,
    }))
    .filter((item: any) => item.id);
}

async function downloadOllamaModel(model: string, onProgress?: (status: string) => void) {
  const response = await fetchWithFallback(buildOllamaUrls('/api/pull'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!response.ok) {
    const message = (await response.text()) || 'Download failed';
    throw new Error(message.trim());
  }

  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const json = JSON.parse(trimmed);
          if (json.status) {
            onProgress?.(String(json.status));
          }
        } catch {
          onProgress?.(trimmed);
        }
      }
    }

    const remaining = buffer.trim();
    if (remaining) {
      try {
        const json = JSON.parse(remaining);
        if (json.status) {
          onProgress?.(String(json.status));
        }
      } catch {
        onProgress?.(remaining);
      }
    }
    onProgress?.('Download complete');
  } finally {
    reader.releaseLock();
  }
}

async function deleteOllamaModel(model: string) {
  const response = await fetchWithFallback(buildOllamaUrls('/api/delete'), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) {
    const message = (await response.text()) || 'Delete failed';
    throw new Error(message.trim());
  }
}

async function dockerCliWithResult(command: string, args: string[]) {
  const result = await ddClient.docker.cli.exec(command, args);
  if (result.stderr?.trim()) {
    console.debug(`[docker ${command}]`, result.stderr.trim());
  }
  return result;
}

async function dockerCli(command: string, args: string[]) {
  const result = await dockerCliWithResult(command, args);
  return result.stdout ?? '';
}

function extractPort(portSpec: string | undefined): number | undefined {
  if (!portSpec) {
    return undefined;
  }
  const match = Array.from(portSpec.matchAll(/:(\d+)->8080\/tcp/g)).pop();
  return match ? Number(match[1]) : undefined;
}

async function fetchImageSizes(images: string[]): Promise<Record<string, number>> {
  if (!images.length) {
    return {};
  }
  try {
    const stdout = await dockerCli('image', ['inspect', ...images]);
    const payload = JSON.parse(stdout);
    if (!Array.isArray(payload)) {
      return {};
    }
    const sizes: Record<string, number> = {};
    payload.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const size = typeof (entry as any).Size === 'number' ? (entry as any).Size : undefined;
      if (typeof size !== 'number') {
        return;
      }
      if (typeof (entry as any).Id === 'string') {
        sizes[(entry as any).Id] = size;
      }
      const tags = Array.isArray((entry as any).RepoTags) ? (entry as any).RepoTags : [];
      tags.forEach((tag: string) => {
        if (typeof tag === 'string') {
          sizes[tag] = size;
        }
      });
      const digests = Array.isArray((entry as any).RepoDigests) ? (entry as any).RepoDigests : [];
      digests.forEach((digest: string) => {
        if (typeof digest === 'string') {
          sizes[digest] = size;
        }
      });
    });
    return sizes;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.debug('[LlamaEdge] Failed to inspect image sizes', message);
    return {};
  }
}

async function startLlamaEdgeContainerFromRow(row: RowItem): Promise<{ id: string; port?: number }> {
  if (!row.id || isLlamaEdgePresetRow(row)) {
    return runLlamaEdgeContainer(row.name);
  }
  await dockerCli('start', [row.id]);
  const port = row.port ?? (typeof row.extra?.Ports === 'string' ? extractPort(row.extra.Ports) : undefined);
  const token = getOpenWebUIToken();
  if (token && port) {
    await ensureLlamaEdgeConnection(port);
  }
  return { id: row.id, port };
}

async function stopLlamaEdgeContainer(id: string): Promise<void> {
  await dockerCli('stop', [id]);
}

async function listLlamaEdgeContainers(): Promise<RowItem[]> {
  const stdout = await dockerCli('ps', ['-a', '--format', '{{json .}}', '--filter', 'label=sc.engine=llamaedge']);
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (!lines.length) {
    return DEFAULT_LLAMAEDGE_IMAGES.map((image) => ({
      id: `preset:${image}`,
      name: image,
      status: 'not running',
      engine: 'llamaedge',
      extra: { Image: image },
    }));
  }
  const rows = lines
    .map((line) => {
      const parsed = JSON.parse(line);
      const port = extractPort(parsed?.Ports);
      let status: Status = 'running';
      if (typeof parsed?.State === 'string') {
        if (parsed.State === 'exited') {
          status = 'stopped';
        } else if (parsed.State !== 'running') {
          status = 'not running';
        }
      }
      return {
        id: String(parsed?.ID ?? ''),
        name: String(parsed?.Image ?? parsed?.Names ?? ''),
        status,
        port,
        createdAt: typeof parsed?.RunningFor === 'string' ? parsed.RunningFor : parsed?.CreatedAt,
        engine: 'llamaedge',
        extra: parsed,
      } as RowItem;
    })
    .filter((item) => item.id);
  const byImage = new Set(rows.map((row) => row.name));
  const defaultRows: RowItem[] = DEFAULT_LLAMAEDGE_IMAGES.filter((image) => !byImage.has(image)).map((image) => ({
    id: `preset:${image}`,
    name: image,
    status: 'not running',
    engine: 'llamaedge',
    extra: { Image: image },
  }));
  const imageRefs = Array.from(
    new Set(
      rows
        .map((item) => (typeof item.extra?.Image === 'string' ? (item.extra.Image as string) : undefined))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  let imageSizes: Record<string, number> = {};
  if (imageRefs.length) {
    imageSizes = await fetchImageSizes(imageRefs);
  }
  const addSizes = (items: RowItem[]) =>
    items.map((row) => {
      if (typeof row.extra?.Image === 'string') {
        const size = imageSizes[row.extra.Image];
        if (typeof size === 'number') {
          return { ...row, sizeBytes: size };
        }
      }
      return row;
    });
  return [...addSizes(rows), ...addSizes(defaultRows)];
}

async function allocateLlamaEdgePort(): Promise<number> {
  const stdout = await dockerCli('ps', ['-a', '--format', '{{.Ports}}', '--filter', 'label=sc.engine=llamaedge']);
  const used = new Set<number>();
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      for (const match of line.matchAll(/:(\d+)->8080\/tcp/g)) {
        used.add(Number(match[1]));
      }
    });
  for (let port = 11900; port <= 65535; port += 1) {
    if (!used.has(port)) {
      return port;
    }
  }
  throw new Error('Unable to allocate a LlamaEdge port above 11900');
}

async function runLlamaEdgeContainer(image: string) {
  const token = getOpenWebUIToken();
  const port = await allocateLlamaEdgePort();
  const stdout = await dockerCli('run', [
    '-d',
    '--label',
    'sc.engine=llamaedge',
    '-p',
    `${port}:8080`,
    image,
  ]);
  const id = stdout.trim().split('\n').filter(Boolean)[0];
  if (!id) {
    throw new Error('Failed to start container');
  }
  if(token) {
    try {
      await ensureLlamaEdgeConnection(port);
    } catch (error) {
      try {
        await deleteLlamaEdgeContainer(id);
      } catch (cleanupError) {
        console.debug('Failed to clean up container after config error', cleanupError);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message);
    }
  }
  return { id, port };
}

async function deleteLlamaEdgeContainer(id: string) {
  try {
    await dockerCli('stop', [id]);
  } catch (error) {
    console.debug('stop failed', error);
  }
  await dockerCli('rm', [id]);
}

function createEmptySelection(): Record<EngineId, Set<string>> {
  return {
    ollama: new Set<string>(),
    llamaedge: new Set<string>(),
  };
}

export default function ModelsModule() {
  const [activeEngine, setActiveEngine] = useState<EngineId>('ollama');
  const [modalState, setModalState] = useState<ModalState | null>(null);
  const [engineState, setEngineState] = useState<Record<EngineId, EngineState>>({
    ollama: { items: [], loading: false, error: '' },
    llamaedge: { items: [], loading: false, error: '' },
  });
  const [selectedRows, setSelectedRows] = useState<Record<EngineId, Set<string>>>(() => createEmptySelection());
  const [deletingRows, setDeletingRows] = useState<Record<EngineId, Set<string>>>(() => createEmptySelection());
  const [filterText, setFilterText] = useState<Record<EngineId, string>>({ ollama: '', llamaedge: '' });
  const [rowMenuId, setRowMenuId] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [highlightedRow, setHighlightedRow] = useState<{ engine: EngineId; id: string } | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const headerCheckboxRef = useRef<HTMLInputElement | null>(null);

  const setHighlight = useCallback((engine: EngineId, id: string) => {
    if (highlightTimer.current) {
      window.clearTimeout(highlightTimer.current);
    }
    setHighlightedRow({ engine, id });
    highlightTimer.current = window.setTimeout(() => {
      setHighlightedRow((current) => (current && current.engine === engine && current.id === id ? null : current));
    }, 3000);
  }, []);

  const refreshEngine = useCallback(
    async (engine: EngineId, options?: { highlightId?: string }) => {
      setEngineState((prev) => ({
        ...prev,
        [engine]: { ...prev[engine], loading: true, error: '' },
      }));
      try {
        const items = engine === 'ollama' ? await listOllamaModels() : await listLlamaEdgeContainers();
        setEngineState((prev) => ({
          ...prev,
          [engine]: { items, loading: false, error: '' },
        }));
        setSelectedRows((prev) => {
          const next = { ...prev } as Record<EngineId, Set<string>>;
          const nextSet = new Set(prev[engine]);
          const validIds = new Set(items.map((item) => item.id));
          for (const id of nextSet) {
            if (!validIds.has(id)) {
              nextSet.delete(id);
            }
          }
          next[engine] = nextSet;
          return next;
        });
        if (options?.highlightId) {
          setHighlight(engine, options.highlightId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setEngineState((prev) => ({
          ...prev,
          [engine]: { ...prev[engine], loading: false, error: message },
        }));
        toast.error(message);
      }
    },
    [setHighlight],
  );

  useEffect(() => {
    refreshEngine('ollama');
    refreshEngine('llamaedge');
    return () => {
      if (highlightTimer.current) {
        window.clearTimeout(highlightTimer.current);
      }
    };
  }, [refreshEngine]);

  useEffect(() => {
    if (!rowMenuId) {
      return;
    }
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-engine-row-menu="true"]')) {
        return;
      }
      setRowMenuId(null);
    };
    window.addEventListener('pointerdown', closeOnPointer);
    return () => window.removeEventListener('pointerdown', closeOnPointer);
  }, [rowMenuId]);

  useEffect(() => {
    setRowMenuId(null);
  }, [activeEngine]);

  const activeState = engineState[activeEngine];
  const activeItems = activeState.items;
  const activeConfig = ENGINE_CONFIG[activeEngine];
  const activeFilter = filterText[activeEngine];

  const filteredRows = useMemo(() => {
    const query = activeFilter.trim().toLowerCase();
    if (!query) {
      return activeItems;
    }
    return activeItems.filter((row) => {
      const haystack = [row.name, row.id, row.port ? String(row.port) : '', row.extra ? JSON.stringify(row.extra) : '']
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [activeFilter, activeItems]);

  const selectedSet = selectedRows[activeEngine];
  const deletingSet = deletingRows[activeEngine];
  const selectedCount = selectedSet.size;
  const filteredSelectedCount = filteredRows.filter((row) => selectedSet.has(row.id)).length;
  const allFilteredSelected = filteredRows.length > 0 && filteredSelectedCount === filteredRows.length;
  const someFilteredSelected = filteredSelectedCount > 0 && !allFilteredSelected;
  const hasDefaultLlamaEdgeSelection = activeItems.some(
    (row) => selectedSet.has(row.id) && isDefaultLlamaEdgeRow(row),
  );

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someFilteredSelected;
    }
  }, [someFilteredSelected, filteredRows.length, activeEngine]);

  const itemSummary = filteredRows.length === activeItems.length
    ? `${filteredRows.length} ${filteredRows.length === 1 ? 'item' : 'items'}`
    : `Showing ${filteredRows.length} of ${activeItems.length}`;

  const openModal = useCallback((engine: EngineId) => {
    setModalState({ engine, value: '', error: '', busy: false, progress: undefined });
  }, []);

  const closeModal = useCallback(() => {
    setModalState(null);
  }, []);

  const setFilterForEngine = useCallback((engine: EngineId, value: string) => {
    setFilterText((prev) => ({ ...prev, [engine]: value }));
  }, []);

  const setSelectionForEngine = useCallback((engine: EngineId, updater: (set: Set<string>) => void) => {
    setSelectedRows((prev) => {
      const next = { ...prev } as Record<EngineId, Set<string>>;
      const nextSet = new Set(prev[engine]);
      updater(nextSet);
      next[engine] = nextSet;
      return next;
    });
  }, []);

  const setDeletingForEngine = useCallback((engine: EngineId, updater: (set: Set<string>) => void) => {
    setDeletingRows((prev) => {
      const next = { ...prev } as Record<EngineId, Set<string>>;
      const nextSet = new Set(prev[engine]);
      updater(nextSet);
      next[engine] = nextSet;
      return next;
    });
  }, []);

  const handleModalSubmit = useCallback(async () => {
    if (!modalState) {
      return;
    }
    const { engine } = modalState;
    const value = modalState.value.trim();
    if (!value) {
      setModalState((prev) => (prev ? { ...prev, error: 'Value is required.' } : prev));
      return;
    }
    setModalState((prev) =>
      prev
        ? {
            ...prev,
            busy: true,
            error: '',
            progress: engine === 'ollama' ? 'Preparing download…' : 'Starting container…',
          }
        : prev,
    );
    try {
      if (engine === 'ollama') {
        await downloadOllamaModel(value, (status) =>
          setModalState((prev) => (prev ? { ...prev, progress: status } : prev)),
        );
        toast.success(`Downloaded ${value}`);
        closeModal();
        await refreshEngine(engine, { highlightId: value });
      } else {
        const { id } = await runLlamaEdgeContainer(value);
        toast.success(`Started container from ${value}`);
        closeModal();
        await refreshEngine(engine, { highlightId: id });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModalState((prev) => (prev ? { ...prev, busy: false, error: message, progress: undefined } : prev));
    }
  }, [modalState, closeModal, refreshEngine]);

  const runLlamaEdgeRow = useCallback(
    async (row: RowItem) => {
      if (row.engine !== 'llamaedge') {
        return;
      }
      setRowMenuId(null);
      try {
        setEngineState((prev) => ({
          ...prev,
          llamaedge: {
            ...prev.llamaedge,
            items: prev.llamaedge.items.map((item) =>
              item.id === row.id ? { ...item, status: 'starting' } : item,
            ),
          },
        }));
        const { id } = await startLlamaEdgeContainerFromRow(row);
        toast.success(`Started container from ${row.name}`);
        await refreshEngine('llamaedge', { highlightId: id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(message);
        await refreshEngine('llamaedge');
      }
    },
    [refreshEngine],
  );

  const stopLlamaEdgeRow = useCallback(
    async (row: RowItem) => {
      if (row.engine !== 'llamaedge' || !row.id || isLlamaEdgePresetRow(row)) {
        return;
      }
      setRowMenuId(null);
      try {
        setEngineState((prev) => ({
          ...prev,
          llamaedge: {
            ...prev.llamaedge,
            items: prev.llamaedge.items.map((item) =>
              item.id === row.id ? { ...item, status: 'stopping' } : item,
            ),
          },
        }));
        await stopLlamaEdgeContainer(row.id);
        toast.success(`Stopped ${row.name}`);
        await refreshEngine('llamaedge', { highlightId: row.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(message);
        await refreshEngine('llamaedge');
      }
    },
    [refreshEngine],
  );

  const deleteRow = useCallback(
    async (item: RowItem, options?: { skipConfirm?: boolean; skipRefresh?: boolean }) => {
      const { skipConfirm = false, skipRefresh = false } = options ?? {};
      setRowMenuId(null);
      if (item.engine === 'llamaedge' && isDefaultLlamaEdgeRow(item)) {
        toast.info('Default LlamaEdge models cannot be deleted.');
        return false;
      }
      if (!skipConfirm) {
        if (!window.confirm(`Delete ${item.name}?`)) {
          return false;
        }
      }
      setDeletingForEngine(item.engine, (set) => set.add(item.id));
      setEngineState((prev) => ({
        ...prev,
        [item.engine]: {
          ...prev[item.engine],
          items: prev[item.engine].items.map((row) =>
            row.id === item.id ? { ...row, status: 'deleting' } : row,
          ),
        },
      }));
      let success = false;
      try {
        if (item.engine === 'ollama') {
          await deleteOllamaModel(item.id);
        } else {
          if (!isLlamaEdgePresetRow(item)) {
            await deleteLlamaEdgeContainer(item.id);
            const port = item.port ?? (typeof item.extra?.Ports === 'string' ? extractPort(item.extra.Ports) : undefined);
            const token = getOpenWebUIToken();
            token ? await removeLlamaEdgeConnection(port) : null;
          }
        }
        toast.success(`Deleted ${item.name}`);
        success = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(message);
        setEngineState((prev) => ({
          ...prev,
          [item.engine]: {
            ...prev[item.engine],
            items: prev[item.engine].items.map((row) =>
              row.id === item.id ? { ...row, status: 'error' } : row,
            ),
          },
        }));
      } finally {
        setDeletingForEngine(item.engine, (set) => {
          set.delete(item.id);
        });
      }
      if (success) {
        setSelectionForEngine(item.engine, (set) => {
          set.delete(item.id);
        });
        if (skipRefresh) {
          setEngineState((prev) => ({
            ...prev,
            [item.engine]: {
              ...prev[item.engine],
              items: prev[item.engine].items.filter((row) => row.id !== item.id),
            },
          }));
        } else {
          await refreshEngine(item.engine);
        }
      }
      return success;
    },
    [refreshEngine, setDeletingForEngine, setSelectionForEngine],
  );

  const handleBulkDelete = useCallback(async () => {
    const selected = selectedRows[activeEngine];
    if (selected.size === 0) {
      return;
    }
    const rowsToDelete = activeItems.filter((row) => selected.has(row.id) && !isDefaultLlamaEdgeRow(row));
    if (!rowsToDelete.length) {
      return;
    }
    const confirmLabel = rowsToDelete.length === 1 ? rowsToDelete[0].name : `${rowsToDelete.length} items`;
    if (!window.confirm(`Delete ${confirmLabel}?`)) {
      return;
    }
    setBulkDeleting(true);
    for (const row of rowsToDelete) {
      // eslint-disable-next-line no-await-in-loop
      await deleteRow(row, { skipConfirm: true, skipRefresh: true });
    }
    setBulkDeleting(false);
    await refreshEngine(activeEngine);
  }, [activeEngine, activeItems, deleteRow, refreshEngine, selectedRows]);

  const modalForm = useMemo(() => {
    if (!modalState) {
      return null;
    }
    const config = ENGINE_CONFIG[modalState.engine];
    const submitLabel = modalState.busy ? 'Working…' : config.submitLabel;

    return (
      <div className="engine-modal" role="dialog" aria-modal="true">
        <div className="engine-modal__card">
          <div className="engine-modal__header">
            <h2>{config.modalTitle}</h2>
            <p>{config.modalDescription}</p>
          </div>
          <label>
            <div>{config.inputLabel}</div>
            <input
              className="engine-input"
              value={modalState.value}
              onChange={(event) =>
                setModalState((prev) => (prev ? { ...prev, value: event.target.value } : prev))
              }
              placeholder={config.placeholder}
              disabled={modalState.busy}
              autoFocus
            />
          </label>
          <div className="engine-modal__helper">{config.helperText}</div>
          {modalState.busy && (
            <div className="engine-modal__progress" role="status" aria-live="polite">
              <span className="engine-progress-indicator" aria-hidden="true" />
              <span>{modalState.progress ?? 'Downloading…'}</span>
            </div>
          )}
          {modalState.error && <div className="engine-modal__error">{modalState.error}</div>}
          <div className="engine-modal__footer">
            <button className="engine-button engine-button--ghost" onClick={closeModal} disabled={modalState.busy}>
              Cancel
            </button>
            <button
              className="engine-button engine-button--primary"
              onClick={handleModalSubmit}
              disabled={modalState.busy}
            >
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }, [closeModal, handleModalSubmit, modalState]);

  const disableDelete = selectedCount === 0 || activeState.loading || bulkDeleting || hasDefaultLlamaEdgeSelection;
  const disableRefresh = activeState.loading || bulkDeleting;
  const disableDownload = modalState?.busy === true || bulkDeleting;

  const emptyMessage = activeItems.length === 0
    ? activeConfig.emptyMessage
    : 'No items match the current filter.';

  return (
    <div className="rdx-module">
      <header className="rdx-module__header rdx-module__header--stacked">
        <h1>Models</h1>
      </header>
      <div className="engine-tabs-row">
        <div className="engine-tabs" role="tablist" aria-label="Inference engine selector">
          {(Object.keys(ENGINE_CONFIG) as EngineId[]).map((engine) => (
            <button
              key={engine}
              role="tab"
              type="button"
              className={`engine-tab${engine === activeEngine ? ' is-active' : ''}`}
              aria-selected={engine === activeEngine}
              onClick={() => setActiveEngine(engine)}
            >
              {ENGINE_CONFIG[engine].label}
            </button>
          ))}
        </div>
      </div>
      <section className="rdx-module__section rdx-module__section--fill">
        <div className="rdx-module__panel engine-panel">
          <div className="engine-content-header" aria-hidden="true" />

          <div className="engine-toolbar">
            <div className="engine-toolbar__left">
              <button
                className="engine-button engine-button--ghost"
                onClick={handleBulkDelete}
                disabled={disableDelete}
              >
                Delete
              </button>
              <button
                className="engine-button engine-button--ghost"
                onClick={() => refreshEngine(activeEngine)}
                disabled={disableRefresh}
              >
                Refresh
              </button>
            </div>
            <div className="engine-toolbar__right">
              <input
                className="engine-filter-input"
                type="search"
                value={activeFilter}
                onChange={(event) => setFilterForEngine(activeEngine, event.target.value)}
                placeholder="Filter"
                aria-label="Filter items"
              />
              <button
                className="engine-button engine-button--primary"
                onClick={() => openModal(activeEngine)}
                disabled={disableDownload}
              >
                Download/Run
              </button>
            </div>
          </div>

          <div className="engine-table-wrapper">
            {activeState.loading && <div className="engine-loading">Loading…</div>}
            {activeState.error && !activeState.loading && (
              <div className="engine-error">
                <div className="engine-error__message">{activeState.error}</div>
                <button className="engine-button engine-button--ghost" onClick={() => refreshEngine(activeEngine)}>
                  Try again
                </button>
              </div>
            )}
            {!activeState.loading && !activeState.error && filteredRows.length === 0 && (
              <div className="engine-empty">{emptyMessage}</div>
            )}
            {filteredRows.length > 0 && (
              <div className="engine-table-scroll">
                <table className="engine-table">
                  <colgroup>
                    <col className="engine-col-select" />
                    <col />
                    <col className="engine-col-status" />
                    <col className="engine-col-size" />
                    <col className="engine-col-actions" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">
                        <input
                          ref={headerCheckboxRef}
                          type="checkbox"
                          className="engine-checkbox"
                          checked={allFilteredSelected}
                          onChange={() =>
                            setSelectionForEngine(activeEngine, (set) => {
                              if (allFilteredSelected) {
                                filteredRows.forEach((row) => set.delete(row.id));
                              } else {
                                filteredRows.forEach((row) => set.add(row.id));
                              }
                            })
                          }
                          disabled={filteredRows.length === 0}
                          aria-label="Select all"
                        />
                      </th>
                      <th scope="col">Name</th>
                      <th scope="col">Status</th>
                      <th scope="col">Size</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row) => {
                      const isHighlighted =
                        highlightedRow && highlightedRow.engine === row.engine && highlightedRow.id === row.id;
                      const isDeleting = deletingSet.has(row.id) || bulkDeleting;
                      const isStopping = row.status === 'stopping';
                      const isStarting = row.status === 'starting';
                      const isDefaultRow = isDefaultLlamaEdgeRow(row);
                      const disableRowActions = isDeleting || isStarting;
                      const isSelected = selectedSet.has(row.id);
                      const rowActions = row.engine === 'llamaedge'
                        ? [
                            (row.status === 'running' || isStopping)
                              ? { label: 'Stop', handler: () => void stopLlamaEdgeRow(row) }
                              : { label: 'Run', handler: () => void runLlamaEdgeRow(row) },
                            ...(isDefaultRow ? [] : [{ label: 'Delete', handler: () => void deleteRow(row) }]),
                          ]
                        : [{ label: 'Delete', handler: () => void deleteRow(row) }];
                      return (
                        <tr key={row.id} className={isHighlighted ? 'is-highlight' : undefined}>
                          <td>
                            <input
                              type="checkbox"
                              className="engine-checkbox"
                              checked={isSelected}
                              onChange={() =>
                                setSelectionForEngine(activeEngine, (set) => {
                                  if (set.has(row.id)) {
                                    set.delete(row.id);
                                  } else {
                                    set.add(row.id);
                                  }
                                })
                              }
                              aria-label={`Select ${row.name}`}
                            />
                          </td>
                          <td>
                            <div className="engine-name">
                              <span>{row.name}</span>
                            </div>
                          </td>
                          <td>
                            <span className={`engine-status ${statusClass(row.status)}`}>
                              {formatStatus(row.status)}
                            </span>
                          </td>
                          <td className="engine-col-size">{formatBytes(row.sizeBytes)}</td>
                          <td className="engine-col-actions">
                            <div className="engine-row-menu" data-engine-row-menu="true">
                              <button
                                type="button"
                                className="engine-row-menu__button"
                                aria-haspopup="menu"
                                aria-label={`Actions for ${row.name}`}
                                aria-expanded={rowMenuId === row.id}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setRowMenuId((prev) => (prev === row.id ? null : row.id));
                                }}
                                disabled={disableRowActions}
                              >
                                ⋮
                              </button>
                              {rowMenuId === row.id && (
                                <div className="engine-row-menu__list" role="menu">
                                  {rowActions.map((action) => (
                                    <button
                                      key={action.label}
                                      type="button"
                                      className="engine-row-menu__item"
                                      onClick={action.handler}
                                      role="menuitem"
                                      disabled={disableRowActions}
                                    >
                                      {action.label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>
      {modalForm}
    </div>
  );
}
