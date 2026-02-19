import { toast } from 'react-toastify';
import { getOpenWebUIToken, readStoredOpenWebUIToken, reportOpenWebUIDebug } from './openWebuiHelpers';

const OPEN_WEBUI_BASE = 'http://localhost:11500';
export interface ToolServerConnection {
  url: string;
  path: string;
  type: string;
  auth_type: string;
  headers: Record<string, string> | null;
  key: string;
  config: {
    enable: boolean;
    function_name_filter_list: string[];
    access_control?: {
      read: { group_ids: string[]; user_ids: string[] };
      write: { group_ids: string[]; user_ids: string[] };
    };
  };
  spec_type: string;
  spec: string;
  info: {
    id: string;
    name: string;
    description: string;
  };
}

interface ToolServerResponse {
  ENABLE_DIRECT_CONNECTIONS?: boolean;
  ENABLE_BASE_MODELS_CACHE?: boolean;
  TOOL_SERVER_CONNECTIONS?: ToolServerConnection[];
}

export interface ToolServerConfig {
  enableDirectConnections: boolean;
  enableBaseModelsCache: boolean;
  connections: ToolServerConnection[];
}

export interface ModelInfoMeta {
  toolIds?: string[];
}

export interface ModelInfo {
  meta?: ModelInfoMeta;
}

export interface ModelSummary {
  id: string;
  info?: ModelInfo;
}

export interface ModelsResponse {
  data?: ModelSummary[];
}

interface FullModelResponse {
  id: string;
  name?: string;
  toolIds?: string[];
  meta?: Record<string, unknown>;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

async function openWebuiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getOpenWebUIToken() ?? readStoredOpenWebUIToken();
  if (!token) {
    throw new Error('Open WebUI token is not configured. Set one in Settings.');
  }
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return await fetch(`${OPEN_WEBUI_BASE}${path}`, { ...init, headers });
}

export async function fetchToolServerConfig(): Promise<ToolServerConfig> {
  const response = await openWebuiFetch('/api/v1/configs/tool_servers');
  if (!response.ok) {
    throw new Error(`Failed to fetch tool servers (${response.status})`);
  }
  const payload = (await response.json()) as ToolServerResponse;
  return {
    enableDirectConnections: Boolean(payload.ENABLE_DIRECT_CONNECTIONS),
    enableBaseModelsCache: Boolean(payload.ENABLE_BASE_MODELS_CACHE),
    connections: payload.TOOL_SERVER_CONNECTIONS ?? [],
  };
}

export async function saveToolServerConfig(config: ToolServerConfig): Promise<void> {
  const response = await openWebuiFetch('/api/v1/configs/tool_servers', {
    method: 'POST',
    body: JSON.stringify({
      ENABLE_DIRECT_CONNECTIONS: config.enableDirectConnections,
      ENABLE_BASE_MODELS_CACHE: config.enableBaseModelsCache,
      TOOL_SERVER_CONNECTIONS: config.connections,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to update tool server connections (${response.status})`);
  }
}

export async function fetchModels(): Promise<ModelsResponse> {
  const response = await openWebuiFetch('/api/models');
  if (!response.ok) {
    throw new Error(`Failed to fetch models (${response.status})`);
  }
  return (await response.json()) as ModelsResponse;
}

export async function fetchOpenWebuiConfigApi(): Promise<any> {
  const response = await openWebuiFetch('/openai/config');
  if (!response.ok) {
    throw new Error(`Failed to fetch Open WebUI config (${response.status})`);
  }
  return response.json();
}

export async function updateOpenWebuiConfigApi(payload: any): Promise<void> {
  const response = await openWebuiFetch('/openai/config/update', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to update Open WebUI config (${response.status})`);
  }
}

export async function fetchModelDetails(modelId: string): Promise<FullModelResponse | null> {
  const endpoint = `/api/v1/models/model?id=${encodeURIComponent(modelId)}`;
  try {
    const response = await openWebuiFetch(endpoint);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const text = await response.text();
      if (isNotFoundModelResponse(response.status, text)) {
        return null;
      }
      throw new Error(text || `Failed to fetch model ${modelId} (${response.status})`);
    }
    return (await response.json()) as FullModelResponse;
  } catch (error) {
    reportOpenWebUIDebug(
      `[mcpo-sync] Error fetching model ${modelId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function isNotFoundModelResponse(status: number, body: string): boolean {
  if (status === 404) {
    return true;
  }
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.detail === 'string') {
      const detail = parsed.detail.toLowerCase();
      if (detail.includes("could not find") || detail.includes('not found')) {
        return true;
      }
    }
  } catch {
    // ignore JSON parse failures
  }
  return false;
}

async function postModel(endpoint: string, model: FullModelResponse): Promise<void> {
  const response = await openWebuiFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify(model),
  });
  if (!response.ok) {
    const text = await response.text();
    reportOpenWebUIDebug(`Model request failed via ${endpoint}: ${text || `HTTP ${response.status}`}`);
    const error = new Error(text || `Failed to persist model ${model.id} (${response.status})`);
    (error as any).status = response.status;
    throw error;
  }
}

export async function updateModel(model: FullModelResponse): Promise<void> {
  await postModel('/api/v1/models/model/update', model);
}

export async function createModel(model: FullModelResponse): Promise<void> {
  await postModel('/api/v1/models/create', model);
}

export function reportOpenWebUIError(message: string) {
  toast.error(message);
}
