import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import './ModuleContent.css';
import './McpCatalogModule.css';
import {
  CatalogSourceDefinition,
  describeCatalogSource,
  getEffectiveCatalogSources,
  subscribeToCatalogSources,
} from './catalogSources';
import {
  ComposeDetails,
  extractMcpoServers,
  fetchComposeDetails,
  parseMcpoConfig,
  readConfigFromHost,
  readStoredMcpoConfig,
  restartMcpoService,
  writeConfigToHost,
  writeStoredMcpoConfig,
} from './mcpoConfig';
import { syncMcpoWithOpenWebui } from './mcpoSync';

const DEFAULT_RUN_TAG = 'latest';

interface CatalogEntry {
  id: string;
  serverId: string;
  displayName: string;
  description: string;
  image: string;
  lastUpdated?: string;
  categories: string[];
}

interface DockerHubRepository {
  name?: string;
  namespace?: string;
  description?: string;
  star_count?: number;
  pull_count?: number;
  last_updated?: string;
  categories?: { name?: string }[];
}

interface DockerHubResponse {
  next?: string | null;
  results?: DockerHubRepository[];
}

type McpoConfigObject = ReturnType<typeof parseMcpoConfig>;

interface RunModalEnv {
  id: string;
  key: string;
  value: string;
}

interface RunModalState {
  item: CatalogEntry;
  image: string;
  tag: string;
  envs: RunModalEnv[];
  busy: boolean;
  error: string;
}

const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export default function McpCatalogModule() {
  const initialStoredConfig = useMemo(() => (typeof window === 'undefined' ? '' : readStoredMcpoConfig() ?? ''), []);
  const [configText, setConfigText] = useState(initialStoredConfig);
  const [installedServers, setInstalledServers] = useState<Set<string>>(
    () => new Set(extractMcpoServers(initialStoredConfig).map((server) => server.id)),
  );
  const [composeDetails, setComposeDetails] = useState<ComposeDetails | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState('');
  const [configBusy, setConfigBusy] = useState(false);

  const [sources, setSources] = useState<CatalogSourceDefinition[]>(() => getEffectiveCatalogSources());
  const [selectedSourceId, setSelectedSourceId] = useState(() => sources[0]?.id ?? '');
  const [catalogItems, setCatalogItems] = useState<CatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [filterText, setFilterText] = useState('');
  const [modalState, setModalState] = useState<RunModalState | null>(null);
  const [removingServerId, setRemovingServerId] = useState('');

  useEffect(() => {
    const unsubscribe = subscribeToCatalogSources(() => {
      setSources(getEffectiveCatalogSources());
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!sources.length) {
      setSelectedSourceId('');
      return;
    }
    if (!sources.some((source) => source.id === selectedSourceId)) {
      setSelectedSourceId(sources[0].id);
    }
  }, [selectedSourceId, sources]);

  const selectedSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) ?? sources[0] ?? null,
    [selectedSourceId, sources],
  );

  const loadMcpoConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError('');
    try {
      const details = await fetchComposeDetails();
      const text = await readConfigFromHost(details.configDir);
      setComposeDetails(details);
      setConfigText(text);
      setInstalledServers(new Set(extractMcpoServers(text).map((server) => server.id)));
      writeStoredMcpoConfig(text);
    } catch (error) {
      setConfigError(formatError(error));
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMcpoConfig().catch((error) => setConfigError(formatError(error)));
  }, [loadMcpoConfig]);

  useEffect(() => {
    if (!selectedSource) {
      setCatalogItems([]);
      return;
    }
    if (selectedSource.type !== 'http') {
      setCatalogItems([]);
      setCatalogError('Registry sources are stored but not yet supported in the Catalog.');
      setCatalogLoading(false);
      return;
    }
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError('');
    fetchHttpCatalog(selectedSource, controller.signal)
      .then((items) => {
        setCatalogItems(items);
        setCatalogLoading(false);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        setCatalogError(formatError(error));
        setCatalogItems([]);
        setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [selectedSource]);

  const filteredItems = useMemo(() => {
    if (!filterText.trim()) {
      return catalogItems;
    }
    const needle = filterText.trim().toLowerCase();
    return catalogItems.filter((item) =>
      item.displayName.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle),
    );
  }, [catalogItems, filterText]);

  const openModal = useCallback((item: CatalogEntry) => {
    setModalState({
      item,
      image: item.image,
      tag: DEFAULT_RUN_TAG,
      envs: [],
      busy: false,
      error: '',
    });
  }, []);

  const closeModal = useCallback(() => {
    setModalState(null);
  }, []);

  const updateModal = useCallback((updates: Partial<RunModalState>) => {
    setModalState((prev) => (prev ? { ...prev, ...updates } : prev));
  }, []);

  const addEnvRow = useCallback(() => {
    setModalState((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        envs: [...prev.envs, { id: generateEnvId(), key: '', value: '' }],
      };
    });
  }, []);

  const updateEnvRow = useCallback((envId: string, field: 'key' | 'value', value: string) => {
    setModalState((prev) => {
      if (!prev) {
        return prev;
      }
      const envs = prev.envs.map((env) => (env.id === envId ? { ...env, [field]: value } : env));
      return { ...prev, envs };
    });
  }, []);

  const removeEnvRow = useCallback((envId: string) => {
    setModalState((prev) => {
      if (!prev) {
        return prev;
      }
      return { ...prev, envs: prev.envs.filter((env) => env.id !== envId) };
    });
  }, []);

  const mutateMcpoConfig = useCallback(
    async (mutator: (config: McpoConfigObject) => boolean, successMessage: string) => {
      setConfigBusy(true);
      try {
        const details = composeDetails ?? (await fetchComposeDetails());
        if (!composeDetails) {
          setComposeDetails(details);
        }
        const sourceText = configText || (await readConfigFromHost(details.configDir));
        const parsed = parseMcpoConfig(sourceText || '{}');
        const working = cloneMcpoConfig(parsed);
        const changed = mutator(working);
        if (!changed) {
          toast.info('No changes were required for the mcpo configuration.');
          return;
        }
        const nextText = JSON.stringify(working, null, 2);
        await writeConfigToHost(details.configDir, nextText);
        await restartMcpoService(details.projectName, details.composeFile);
        setConfigText(nextText);
        const nextServers = extractMcpoServers(nextText).map((server) => server.id);
        setInstalledServers(new Set(nextServers));
        writeStoredMcpoConfig(nextText);
        toast.success(successMessage);
        void syncMcpoWithOpenWebui(nextText);
      } catch (error) {
        toast.error(`Failed to update mcpo configuration: ${formatError(error)}`);
        throw error;
      } finally {
        setConfigBusy(false);
      }
    },
    [composeDetails, configText],
  );

  const handleModalSubmit = useCallback(async () => {
    if (!modalState) {
      return;
    }
    const trimmedImage = modalState.image.trim();
    const trimmedTag = modalState.tag.trim() || DEFAULT_RUN_TAG;
    if (!trimmedImage) {
      updateModal({ error: 'Provide a valid container image.' });
      return;
    }
    const envEntries = modalState.envs
      .map((entry) => ({ key: entry.key.trim(), value: entry.value }))
      .filter((entry) => entry.key);
    const envRecord: Record<string, string> = {};
    envEntries.forEach((entry) => {
      envRecord[entry.key] = entry.value;
    });
    updateModal({ busy: true, error: '' });
    try {
      await mutateMcpoConfig(
        (config) => addServerToConfig(config, modalState.item, trimmedImage, trimmedTag, envRecord),
        `${modalState.item.displayName} added to mcpo configuration.`,
      );
      setModalState(null);
    } catch (error) {
      updateModal({ busy: false, error: formatError(error) });
    }
  }, [modalState, mutateMcpoConfig, updateModal]);

  const handleRemoveServer = useCallback(
    (item: CatalogEntry) => {
      setRemovingServerId(item.serverId);
      mutateMcpoConfig(
        (config) => removeServerFromConfig(config, item.serverId),
        `${item.displayName} removed from mcpo configuration.`,
      )
        .catch(() => {
          /* no-op: toast already emitted */
        })
        .finally(() => {
          setRemovingServerId('');
        });
    },
    [mutateMcpoConfig],
  );

  const modalContent = useMemo(() => {
    if (!modalState) {
      return null;
    }
    const fullImage = `${modalState.image || modalState.item.image}:${modalState.tag || DEFAULT_RUN_TAG}`;
    return (
      <div className="catalog-modal" role="dialog" aria-modal="true">
        <div className="catalog-modal__card">
          <div className="catalog-modal__header">
            <h2>Run {modalState.item.displayName}</h2>
            <p>Configure image details and optional environment variables before adding this MCP server.</p>
          </div>
          <div className="catalog-modal__body">
            <label className="catalog-modal__field">
              <span>Image name</span>
              <input
                type="text"
                value={modalState.image}
                onChange={(event) => updateModal({ image: event.target.value })}
                placeholder="mcp/fetch"
                disabled={modalState.busy}
              />
            </label>
            <label className="catalog-modal__field">
              <span>Tag</span>
              <input
                type="text"
                value={modalState.tag}
                onChange={(event) => updateModal({ tag: event.target.value })}
                placeholder={DEFAULT_RUN_TAG}
                disabled={modalState.busy}
              />
            </label>
            <div className="catalog-modal__full-image">Full image: {fullImage}</div>
            <div className="catalog-modal__env-header">
              <span>Environment variables</span>
              <button type="button" onClick={addEnvRow} disabled={modalState.busy}>
                Add variable
              </button>
            </div>
            <div className="catalog-modal__env-list">
              {modalState.envs.length === 0 && <div className="catalog-modal__env-empty">No environment variables yet.</div>}
              {modalState.envs.map((env) => (
                <div key={env.id} className="catalog-modal__env-row">
                  <input
                    type="text"
                    value={env.key}
                    onChange={(event) => updateEnvRow(env.id, 'key', event.target.value)}
                    placeholder="API_KEY"
                    disabled={modalState.busy}
                  />
                  <input
                    type="text"
                    value={env.value}
                    onChange={(event) => updateEnvRow(env.id, 'value', event.target.value)}
                    placeholder="value"
                    disabled={modalState.busy}
                  />
                  <button type="button" onClick={() => removeEnvRow(env.id)} disabled={modalState.busy}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
          {modalState.error && <div className="catalog-modal__error">{modalState.error}</div>}
          <div className="catalog-modal__footer">
            <button type="button" className="catalog-button catalog-button--ghost" onClick={closeModal} disabled={modalState.busy}>
              Cancel
            </button>
            <button
              type="button"
              className="catalog-button catalog-button--primary"
              onClick={handleModalSubmit}
              disabled={modalState.busy}
            >
              {modalState.busy ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>
      </div>
    );
  }, [modalState, addEnvRow, closeModal, handleModalSubmit, removeEnvRow, updateEnvRow, updateModal]);

  return (
    <div className="rdx-module">
      <header className="rdx-module__header rdx-module__header--stacked">
        <div className="engine-header-inline">
          <div className="engine-header-inline__title">
            <h1>Catalog</h1>
            <p>Discover and run MCP servers.</p>
          </div>
        </div>
      </header>
      <section className="rdx-module__section">
        <div className="catalog-controls">
          <label className="catalog-control">
            <span>Source</span>
            <select
              value={selectedSource?.id ?? ''}
              onChange={(event) => setSelectedSourceId(event.target.value)}
              disabled={sources.length <= 1}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {describeCatalogSource(source)}
                </option>
              ))}
            </select>
          </label>
          <label className="catalog-control catalog-control--grow">
            <span>Filter</span>
            <input
              type="search"
              placeholder="Search by name or description"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
            />
          </label>
        </div>
        {configLoading ? (
          <div className="catalog-status">Loading mcpo configuration…</div>
        ) : configError ? (
          <div className="catalog-alert catalog-alert--error">
            <span>Failed to load mcpo configuration: {configError}</span>
            <button type="button" onClick={loadMcpoConfig} disabled={configBusy}>
              Retry
            </button>
          </div>
        ) : null}
        {catalogLoading ? (
          <div className="catalog-loading" role="status" aria-live="polite">
            <span className="catalog-spinner" aria-hidden="true" />
            Loading MCP servers…
          </div>
        ) : catalogError ? (
          <div className="catalog-alert catalog-alert--error">{catalogError}</div>
        ) : filteredItems.length === 0 ? (
          <div className="catalog-placeholder">No catalog entries match the current filters.</div>
        ) : (
          <div className="catalog-grid">
            {filteredItems.map((item) => {
              const isInstalled = installedServers.has(item.serverId);
              const isRemoving = removingServerId === item.serverId;
              return (
                <article key={item.id} className="catalog-card">
                  <div className="catalog-card__header">
                    <div>
                      <h3 className="catalog-card__title">{item.displayName}</h3>
                      <p className="catalog-card__description">{item.description || 'No description provided.'}</p>
                    </div>
                    {isInstalled && <span className="catalog-card__badge">Installed</span>}
                  </div>
                  <dl className="catalog-card__meta">
                    <div>
                      <dt>Image</dt>
                      <dd>{item.image}</dd>
                    </div>
                    <div>
                      <dt>Updated</dt>
                      <dd>{formatDate(item.lastUpdated)}</dd>
                    </div>
                  </dl>
                  <div className="catalog-card__footer">
                    <div className="catalog-card__actions">
                      {isInstalled ? (
                        <button
                          type="button"
                          className="catalog-button catalog-button--danger"
                          onClick={() => handleRemoveServer(item)}
                          disabled={configBusy || isRemoving}
                        >
                          {isRemoving ? (
                            <>
                              <span className="catalog-spinner catalog-spinner--inline" aria-hidden="true" />
                              Removing…
                            </>
                          ) : (
                            'Remove'
                          )}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="catalog-button catalog-button--primary"
                          onClick={() => openModal(item)}
                          disabled={configBusy || !!configError}
                        >
                          Run
                        </button>
                      )}
                    </div>
                    <div className="catalog-card__links">
                      <a
                        href={`https://hub.docker.com/r/${item.image}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Learn more ↗
                      </a>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      {modalContent}
    </div>
  );
}

function formatDate(value?: string): string {
  if (!value) {
    return '—';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return dateFormatter.format(parsed);
}

function mapRepositoryToEntry(repo: DockerHubRepository): CatalogEntry | null {
  const name = repo.name?.trim();
  if (!name) {
    return null;
  }
  const namespace = repo.namespace?.trim() ?? '';
  const image = namespace ? `${namespace}/${name}` : name;
  const description = repo.description?.trim() ?? 'No description provided.';
  const categories = Array.isArray(repo.categories)
    ? repo.categories.map((item) => item?.name).filter((item): item is string => Boolean(item))
    : [];
  return {
    id: namespace ? `${namespace}/${name}` : name,
    serverId: name,
    displayName: name,
    description,
    image,
    lastUpdated: repo.last_updated,
    categories,
  };
}

async function fetchHttpCatalog(source: CatalogSourceDefinition, signal: AbortSignal): Promise<CatalogEntry[]> {
  const items: CatalogEntry[] = [];
  let nextUrl: string | null = source.url;
  const headers: Record<string, string> = {};
  if (source.key) {
    headers.Authorization = `Bearer ${source.key}`;
  }
  while (typeof nextUrl === 'string' && nextUrl) {
    const currentUrl: string = nextUrl;
    nextUrl = null;
    const response = await fetch(currentUrl, { signal, headers });
    if (!response.ok) {
      throw new Error(`Catalog request failed (${response.status})`);
    }
    const data = (await response.json()) as DockerHubResponse;
    const repositories = Array.isArray(data.results) ? data.results : [];
    repositories.forEach((repo) => {
      const entry = mapRepositoryToEntry(repo);
      if (entry) {
        items.push(entry);
      }
    });
    if (data.next) {
      nextUrl = resolveNextUrl(data.next, currentUrl);
    }
  }
  return items;
}

function resolveNextUrl(next: string, currentUrl: string): string {
  if (!next) {
    return '';
  }
  if (/^https?:/i.test(next)) {
    return next;
  }
  try {
    return new URL(next, currentUrl).toString();
  } catch {
    return next;
  }
}

function cloneMcpoConfig(config: McpoConfigObject): McpoConfigObject {
  const clone: McpoConfigObject = config && typeof config === 'object' ? JSON.parse(JSON.stringify(config)) : {};
  if (!clone.mcpServers || typeof clone.mcpServers !== 'object') {
    clone.mcpServers = {};
  }
  return clone;
}

function addServerToConfig(
  config: McpoConfigObject,
  item: CatalogEntry,
  image: string,
  tag: string,
  env: Record<string, string>,
): boolean {
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  const fullImage = `${image}:${tag}`;
  const envKeys = Object.keys(env);
  const args = ['run', '-i', '--rm'];
  envKeys.forEach((key) => {
    args.push('-e', key);
  });
  args.push(fullImage);
  const existing = config.mcpServers[item.serverId];
  const nextDefinition = {
    command: 'docker',
    args,
    env: envKeys.length ? env : undefined,
    info: {
      name: item.displayName,
      description: item.description,
    },
  };
  const serializedExisting = JSON.stringify(existing ?? {});
  const serializedNext = JSON.stringify(nextDefinition);
  config.mcpServers[item.serverId] = nextDefinition;
  return serializedExisting !== serializedNext;
}

function removeServerFromConfig(config: McpoConfigObject, serverId: string): boolean {
  if (!config.mcpServers || !config.mcpServers[serverId]) {
    return false;
  }
  delete config.mcpServers[serverId];
  return true;
}

function generateEnvId(): string {
  return `env-${Math.random().toString(36).slice(2, 9)}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
