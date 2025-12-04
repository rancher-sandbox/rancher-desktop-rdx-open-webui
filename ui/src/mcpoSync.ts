import { toast } from 'react-toastify';
import {
  extractMcpoServers,
  MCPO_BASE_URL,
  normalizeConfigText,
  type McpoServerDefinition,
} from './mcpoConfig';
import {
  fetchModels,
  fetchModelDetails,
  fetchToolServerConfig,
  reportOpenWebUIError,
  ToolServerConnection,
  ToolServerConfig,
  saveToolServerConfig,
  createModel,
  updateModel,
} from './openWebuiApi';
import type { ModelSummary } from './openWebuiApi';
import { reportOpenWebUIDebug } from './openWebuiHelpers';

const TOOL_SERVER_PREFIX = 'server:';
const TOOL_SERVER_PATH = 'openapi.json';
const TOKEN_TOAST_ID = 'mcp-sync-token';

let syncQueue: Promise<void> = Promise.resolve();

export function syncMcpoWithOpenWebui(configText: string): Promise<void> {
  const trimmed = normalizeConfigText(configText || '');
  if (!trimmed) {
    syncQueue = syncQueue.then(() => clearManagedState()).catch(handleSyncError);
    return syncQueue;
  }
  syncQueue = syncQueue.then(() => runSync(trimmed)).catch(handleSyncError);
  return syncQueue;
}

async function clearManagedState() {
  await disableManagedToolServers();
  await syncModelToolAssignments([]);
}

async function runSync(configText: string) {
  const servers = extractMcpoServers(configText);
  await syncToolServers(servers);
  await syncModelToolAssignments(servers.map((server) => server.id));
}

async function disableManagedToolServers() {
  try {
    const config = await fetchToolServerConfig();
    const nextConnections = config.connections.filter((connection) => !isManagedToolServer(connection));
    if (connectionsEqual(config.connections, nextConnections)) {
      return;
    }
    await saveToolServerConfig({
      ...config,
      connections: nextConnections,
    });
  } catch (error) {
    throw new Error(formatMessage('Failed to disable MCP tool servers', error));
  }
}

async function syncToolServers(servers: McpoServerDefinition[]) {
  try {
    const config = await fetchToolServerConfig();
    const preserved = config.connections.filter((connection) => !isManagedToolServer(connection));
    const desiredConnections = servers.map((server) => buildToolServerConnection(server));
    const nextConnections = [...preserved, ...desiredConnections];
    if (connectionsEqual(config.connections, nextConnections)) {
      return;
    }
    const nextConfig: ToolServerConfig = {
      enableDirectConnections: config.enableDirectConnections,
      enableBaseModelsCache: config.enableBaseModelsCache,
      connections: nextConnections,
    };
    await saveToolServerConfig(nextConfig);
  } catch (error) {
    throw new Error(formatMessage('Failed to synchronize tool servers', error));
  }
}

async function syncModelToolAssignments(serverIds: string[]) {
  try {
    const uniqueServerIds = Array.from(new Set(serverIds));
    const desiredToolIds = uniqueServerIds.map((id) => `${TOOL_SERVER_PREFIX}${id}`);
    const modelResponse = await fetchModels();
    const models = modelResponse.data ?? [];
    for (const model of models) {
      if (!model.id) {
        continue;
      }
      const current = Array.isArray(model.info?.meta?.toolIds)
        ? model.info?.meta?.toolIds.filter((id): id is string => typeof id === 'string')
        : [];
      const preserved = current.filter((id) => !id.startsWith(TOOL_SERVER_PREFIX));
      const merged = [...preserved];
      desiredToolIds.forEach((toolId) => {
        if (!merged.includes(toolId)) {
          merged.push(toolId);
        }
      });
      if (!arraysEqual(current, merged)) {
        await upsertModelWithToolIds(model, merged);
      }
    }
  } catch (error) {
    reportOpenWebUIDebug(`[mcpo-sync] model sync error: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(formatMessage('Failed to synchronize models', error));
  }
}

function buildToolServerConnection(server: McpoServerDefinition): ToolServerConnection {
  return {
    url: server.url,
    path: TOOL_SERVER_PATH,
    type: 'openapi',
    auth_type: 'bearer',
    headers: null,
    key: '',
    config: {
      enable: true,
      function_name_filter_list: [],
      access_control: {
        read: { group_ids: [], user_ids: [] },
        write: { group_ids: [], user_ids: [] },
      },
    },
    spec_type: 'url',
    spec: '',
    info: {
      id: server.id,
      name: server.name,
      description: server.description,
    },
  };
}

function isManagedToolServer(connection: ToolServerConnection): boolean {
  return typeof connection.url === 'string' && connection.url.startsWith(MCPO_BASE_URL);
}

function areConnectionsEqual(a: ToolServerConnection, b: ToolServerConnection): boolean {
  return (
    a.url === b.url &&
    a.path === b.path &&
    a.type === b.type &&
    a.auth_type === b.auth_type &&
    a.key === b.key &&
    normalizeHeaders(a.headers) === normalizeHeaders(b.headers) &&
    JSON.stringify(a.config) === JSON.stringify(b.config) &&
    a.spec_type === b.spec_type &&
    a.spec === b.spec &&
    a.info?.id === b.info?.id &&
    a.info?.name === b.info?.name &&
    a.info?.description === b.info?.description
  );
}

function normalizeHeaders(headers: Record<string, string> | null): string {
  if (!headers) {
    return '';
  }
  const entries = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

async function upsertModelWithToolIds(model: ModelSummary, toolIds: string[]) {
  const modelId = model.id;
  try {
    const existing = await fetchModelDetails(modelId);
    if (!existing) {
      const payload = buildDefaultModelPayload(modelId, toolIds, (model.info ?? {}) as Record<string, unknown>);
      await createModel(payload);
      return;
    }
    const payload = {
      ...existing,
      meta: { ...(existing.meta ?? {}), toolIds },
      params: { ...(existing.params ?? {}), function_calling: "native" }
    };
    try {
      await updateModel(payload);
    } catch (error) {
      if ((error as any)?.status === 404) {
        await createModel(payload);
      } else {
        throw error;
      }
    }
  } catch (error) {
    throw new Error(formatMessage(`Failed to upsert model ${modelId}`, error));
  }
}

function buildDefaultModelPayload(modelId: string, toolIds: string[], info: Record<string, unknown>) {
  const meta =
    (typeof info.meta === 'object' && info.meta !== null ? { ...(info.meta as Record<string, unknown>) } : null) ?? {};
  const params =
    (typeof info.params === 'object' && info.params !== null ? (info.params as Record<string, unknown>) : {}) ?? {};
  const accessControl =
    (typeof info.access_control === 'object' && info.access_control !== null
      ? (info.access_control as Record<string, unknown>)
      : { read: { group_ids: [], user_ids: [] }, write: { group_ids: [], user_ids: [] } }) ??
    { read: { group_ids: [], user_ids: [] }, write: { group_ids: [], user_ids: [] } };
  return {
    id: modelId,
    name: typeof info.name === 'string' ? (info.name as string) : modelId,
    base_model_id: (info.base_model_id as string | null) ?? null,
    meta: { ...meta, toolIds },
    params: {...params, function_calling: "native" },
    access_control: accessControl,
    is_active: true,
    user_id: typeof info.user_id === 'string' ? (info.user_id as string) : 'system',
  };
}

function connectionsEqual(a: ToolServerConnection[], b: ToolServerConnection[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (!areConnectionsEqual(a[index], b[index])) {
      return false;
    }
  }
  return true;
}

function handleSyncError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('token is not configured')) {
    toast.info('Provide an Open WebUI token in Settings to sync MCP connections.', { toastId: TOKEN_TOAST_ID });
    return;
  }
  reportOpenWebUIError(message);
}

function formatMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
