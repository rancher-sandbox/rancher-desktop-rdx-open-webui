import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { toast } from 'react-toastify';
import './ModuleContent.css';
import './McpConfigurationModule.css';
import {
  fetchComposeDetails,
  maskSensitiveEnvValues,
  readConfigFromHost,
  readStoredMcpoConfig,
  restartMcpoService,
  SensitiveValueMap,
  unmaskSensitiveEnvValues,
  writeConfigToHost,
  writeStoredMcpoConfig,
  writeFileToComposeVolume,
  buildComposeVolumeName,
  MCPO_PERSISTENT_SPEC_BASE_PATH,
  MCPO_SPEC_VOLUME_SUFFIX,
} from './mcpoConfig';
import { syncMcpoWithOpenWebui } from './mcpoSync';
import type { ComposeDetails } from './mcpoConfig';

type ConfigModalType = 'openapi' | 'custom';
type SpecSourceType = 'url' | 'file';

interface ModalArgRow {
  id: string;
  value: string;
}

interface ModalEnvRow {
  id: string;
  key: string;
  value: string;
}

interface AddServerModalState {
  type: ConfigModalType;
  serverId: string;
  displayName: string;
  description: string;
  command: string;
  args: ModalArgRow[];
  envs: ModalEnvRow[];
  specMode: SpecSourceType;
  specUrl: string;
  specFile: File | null;
  specFileName: string;
  busy: boolean;
  error: string;
}

const OPENAPI_DEFAULT_COMMAND = 'uvx';
const OPENAPI_DEFAULT_ARG = 'mcp-openapi-proxy';
const SPEC_STORAGE_DIR = 'openapi-specs';

function createArgRow(value = ''): ModalArgRow {
  return { id: `arg-${Math.random().toString(36).slice(2, 9)}`, value };
}

function createEnvRow(): ModalEnvRow {
  return { id: `env-${Math.random().toString(36).slice(2, 9)}`, key: '', value: '' };
}

function createAddModalState(type: ConfigModalType): AddServerModalState {
  return {
    type,
    serverId: '',
    displayName: '',
    description: '',
    command: type === 'openapi' ? OPENAPI_DEFAULT_COMMAND : '',
    args: type === 'openapi' ? [createArgRow(OPENAPI_DEFAULT_ARG)] : [],
    envs: [],
    specMode: 'url',
    specUrl: '',
    specFile: null,
    specFileName: '',
    busy: false,
    error: '',
  };
}

function isValidServerId(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

type MutableMcpoConfig = Record<string, unknown> & { mcpServers: Record<string, unknown> };

function parseEditorConfig(text: string): MutableMcpoConfig {
  const trimmed = text.trim();
  if (!trimmed) {
    return { mcpServers: {} };
  }
  const parsed = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Configuration must be a JSON object.');
  }
  const root = parsed as MutableMcpoConfig;
  if (!root.mcpServers || typeof root.mcpServers !== 'object' || Array.isArray(root.mcpServers)) {
    root.mcpServers = {};
  }
  return root;
}

function sanitizePathSegment(raw: string, fallback: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return normalized || fallback;
}

function buildSpecRelativePath(serverId: string, fileName: string): string {
  const serverSegment = sanitizePathSegment(serverId || 'server', 'server');
  const fileSegment = sanitizePathSegment(fileName || 'spec', 'spec');
  const timestamp = Date.now();
  return `${SPEC_STORAGE_DIR}/${serverSegment}/${timestamp}-${fileSegment}`;
}

export default function McpConfigurationModule() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [composeDetails, setComposeDetails] = useState<ComposeDetails | null>(null);
  const initialStoredConfig = useMemo(() => readStoredMcpoConfig() ?? '', []);
  const initialMask = useMemo(() => maskSensitiveEnvValues(initialStoredConfig), [initialStoredConfig]);
  const [configText, setConfigText] = useState(initialMask.maskedText);
  const [savedText, setSavedText] = useState(initialMask.maskedText);
  const [maskMap, setMaskMap] = useState<SensitiveValueMap>(initialMask.maskMap);
  const [busy, setBusy] = useState(false);
  const [addModalState, setAddModalState] = useState<AddServerModalState | null>(null);

  const hasChanges = configText !== savedText;

  const loadConfiguration = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const details = await fetchComposeDetails();
      const text = await readConfigFromHost(details.configDir);
      const { maskedText, maskMap: nextMaskMap } = maskSensitiveEnvValues(text);
      setComposeDetails(details);
      setConfigText(maskedText);
      setSavedText(maskedText);
      setMaskMap(nextMaskMap);
      writeStoredMcpoConfig(text);
      void syncMcpoWithOpenWebui(text);
    } catch (cause) {
      const message = formatError(cause);
      console.error('[mcp-config] load failed', message);
      setError(message);
      setComposeDetails(null);
      setConfigText('');
      setSavedText('');
      setMaskMap({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfiguration().catch((cause) => {
      setError(formatError(cause));
    });
  }, [loadConfiguration]);

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setConfigText(event.target.value);
  }, []);

  const handleCancel = useCallback(() => {
    setConfigText(savedText);
  }, [savedText]);

  const handleApply = useCallback(async () => {
    if (!composeDetails) {
      return;
    }
    let actualConfigText: string;
    try {
      actualConfigText = unmaskSensitiveEnvValues(configText, maskMap);
    } catch (cause) {
      toast.error(`Invalid JSON: ${cause instanceof Error ? cause.message : cause}`);
      return;
    }
    setBusy(true);
    try {
      await writeConfigToHost(composeDetails.configDir, actualConfigText);
      await restartMcpoService(composeDetails.projectName, composeDetails.composeFile);
      const { maskedText, maskMap: nextMaskMap } = maskSensitiveEnvValues(actualConfigText);
      setConfigText(maskedText);
      setSavedText(maskedText);
      setMaskMap(nextMaskMap);
      writeStoredMcpoConfig(actualConfigText);
      toast.success('mcpo configuration updated and service restarted.');
      void syncMcpoWithOpenWebui(actualConfigText);
    } catch (cause) {
      toast.error(`Failed to update configuration: ${formatError(cause)}`);
    } finally {
      setBusy(false);
    }
  }, [composeDetails, configText, maskMap]);

  const openAddModal = useCallback(() => {
    setAddModalState(createAddModalState('openapi'));
  }, []);

  const closeAddModal = useCallback(() => {
    setAddModalState(null);
  }, []);

  const updateAddModal = useCallback((updates: Partial<AddServerModalState>) => {
    setAddModalState((prev) => (prev ? { ...prev, ...updates } : prev));
  }, []);

  const changeModalType = useCallback((type: ConfigModalType) => {
    setAddModalState((prev) => {
      if (!prev) {
        return prev;
      }
      if (prev.type === type) {
        return prev;
      }
      return {
        ...prev,
        type,
        command: type === 'openapi' && !prev.command ? OPENAPI_DEFAULT_COMMAND : prev.command,
        args:
          type === 'openapi' && prev.args.length === 0 ? [createArgRow(OPENAPI_DEFAULT_ARG)] : prev.args,
      };
    });
  }, []);

  const addArgRow = useCallback(() => {
    setAddModalState((prev) => (prev ? { ...prev, args: [...prev.args, createArgRow()] } : prev));
  }, []);

  const updateArgRow = useCallback((rowId: string, value: string) => {
    setAddModalState((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        args: prev.args.map((row) => (row.id === rowId ? { ...row, value } : row)),
      };
    });
  }, []);

  const removeArgRow = useCallback((rowId: string) => {
    setAddModalState((prev) => {
      if (!prev) {
        return prev;
      }
      return { ...prev, args: prev.args.filter((row) => row.id !== rowId) };
    });
  }, []);

  const addEnvRow = useCallback(() => {
    setAddModalState((prev) => (prev ? { ...prev, envs: [...prev.envs, createEnvRow()] } : prev));
  }, []);

  const updateEnvRow = useCallback((rowId: string, field: 'key' | 'value', value: string) => {
    setAddModalState((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        envs: prev.envs.map((row) => (row.id === rowId ? { ...row, [field]: value } : row)),
      };
    });
  }, []);

  const removeEnvRow = useCallback((rowId: string) => {
    setAddModalState((prev) => {
      if (!prev) {
        return prev;
      }
      return { ...prev, envs: prev.envs.filter((row) => row.id !== rowId) };
    });
  }, []);

  const changeSpecMode = useCallback((mode: SpecSourceType) => {
    setAddModalState((prev) => {
      if (!prev || prev.specMode === mode) {
        return prev;
      }
      return {
        ...prev,
        specMode: mode,
        ...(mode === 'url'
          ? {
              specFile: null,
              specFileName: '',
            }
          : { specUrl: '' }),
      };
    });
  }, []);

  const handleSpecFileSelection = useCallback((file: File | null) => {
    setAddModalState((prev) =>
      prev
        ? {
            ...prev,
            specFile: file,
            specFileName: file?.name ?? '',
          }
        : prev,
    );
  }, []);

  const handleModalAddServer = useCallback(async () => {
    if (!addModalState) {
      return;
    }
    const trimmedServerId = addModalState.serverId.trim();
    if (!trimmedServerId) {
      updateAddModal({ error: 'Provide a server ID.' });
      return;
    }
    if (!isValidServerId(trimmedServerId)) {
      updateAddModal({ error: 'Server ID may use letters, numbers, dots, underscores, or dashes.' });
      return;
    }
    const trimmedCommand = addModalState.command.trim();
    if (!trimmedCommand) {
      updateAddModal({ error: 'Provide a command to run.' });
      return;
    }
    if (addModalState.type === 'openapi') {
      if (addModalState.specMode === 'url') {
        if (!addModalState.specUrl.trim()) {
          updateAddModal({ error: 'Provide an OpenAPI specification URL.' });
          return;
        }
      } else if (!addModalState.specFile) {
        updateAddModal({ error: 'Select an OpenAPI specification file to upload.' });
        return;
      }
    }
    updateAddModal({ busy: true, error: '' });
    try {
      const configObject = parseEditorConfig(configText || '{}');
      if (!configObject.mcpServers) {
        configObject.mcpServers = {};
      }
      if (trimmedServerId in configObject.mcpServers) {
        throw new Error('A server with this ID already exists. Choose another ID.');
      }
      const args = addModalState.args.map((row) => row.value.trim()).filter(Boolean);
      const envEntries = addModalState.envs
        .map((row) => ({ key: row.key.trim(), value: row.value }))
        .filter((row) => row.key);
      const env: Record<string, string> = {};
      envEntries.forEach((entry) => {
        env[entry.key] = entry.value;
      });
      if (addModalState.type === 'openapi') {
        if (addModalState.specMode === 'url') {
          env.OPENAPI_SPEC_URL = addModalState.specUrl.trim();
        } else if (addModalState.specFile) {
          const details = composeDetails ?? (await fetchComposeDetails());
          if (!composeDetails) {
            setComposeDetails(details);
          }
          const fileContent = await addModalState.specFile.text();
          const relativePath = buildSpecRelativePath(
            trimmedServerId,
            addModalState.specFileName || addModalState.specFile.name || 'spec',
          );
          const volumeName = buildComposeVolumeName(details.projectName, MCPO_SPEC_VOLUME_SUFFIX);
          await writeFileToComposeVolume(volumeName, relativePath, fileContent);
          env.OPENAPI_SPEC_URL = `file://${MCPO_PERSISTENT_SPEC_BASE_PATH}/${relativePath}`;
        }
      }
      const definition: Record<string, unknown> = {
        command: trimmedCommand,
      };
      if (args.length) {
        definition.args = args;
      }
      if (Object.keys(env).length) {
        definition.env = env;
      }
      const name = addModalState.displayName.trim();
      const description = addModalState.description.trim();
      if (name || description) {
        definition.info = {
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
        };
      }
      configObject.mcpServers[trimmedServerId] = definition;
      const nextText = JSON.stringify(configObject, null, 2);
      setConfigText(nextText);
      setAddModalState(null);
      toast.success(`${trimmedServerId} added to the mcpo configuration editor. Click Apply to persist.`);
    } catch (cause) {
      updateAddModal({ busy: false, error: formatError(cause) });
    }
  }, [addModalState, composeDetails, configText, updateAddModal]);

  return (
    <div className="rdx-module">
      <header className="rdx-module__header">
        <h1>Configuration</h1>
      </header>
      <section className="rdx-module__section rdx-module__section--fill">
        {loading ? (
          <div className="rdx-config-placeholder">
            <span className="rdx-config-spinner" aria-hidden="true" />
            Loading mcpo configuration...
          </div>
        ) : error ? (
          <div className="rdx-config-error">
            <div>Failed to load configuration: {error}</div>
            <button type="button" onClick={loadConfiguration} disabled={busy}>
              Retry
            </button>
          </div>
        ) : (
          <div className="rdx-config-editor">
            <div className="rdx-config-editor__toolbar">
              <button type="button" onClick={openAddModal} disabled={busy}>
                Add
              </button>
            </div>
            <div className="rdx-config-editor__textarea-wrapper">
              {busy && (
                <div className="rdx-config-spinner-overlay" aria-hidden="true">
                  <span className="rdx-config-spinner" />
                </div>
              )}
              <textarea
                className="rdx-config-editor__textarea"
                value={configText}
                onChange={handleChange}
                spellCheck={false}
                disabled={busy}
                aria-label="mcpo configuration JSON"
              />
            </div>
            <div className="rdx-config-editor__actions">
              <button
                type="button"
                className="rdx-config-editor__button-secondary"
                onClick={handleCancel}
                disabled={!hasChanges || busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rdx-config-editor__button-primary"
                onClick={handleApply}
                disabled={!hasChanges || busy}
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </section>
      {addModalState && (
        <div className="mcp-config-modal" role="dialog" aria-modal="true">
          <div className="mcp-config-modal__card">
            <div className="mcp-config-modal__header">
              <div>
                <h2>Add MCP server</h2>
                <p>Define the command, arguments, and environment variables for a new mcpo server entry.</p>
              </div>
              <div className="mcp-config-modal__type-toggle" role="radiogroup" aria-label="Server type">
                <label>
                  <input
                    type="radio"
                    name="mcp-config-type"
                    value="openapi"
                    checked={addModalState.type === 'openapi'}
                    onChange={() => changeModalType('openapi')}
                    disabled={addModalState.busy}
                  />
                  OpenAPI to MCP
                </label>
                <label>
                  <input
                    type="radio"
                    name="mcp-config-type"
                    value="custom"
                    checked={addModalState.type === 'custom'}
                    onChange={() => changeModalType('custom')}
                    disabled={addModalState.busy}
                  />
                  Custom
                </label>
              </div>
            </div>
            <div className="mcp-config-modal__body">
              <label className="mcp-config-modal__field">
                <span>Server ID</span>
                <input
                  type="text"
                  value={addModalState.serverId}
                  onChange={(event) => updateAddModal({ serverId: event.target.value })}
                  disabled={addModalState.busy}
                  placeholder="time"
                />
                <span className="mcp-config-modal__helper">Alphanumeric, period, underscore, and dash characters only.</span>
              </label>
              <label className="mcp-config-modal__field">
                <span>Display name (optional)</span>
                <input
                  type="text"
                  value={addModalState.displayName}
                  onChange={(event) => updateAddModal({ displayName: event.target.value })}
                  disabled={addModalState.busy}
                  placeholder="Time"
                />
              </label>
              <label className="mcp-config-modal__field">
                <span>Description (optional)</span>
                <textarea
                  rows={3}
                  value={addModalState.description}
                  onChange={(event) => updateAddModal({ description: event.target.value })}
                  disabled={addModalState.busy}
                  placeholder="Describe what this server provides."
                />
              </label>
              <label className="mcp-config-modal__field">
                <span>Command</span>
                <input
                  type="text"
                  value={addModalState.command}
                  onChange={(event) => updateAddModal({ command: event.target.value })}
                  disabled={addModalState.busy}
                  placeholder="docker"
                />
              </label>
              <div>
                <div className="mcp-config-modal__list-header">
                  <span>Arguments</span>
                  <button type="button" onClick={addArgRow} disabled={addModalState.busy}>
                    Add argument
                  </button>
                </div>
                <div className="mcp-config-modal__list">
                  {addModalState.args.length === 0 && (
                    <div className="mcp-config-modal__empty-row">No arguments yet.</div>
                  )}
                  {addModalState.args.map((arg) => (
                    <div key={arg.id} className="mcp-config-modal__row mcp-config-modal__row--args">
                      <input
                        type="text"
                        value={arg.value}
                        onChange={(event) => updateArgRow(arg.id, event.target.value)}
                        disabled={addModalState.busy}
                        placeholder="run"
                      />
                      <button type="button" onClick={() => removeArgRow(arg.id)} disabled={addModalState.busy}>
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="mcp-config-modal__list-header">
                  <span>Environment variables</span>
                  <button type="button" onClick={addEnvRow} disabled={addModalState.busy}>
                    Add variable
                  </button>
                </div>
                <div className="mcp-config-modal__list">
                  {addModalState.envs.length === 0 && (
                    <div className="mcp-config-modal__empty-row">No environment variables yet.</div>
                  )}
                  {addModalState.envs.map((env) => (
                    <div key={env.id} className="mcp-config-modal__row mcp-config-modal__row--env">
                      <input
                        type="text"
                        value={env.key}
                        onChange={(event) => updateEnvRow(env.id, 'key', event.target.value)}
                        disabled={addModalState.busy}
                        placeholder="API_KEY"
                      />
                      <input
                        type="text"
                        value={env.value}
                        onChange={(event) => updateEnvRow(env.id, 'value', event.target.value)}
                        disabled={addModalState.busy}
                        placeholder="value"
                      />
                      <button type="button" onClick={() => removeEnvRow(env.id)} disabled={addModalState.busy}>
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              {addModalState.type === 'openapi' && (
                <div className="mcp-config-modal__spec">
                  <div className="mcp-config-modal__list-header">
                    <span>OpenAPI specification</span>
                  </div>
                  <div className="mcp-config-modal__spec-options">
                    <label>
                      <input
                        type="radio"
                        name="mcp-config-spec-source"
                        value="url"
                        checked={addModalState.specMode === 'url'}
                        onChange={() => changeSpecMode('url')}
                        disabled={addModalState.busy}
                      />
                      Provide URL
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="mcp-config-spec-source"
                        value="file"
                        checked={addModalState.specMode === 'file'}
                        onChange={() => changeSpecMode('file')}
                        disabled={addModalState.busy}
                      />
                      Upload file
                    </label>
                  </div>
                  {addModalState.specMode === 'url' ? (
                    <input
                      type="url"
                      value={addModalState.specUrl}
                      onChange={(event) => updateAddModal({ specUrl: event.target.value })}
                      disabled={addModalState.busy}
                      placeholder="https://example.com/openapi.json"
                    />
                  ) : (
                    <div className="mcp-config-modal__file-picker">
                      <input
                        type="file"
                        accept=".json,.yaml,.yml,application/json,text/yaml"
                        onChange={(event) => handleSpecFileSelection(event.target.files?.[0] ?? null)}
                        disabled={addModalState.busy}
                      />
                      {addModalState.specFileName && (
                        <div className="mcp-config-modal__file-name">Selected: {addModalState.specFileName}</div>
                      )}
                      <p className="mcp-config-modal__helper">
                        Files are stored under {MCPO_PERSISTENT_SPEC_BASE_PATH}/{SPEC_STORAGE_DIR} so mcpo can access them.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
            {addModalState.error && <div className="mcp-config-modal__error">{addModalState.error}</div>}
            <div className="mcp-config-modal__footer">
              <button type="button" onClick={closeAddModal} disabled={addModalState.busy}>
                Cancel
              </button>
              <button type="button" className="mcp-config-modal__primary" onClick={handleModalAddServer} disabled={addModalState.busy}>
                {addModalState.busy ? 'Adding…' : 'Add server'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
