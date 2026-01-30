import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import { toast } from 'react-toastify';
import {
  getOpenWebUIToken,
  reportOpenWebUIDebug
} from './openWebuiHelpers';
import {
  cloneConfigEntry,
  isRecord,
  OpenWebUIConfig,
  OpenWebUIConfigEntry,
  toStringArray,
} from './openAiConfig';
import './ModuleContent.css';
import './ModelsModule.css';
import {
  ArgEnvInputs,
  ArgRow,
  EnvRow,
  argsFromRows,
  envFromRows,
} from './ArgEnvInputs';

const ddClient = createDockerDesktopClient();

type EngineId = 'ollama' | 'llamaedge' | 'gguf';
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
  ggufMode?: 'download' | 'upload';
  ggufFilePath?: string;
  ggufFileName?: string;
}

interface RunModalState {
  engine: Extract<EngineId, 'llamaedge' | 'gguf'>;
  row: RowItem;
  args: ArgRow[];
  envs: EnvRow[];
  busy: boolean;
  error: string;
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
  actionLabel: string;
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
    actionLabel: 'Download/Run',
  },
  gguf: {
    label: 'LLAMA.CPP',
    modalTitle: 'Add GGUF Model',
    modalDescription: 'Download a GGUF file from a URL or upload one from your local disk.',
    inputLabel: 'Source',
    placeholder: 'https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main/Qwen3VL-2B-Instruct-Q4_K_M.gguf',
    helperText: 'Make sure the file name ends with .gguf.',
    submitLabel: 'Download',
    emptyMessage: 'No GGUF files found. Click Download/Upload to add one.',
    actionLabel: 'Download/Upload',
  },
  llamaedge: {
    label: 'LlamaEdge',
    modalTitle: 'Run LlamaEdge Container',
    modalDescription: 'Enter a LlamaEdge container image name.',
    inputLabel: 'Container image',
    placeholder: 'myrepo/llamaedge-phi4:latest',
    helperText: 'Refer to https://llamaedge.com/docs/ai-models/llamaedge-docker to learn how to build your own LlamaEdge contianer image.',
    submitLabel: 'Run',
    emptyMessage: 'No LlamaEdge containers found. Click Download/Run to start one.',
    actionLabel: 'Download/Run',
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

const LLAMAEDGE_CONNECTION_BASE = 'http://host.docker.internal';
export { OPEN_WEBUI_TOKEN_STORAGE_KEY } from './openWebuiHelpers';
const DEFAULT_LLAMAEDGE_IMAGES = [
  'ghcr.io/rancher-sandbox/qwen2-0.5b-instruct:0.1.0'
];
const DEFAULT_LLAMAEDGE_IMAGE_SET = new Set(DEFAULT_LLAMAEDGE_IMAGES);

const GGUF_VOLUME_NAME = 'rdx-gguf-models';
const GGUF_FILE_EXTENSION = '.gguf';
const GGUF_CONTAINER_IMAGE = 'ghcr.io/ggml-org/llama.cpp:server';
const GGUF_FILE_LABEL_KEY = 'sc.gguf.file';
const GGUF_MAX_CTX_TOKENS = 16384;
const GGUF_SERVER_ARGS = ['--ctx-size', String(GGUF_MAX_CTX_TOKENS)]; // llama.cpp clamps ctx to model max automatically

interface ContainerRunConfig {
  args?: string[];
  env?: Record<string, string>;
}

function buildEnvCliArgs(env?: Record<string, string>): string[] {
  if (!env) {
    return [];
  }
  return Object.entries(env)
    .map(([key, value]) => ({ key: key.trim(), value }))
    .filter((entry) => entry.key)
    .flatMap((entry) => ['-e', `${entry.key}=${entry.value}`]);
}

import {
  fetchOpenWebuiConfigApi,
  updateOpenWebuiConfigApi,
} from './openWebuiApi';

async function fetchOpenWebUIConfig(): Promise<OpenWebUIConfig> {
  try {
    return await fetchOpenWebuiConfigApi();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportOpenWebUIDebug(`Open WebUI config fetch failed: ${message}`);
    throw (error instanceof Error ? error : new Error(message));
  }
}

async function saveOpenWebUIConfig(config: OpenWebUIConfig): Promise<void> {
  try {
    await updateOpenWebuiConfigApi(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportOpenWebUIDebug(`Open WebUI config update failed: ${message}`);
    throw (error instanceof Error ? error : new Error(message));
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
  const resolvedPort = await resolveEnginePort(row.id);
  const port = resolvedPort ?? row.port ?? (typeof row.extra?.Ports === 'string' ? extractPort(row.extra.Ports) : undefined);
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

async function listUsedModelPorts(): Promise<Set<number>> {
  const stdout = await dockerCli('ps', ['-a', '--format', '{{.Ports}}', '--filter', 'label=sc.engine']);
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
  return used;
}

async function allocateModelPort(): Promise<number> {
  const used = await listUsedModelPorts();
  for (let port = 11900; port <= 65535; port += 1) {
    if (!used.has(port)) {
      return port;
    }
  }
  throw new Error('Unable to allocate a port above 11900');
}

async function resolveEnginePort(id: string): Promise<number | undefined> {
  try {
    const stdout = await dockerCli('port', [id, '8080/tcp']);
    const match = stdout.match(/:(\d+)/);
    return match ? Number(match[1]) : undefined;
  } catch (error) {
    console.debug('[Models] Failed to resolve container port', error);
    return undefined;
  }
}

async function runLlamaEdgeContainer(image: string, config?: ContainerRunConfig) {
  const token = getOpenWebUIToken();
  const port = await allocateModelPort();
  const envArgs = buildEnvCliArgs(config?.env);
  const extraArgs = config?.args?.filter(Boolean) ?? [];
  const stdout = await dockerCli('run', [
    '-d',
    '--label',
    'sc.engine=llamaedge',
    '-p',
    `${port}:8080`,
    ...envArgs,
    image,
    ...extraArgs,
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

function sanitizeGgufFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Provide a GGUF file name.');
  }
  const cleaned = trimmed.replace(/[^0-9A-Za-z._-]/g, '-');
  const collapsed = cleaned.replace(/^-+/, '').replace(/-+$/, '') || 'model';
  const lower = collapsed.toLowerCase();
  return lower.endsWith(GGUF_FILE_EXTENSION) ? collapsed : `${collapsed}${GGUF_FILE_EXTENSION}`;
}

function basenameFromPath(path: string): string {
  if (!path) {
    return '';
  }
  const normalized = path.replace(/[\\/]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

function inferFilenameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const candidate = parsed.searchParams.get('filename') || parsed.searchParams.get('file');
    if (candidate) {
      return candidate;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length) {
      return segments[segments.length - 1];
    }
  } catch {
    // Fall back to simple parsing below.
  }
  const stripped = rawUrl.split('?')[0]?.split('#')[0] ?? rawUrl;
  const parts = stripped.split('/').filter(Boolean);
  if (parts.length) {
    return parts[parts.length - 1];
  }
  return 'model.gguf';
}

function parseDockerLabelsString(value: unknown): Record<string, string> {
  if (typeof value !== 'string') {
    return {};
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((acc, entry) => {
      const [key, ...rest] = entry.split('=');
      if (!key) {
        return acc;
      }
      acc[key] = rest.join('=');
      return acc;
    }, {} as Record<string, string>);
}

async function ensureGgufVolume(): Promise<void> {
  try {
    await dockerCli('volume', ['inspect', GGUF_VOLUME_NAME]);
  } catch {
    await dockerCli('volume', ['create', GGUF_VOLUME_NAME]);
  }
}

interface GgufContainerInfo {
  id: string;
  status: Status;
  port?: number;
  labels: Record<string, string>;
  extra?: Record<string, unknown>;
}

async function listGgufContainers(): Promise<GgufContainerInfo[]> {
  const stdout = await dockerCli('ps', ['-a', '--format', '{{json .}}', '--filter', 'label=sc.engine=gguf']);
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (!lines.length) {
    return [];
  }
  return lines
    .map((line) => {
      const parsed = JSON.parse(line);
      const labels = parseDockerLabelsString(parsed?.Labels);
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
        status,
        port,
        labels,
        extra: parsed ?? undefined,
      } as GgufContainerInfo;
    })
    .filter((item) => item.id);
}

async function listGgufFiles(): Promise<RowItem[]> {
  await ensureGgufVolume();
  const containers = await listGgufContainers();
  const containerByFile = new Map<string, GgufContainerInfo>();
  containers.forEach((container) => {
    const file = container.labels[GGUF_FILE_LABEL_KEY];
    if (file) {
      containerByFile.set(file, container);
    }
  });
  const listScript = `
set -e
cd /models
for entry in *.gguf; do
  [ -e "\$entry" ] || continue
  size=$(stat -c %s "\$entry" 2>/dev/null || echo 0)
  mtime=$(stat -c %Y "\$entry" 2>/dev/null || echo 0)
  printf "%s|%s|%s\\n" "\$entry" "\$size" "\$mtime"
done
`;
  const stdout = await dockerCli('run', [
    '--rm',
    '-v',
    `${GGUF_VOLUME_NAME}:/models`,
    ddClient.extension.image,
    'sh',
    '-c',
    listScript,
  ]);
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (!lines.length) {
    return [];
  }
  return lines.map((line) => {
    const [name, sizeRaw, mtimeRaw] = line.split('|');
    const container = name ? containerByFile.get(name) : undefined;
    const size = Number(sizeRaw);
    const mtimeSeconds = Number(mtimeRaw);
    return {
      id: name,
      name,
      engine: 'gguf',
      status: container ? container.status : 'ready',
      sizeBytes: Number.isFinite(size) ? size : undefined,
      createdAt: Number.isFinite(mtimeSeconds) && mtimeSeconds > 0 ? new Date(mtimeSeconds * 1000).toISOString() : undefined,
      port: container?.port,
      extra: {
        fileName: name,
        volume: GGUF_VOLUME_NAME,
        containerId: container?.id,
        container: container?.extra,
      },
    } as RowItem;
  });
}

async function downloadGgufFile(sourceUrl: string): Promise<string> {
  if (!sourceUrl) {
    throw new Error('Provide a download URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error('Provide a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  }
  const inferred = inferFilenameFromUrl(sourceUrl);
  if (!inferred.toLowerCase().endsWith(GGUF_FILE_EXTENSION)) {
    throw new Error('Only GGUF files are supported. Ensure the URL points to a .gguf file.');
  }
  const targetName = sanitizeGgufFilename(inferred);
  await ensureGgufVolume();
  const script = `
set -e
cd /models
if [ -e "${targetName}" ]; then
  echo "${targetName} already exists." >&2
  exit 1
fi
tmp="${targetName}.download.$$"
rm -f "\$tmp"
if ! wget -O "\$tmp" "\$GGUF_URL"; then
  rm -f "\$tmp"
  exit 1
fi
mv "\$tmp" "${targetName}"
`;
  await dockerCli('run', [
    '--rm',
    '-v',
    `${GGUF_VOLUME_NAME}:/models`,
    '-e',
    `GGUF_URL=${sourceUrl}`,
    ddClient.extension.image,
    'sh',
    '-c',
    script,
  ]);
  return targetName;
}

async function uploadGgufFile(hostPath: string): Promise<string> {
  if (!hostPath) {
    throw new Error('Select a GGUF file to upload.');
  }
  const displayName = basenameFromPath(hostPath);
  if (!displayName.toLowerCase().endsWith(GGUF_FILE_EXTENSION)) {
    throw new Error('Only .gguf files can be uploaded.');
  }
  const targetName = sanitizeGgufFilename(displayName);
  await ensureGgufVolume();
  const script = `
set -e
cd /models
if [ -e "${targetName}" ]; then
  echo "${targetName} already exists." >&2
  exit 1
fi
tmp="${targetName}.upload.$$"
rm -f "\$tmp"
cp /upload-source "\$tmp"
mv "\$tmp" "${targetName}"
`;
  await dockerCli('run', [
    '--rm',
    '-v',
    `${GGUF_VOLUME_NAME}:/models`,
    '-v',
    `${hostPath}:/upload-source:ro`,
    ddClient.extension.image,
    'sh',
    '-c',
    script,
  ]);
  return targetName;
}

async function removeGgufContainer(id: string | undefined): Promise<void> {
  if (!id) {
    return;
  }
  try {
    await dockerCli('rm', ['-f', id]);
  } catch (error) {
    console.debug('[GGUF] Failed to remove container', error);
  }
}

async function deleteGgufFile(fileName: string): Promise<void> {
  await ensureGgufVolume();
  const script = `
set -e
cd /models
rm -f "${fileName}"
`;
  await dockerCli('run', [
    '--rm',
    '-v',
    `${GGUF_VOLUME_NAME}:/models`,
    ddClient.extension.image,
    'sh',
    '-c',
    script,
  ]);
}

async function runGgufContainer(fileName: string, config?: ContainerRunConfig): Promise<{ id: string; port?: number }> {
  await ensureGgufVolume();
  const port = await allocateModelPort();
  const envArgs = buildEnvCliArgs(config?.env);
  const userArgs = config?.args?.filter(Boolean) ?? [];
  const hasUserCtxOverride = userArgs.some((arg) => arg === '--ctx-size' || arg.startsWith('--ctx-size='));
  const serverArgs = hasUserCtxOverride ? userArgs : [...GGUF_SERVER_ARGS, ...userArgs];
  const stdout = await dockerCli('run', [
    '-d',
    '--label',
    'sc.engine=gguf',
    '--label',
    `${GGUF_FILE_LABEL_KEY}=${fileName}`,
    '-v',
    `${GGUF_VOLUME_NAME}:/models`,
    '-p',
    `${port}:8080`,
    ...envArgs,
    GGUF_CONTAINER_IMAGE,
    '-m',
    `/models/${fileName}`,
    ...serverArgs,
  ]);
  const id = stdout.trim().split('\n').filter(Boolean)[0];
  if (!id) {
    throw new Error('Failed to start llama.cpp server');
  }
  const token = getOpenWebUIToken();
  if (token) {
    try {
      await ensureLlamaEdgeConnection(port);
    } catch (error) {
      await removeGgufContainer(id);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message);
    }
  }
  return { id, port };
}

async function startGgufContainerFromRow(row: RowItem): Promise<{ id: string; port?: number }> {
  const containerId = typeof row.extra?.containerId === 'string' ? row.extra.containerId : undefined;
  if (!containerId) {
    return runGgufContainer(row.name);
  }
  await dockerCli('start', [containerId]);
  const resolvedPort = await resolveEnginePort(containerId);
  const port = resolvedPort ?? row.port;
  const token = getOpenWebUIToken();
  if (token && port) {
    await ensureLlamaEdgeConnection(port);
  }
  return { id: containerId, port };
}

async function stopGgufContainer(containerId: string | undefined): Promise<void> {
  if (!containerId) {
    return;
  }
  await dockerCli('stop', [containerId]);
}

function createEmptySelection(): Record<EngineId, Set<string>> {
  return {
    ollama: new Set<string>(),
    llamaedge: new Set<string>(),
    gguf: new Set<string>(),
  };
}

export default function ModelsModule() {
  const [activeEngine, setActiveEngine] = useState<EngineId>('ollama');
  const [modalState, setModalState] = useState<ModalState | null>(null);
  const [runModalState, setRunModalState] = useState<RunModalState | null>(null);
  const [engineState, setEngineState] = useState<Record<EngineId, EngineState>>({
    ollama: { items: [], loading: false, error: '' },
    llamaedge: { items: [], loading: false, error: '' },
    gguf: { items: [], loading: false, error: '' },
  });
  const [selectedRows, setSelectedRows] = useState<Record<EngineId, Set<string>>>(() => createEmptySelection());
  const [deletingRows, setDeletingRows] = useState<Record<EngineId, Set<string>>>(() => createEmptySelection());
  const [filterText, setFilterText] = useState<Record<EngineId, string>>({ ollama: '', llamaedge: '', gguf: '' });
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
        const items = engine === 'ollama'
          ? await listOllamaModels()
          : engine === 'llamaedge'
            ? await listLlamaEdgeContainers()
            : await listGgufFiles();
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
    refreshEngine('gguf');
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
  const rowCanBeDeleted = (row: RowItem) => {
    if (row.engine === 'llamaedge') {
      return !isDefaultLlamaEdgeRow(row);
    }
    if (row.engine === 'gguf') {
      return row.status !== 'running' && row.status !== 'starting' && row.status !== 'stopping';
    }
    return true;
  };
  const hasUndeletableSelection = activeItems.some((row) => selectedSet.has(row.id) && !rowCanBeDeleted(row));

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someFilteredSelected;
    }
  }, [someFilteredSelected, filteredRows.length, activeEngine]);

  const itemSummary = filteredRows.length === activeItems.length
    ? `${filteredRows.length} ${filteredRows.length === 1 ? 'item' : 'items'}`
    : `Showing ${filteredRows.length} of ${activeItems.length}`;

  const openModal = useCallback((engine: EngineId) => {
    if (engine === 'gguf') {
      setModalState({
        engine,
        value: '',
        error: '',
        busy: false,
        progress: undefined,
        ggufMode: 'download',
        ggufFilePath: '',
        ggufFileName: '',
      });
      return;
    }
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

  const openRunModalForRow = useCallback((row: RowItem) => {
    if (row.engine !== 'llamaedge' && row.engine !== 'gguf') {
      return;
    }
    setRunModalState({ engine: row.engine, row, args: [], envs: [], busy: false, error: '' });
  }, []);

  const closeRunModal = useCallback(() => {
    setRunModalState(null);
  }, []);

  const changeGgufMode = useCallback((mode: 'download' | 'upload') => {
    setModalState((prev) => {
      if (!prev || prev.engine !== 'gguf' || prev.ggufMode === mode) {
        return prev;
      }
      return {
        ...prev,
        ggufMode: mode,
        error: '',
      };
    });
  }, []);

  const handleSelectGgufFile = useCallback(async () => {
    if (!ddClient.desktopUI?.dialog) {
      toast.error('File picker is unavailable in this environment.');
      return;
    }
    try {
      const result = await ddClient.desktopUI.dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'GGUF files', extensions: ['gguf'] }],
      });
      if (result.canceled || !result.filePaths?.length) {
        return;
      }
      const path = result.filePaths[0];
      const fileName = basenameFromPath(path) || path;
      setModalState((prev) =>
        prev && prev.engine === 'gguf'
          ? {
              ...prev,
              ggufFilePath: path,
              ggufFileName: fileName,
              error: '',
            }
          : prev,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
    }
  }, []);

  const handleModalSubmit = useCallback(async () => {
    if (!modalState) {
      return;
    }
    const { engine } = modalState;
    const value = modalState.value.trim();
    if (
      (engine === 'ollama' || engine === 'llamaedge' || (engine === 'gguf' && (modalState.ggufMode ?? 'download') === 'download'))
      && !value
    ) {
      setModalState((prev) => (prev ? { ...prev, error: 'Value is required.' } : prev));
      return;
    }
    if (engine === 'gguf' && (modalState.ggufMode ?? 'download') === 'upload' && !modalState.ggufFilePath) {
      setModalState((prev) => (prev ? { ...prev, error: 'Select a GGUF file to upload.' } : prev));
      return;
    }
    setModalState((prev) =>
      prev
        ? {
            ...prev,
            busy: true,
            error: '',
            progress:
              engine === 'ollama'
                ? 'Preparing download…'
                : engine === 'llamaedge'
                  ? 'Starting container…'
                  : (modalState.ggufMode ?? 'download') === 'upload'
                    ? 'Uploading file…'
                    : 'Downloading file…',
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
      } else if (engine === 'llamaedge') {
        const { id } = await runLlamaEdgeContainer(value);
        toast.success(`Started container from ${value}`);
        closeModal();
        await refreshEngine(engine, { highlightId: id });
      } else {
        const mode = modalState.ggufMode ?? 'download';
        if (mode === 'download') {
          const fileName = await downloadGgufFile(value);
          toast.success(`Downloaded ${fileName}`);
          closeModal();
          await refreshEngine('gguf', { highlightId: fileName });
        } else {
          const fileName = await uploadGgufFile(modalState.ggufFilePath ?? '');
          toast.success(`Uploaded ${fileName}`);
          closeModal();
          await refreshEngine('gguf', { highlightId: fileName });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModalState((prev) => (prev ? { ...prev, busy: false, error: message, progress: undefined } : prev));
    }
  }, [modalState, closeModal, refreshEngine]);

  const handleRunModalSubmit = useCallback(async () => {
    if (!runModalState) {
      return;
    }
    const { engine, row } = runModalState;
    const userArgs = argsFromRows(runModalState.args);
    const userEnv = envFromRows(runModalState.envs);
    const hasOverrides = userArgs.length > 0 || Object.keys(userEnv).length > 0;
    setRunModalState((prev) => (prev ? { ...prev, busy: true, error: '' } : prev));
    setEngineState((prev) => ({
      ...prev,
      [engine]: {
        ...prev[engine],
        items: prev[engine].items.map((item) =>
          item.id === row.id ? { ...item, status: 'starting' } : item,
        ),
      },
    }));
    try {
      if (engine === 'gguf') {
        const existingContainerId = typeof row.extra?.containerId === 'string' ? row.extra.containerId : undefined;
        const existingPort = row.port;
        if (existingContainerId && !hasOverrides) {
          await startGgufContainerFromRow(row);
        } else {
          if (existingContainerId) {
            const token = getOpenWebUIToken();
            if (token && existingPort) {
              await removeLlamaEdgeConnection(existingPort);
            }
            await removeGgufContainer(existingContainerId);
          }
          await runGgufContainer(row.name, { args: userArgs, env: userEnv });
        }
        toast.success(`Started ${row.name}`);
        closeRunModal();
        await refreshEngine('gguf', { highlightId: row.id });
      } else {
        const isPresetRow = isLlamaEdgePresetRow(row);
        const image = typeof row.extra?.Image === 'string' ? row.extra.Image : row.name;
        let highlightId = row.id;
        if (!isPresetRow && !hasOverrides) {
          await startLlamaEdgeContainerFromRow(row);
        } else {
          if (!isPresetRow && row.id && hasOverrides) {
            const port = row.port ?? (typeof row.extra?.Ports === 'string' ? extractPort(row.extra.Ports) : undefined);
            const token = getOpenWebUIToken();
            if (token && port) {
              await removeLlamaEdgeConnection(port);
            }
            await deleteLlamaEdgeContainer(row.id);
          }
          const { id } = await runLlamaEdgeContainer(image, { args: userArgs, env: userEnv });
          highlightId = id;
        }
        toast.success(`Started container from ${image}`);
        closeRunModal();
        await refreshEngine('llamaedge', { highlightId });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunModalState((prev) => (prev ? { ...prev, busy: false, error: message } : prev));
    }
  }, [closeRunModal, refreshEngine, runModalState]);

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

  const handleRunRow = useCallback(
    (row: RowItem) => {
      setRowMenuId(null);
      if (row.engine === 'gguf' || row.engine === 'llamaedge') {
        openRunModalForRow(row);
      }
    },
    [openRunModalForRow],
  );

  const stopGgufRow = useCallback(
    async (row: RowItem) => {
      if (row.engine !== 'gguf') {
        return;
      }
      const containerId = typeof row.extra?.containerId === 'string' ? row.extra.containerId : undefined;
      if (!containerId) {
        return;
      }
      setRowMenuId(null);
      try {
        setEngineState((prev) => ({
          ...prev,
          gguf: {
            ...prev.gguf,
            items: prev.gguf.items.map((item) =>
              item.id === row.id ? { ...item, status: 'stopping' } : item,
            ),
          },
        }));
        await stopGgufContainer(containerId);
        toast.success(`Stopped ${row.name}`);
        await refreshEngine('gguf', { highlightId: row.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(message);
        await refreshEngine('gguf');
      }
    },
    [refreshEngine],
  );

  const deleteRow = useCallback(
    async (item: RowItem, options?: { skipConfirm?: boolean; skipRefresh?: boolean }) => {
      const { skipConfirm = false, skipRefresh = false } = options ?? {};
      setRowMenuId(null);
      if (!rowCanBeDeleted(item)) {
        if (item.engine === 'llamaedge') {
          toast.info('Default LlamaEdge models cannot be deleted.');
        } else if (item.engine === 'gguf') {
          toast.info('Stop the running container before deleting this GGUF file.');
        }
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
        } else if (item.engine === 'llamaedge') {
          if (!isLlamaEdgePresetRow(item)) {
            await deleteLlamaEdgeContainer(item.id);
            const port = item.port ?? (typeof item.extra?.Ports === 'string' ? extractPort(item.extra.Ports) : undefined);
            const token = getOpenWebUIToken();
            if (token) {
              await removeLlamaEdgeConnection(port);
            }
          }
        } else {
          const containerId = typeof item.extra?.containerId === 'string' ? item.extra.containerId : undefined;
          if (containerId) {
            await removeGgufContainer(containerId);
          }
          const port = item.port ?? (typeof item.extra?.Ports === 'string' ? extractPort(item.extra.Ports) : undefined);
          const token = getOpenWebUIToken();
          if (token) {
            await removeLlamaEdgeConnection(port);
          }
          await deleteGgufFile(item.name);
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
    [refreshEngine, rowCanBeDeleted, setDeletingForEngine, setSelectionForEngine],
  );

  const handleBulkDelete = useCallback(async () => {
    const selected = selectedRows[activeEngine];
    if (selected.size === 0) {
      return;
    }
    const rowsToDelete = activeItems.filter((row) => selected.has(row.id) && rowCanBeDeleted(row));
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
  }, [activeEngine, activeItems, deleteRow, refreshEngine, rowCanBeDeleted, selectedRows]);

  const modalForm = useMemo(() => {
    if (!modalState) {
      return null;
    }
    const config = ENGINE_CONFIG[modalState.engine];
    const isGgufModal = modalState.engine === 'gguf';
    const ggufMode = modalState.ggufMode ?? 'download';
    const submitLabel = modalState.busy
      ? 'Working…'
      : isGgufModal
        ? ggufMode === 'upload'
          ? 'Upload'
          : 'Download'
        : config.submitLabel;

    return (
      <div className="engine-modal" role="dialog" aria-modal="true">
        <div className="engine-modal__card">
          <div className="engine-modal__header">
            <h2>{config.modalTitle}</h2>
            <p>{config.modalDescription}</p>
          </div>
          {isGgufModal ? (
            <>
              <div className="engine-modal__helper">
                <label>
                  <input
                    type="radio"
                    name="gguf-mode"
                    value="download"
                    checked={ggufMode === 'download'}
                    onChange={() => changeGgufMode('download')}
                    disabled={modalState.busy}
                  />
                  {' '}
                  Download from URL
                </label>
                <label>
                  <input
                    type="radio"
                    name="gguf-mode"
                    value="upload"
                    checked={ggufMode === 'upload'}
                    onChange={() => changeGgufMode('upload')}
                    disabled={modalState.busy}
                  />
                  {' '}
                  Upload from local disk
                </label>
              </div>
              {ggufMode === 'upload' ? (
                <div>
                  <button
                    type="button"
                    className="engine-button engine-button--ghost"
                    onClick={handleSelectGgufFile}
                    disabled={modalState.busy}
                  >
                    {modalState.ggufFileName ? 'Choose another file' : 'Choose file'}
                  </button>
                  {modalState.ggufFileName && (
                    <div className="engine-modal__helper">Selected: {modalState.ggufFileName}</div>
                  )}
                  <div className="engine-modal__helper">Files are copied into a persistent /models volume.</div>
                </div>
              ) : (
                <label>
                  <div>GGUF file URL</div>
                  <input
                    className="engine-input"
                    type="url"
                    value={modalState.value}
                    onChange={(event) =>
                      setModalState((prev) => (prev ? { ...prev, value: event.target.value } : prev))
                    }
                    placeholder={config.placeholder}
                    disabled={modalState.busy}
                    autoFocus
                  />
                  <div className="engine-modal__helper">Provide a direct link to a .gguf file.</div>
                </label>
              )}
            </>
          ) : (
            <>
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
            </>
          )}
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
  }, [changeGgufMode, closeModal, handleModalSubmit, handleSelectGgufFile, modalState]);

  const runModalForm = useMemo(() => {
    if (!runModalState) {
      return null;
    }
    const titlePrefix = runModalState.engine === 'gguf' ? 'GGUF' : 'LlamaEdge';
    return (
      <div className="engine-modal" role="dialog" aria-modal="true">
        <div className="engine-modal__card">
          <div className="engine-modal__header">
            <h2>Run {titlePrefix} container</h2>
            <p>Customize the arguments or environment variables for {runModalState.row.name}.</p>
          </div>
          <ArgEnvInputs
            args={runModalState.args}
            envs={runModalState.envs}
            disabled={runModalState.busy}
            onChangeArgs={(nextArgs) =>
              setRunModalState((prev) => (prev ? { ...prev, args: nextArgs } : prev))
            }
            onChangeEnvs={(nextEnvs) =>
              setRunModalState((prev) => (prev ? { ...prev, envs: nextEnvs } : prev))
            }
          />
          {runModalState.error && <div className="engine-modal__error">{runModalState.error}</div>}
          <div className="engine-modal__footer">
            <button className="engine-button engine-button--ghost" onClick={closeRunModal} disabled={runModalState.busy}>
              Cancel
            </button>
            <button
              className="engine-button engine-button--primary"
              onClick={handleRunModalSubmit}
              disabled={runModalState.busy}
            >
              {runModalState.busy ? 'Starting…' : 'Run'}
            </button>
          </div>
        </div>
      </div>
    );
  }, [closeRunModal, handleRunModalSubmit, runModalState]);

  const disableDelete = selectedCount === 0 || activeState.loading || bulkDeleting || hasUndeletableSelection;
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
                {activeConfig.actionLabel}
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
                      let rowActions: { label: string; handler: () => void }[] = [];
                      if (row.engine === 'llamaedge') {
                        rowActions = [
                          (row.status === 'running' || isStopping)
                            ? { label: 'Stop', handler: () => void stopLlamaEdgeRow(row) }
                            : { label: 'Run', handler: () => void handleRunRow(row) },
                          ...(isDefaultRow ? [] : [{ label: 'Delete', handler: () => void deleteRow(row) }]),
                        ];
                      } else if (row.engine === 'gguf') {
                        rowActions = [
                          (row.status === 'running' || row.status === 'stopping')
                            ? { label: 'Stop', handler: () => void stopGgufRow(row) }
                            : { label: 'Run', handler: () => void handleRunRow(row) },
                          ...(rowCanBeDeleted(row) ? [{ label: 'Delete', handler: () => void deleteRow(row) }] : []),
                        ];
                      } else {
                        rowActions = [{ label: 'Delete', handler: () => void deleteRow(row) }];
                      }
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
      {runModalForm}
    </div>
  );
}
