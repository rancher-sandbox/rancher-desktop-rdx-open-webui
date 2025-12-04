import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { toast } from 'react-toastify';
import { readStoredOpenWebUIToken, writeStoredOpenWebUIToken } from './openWebuiHelpers';
import {
  CatalogSourceDefinition,
  createCatalogSource,
  DEFAULT_CATALOG_SOURCE,
  getEffectiveCatalogSources,
  writeStoredCatalogSources,
} from './catalogSources';
import './ModuleContent.css';
import './SettingsModule.css';

export default function SettingsModule() {
  const initialToken = typeof window === 'undefined' ? '' : readStoredOpenWebUIToken() ?? '';
  const [storedToken, setStoredToken] = useState(initialToken);
  const [tokenValue, setTokenValue] = useState(initialToken);
  const [isMasked, setIsMasked] = useState(initialToken.length > 0);
  const initialSources = useMemo(
    () => (typeof window === 'undefined' ? [DEFAULT_CATALOG_SOURCE] : getEffectiveCatalogSources()),
    [],
  );
  const [storedSources, setStoredSources] = useState<CatalogSourceDefinition[]>(initialSources);
  const [sourceDrafts, setSourceDrafts] = useState<EditableCatalogSource[]>(() =>
    prepareEditableSources(initialSources),
  );
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});

  const displayValue = useMemo(() => {
    if (!isMasked) {
      return tokenValue;
    }
    if (!tokenValue) {
      return '';
    }
    const maskLength = Math.min(Math.max(tokenValue.length, 4), 12);
    return '•'.repeat(maskLength);
  }, [isMasked, tokenValue]);

  const hasChanges = tokenValue !== storedToken;
  const catalogSourcesChanged = useMemo(
    () => !areCatalogSourceListsEqual(storedSources, sourceDrafts),
    [sourceDrafts, storedSources],
  );

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setTokenValue(event.target.value);
  }, []);

  const handleToggleMask = useCallback(() => {
    if (!tokenValue) {
      return;
    }
    setIsMasked((prev) => !prev);
  }, [tokenValue]);

  const handleSave = useCallback(() => {
    const trimmed = tokenValue.trim();
    if (!trimmed) {
      writeStoredOpenWebUIToken(null);
      setStoredToken('');
      setTokenValue('');
      setIsMasked(false);
      toast.success('Open WebUI token cleared.');
      return;
    }
    writeStoredOpenWebUIToken(trimmed);
    setStoredToken(trimmed);
    setTokenValue(trimmed);
    setIsMasked(true);
    toast.success('Open WebUI token saved.');
  }, [tokenValue]);

  const handleClear = useCallback(() => {
    writeStoredOpenWebUIToken(null);
    setStoredToken('');
    setTokenValue('');
    setIsMasked(false);
    toast.success('Open WebUI token cleared.');
  }, []);

  const updateSourceDraft = useCallback((id: string, updates: Partial<EditableCatalogSource>) => {
    setSourceDrafts((prev) =>
      prev.map((source) => {
        if (source.id !== id) {
          return source;
        }
        if (source.isDefault) {
          const { url, type, ...rest } = updates;
          return { ...source, ...rest };
        }
        return { ...source, ...updates };
      }),
    );
  }, []);

  const clearSourceError = useCallback((id: string) => {
    setSourceErrors((prev) => {
      if (!prev[id]) {
        return prev;
      }
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const handleSourceTypeChange = useCallback((id: string, value: string) => {
    updateSourceDraft(id, { type: value === 'registry' ? 'registry' : 'http' });
    clearSourceError(id);
  }, [clearSourceError, updateSourceDraft]);

  const handleSourceUrlChange = useCallback((id: string, value: string) => {
    updateSourceDraft(id, { url: value });
    clearSourceError(id);
  }, [clearSourceError, updateSourceDraft]);

  const handleSourceKeyChange = useCallback((id: string, value: string) => {
    updateSourceDraft(id, { key: value });
  }, [updateSourceDraft]);

  const handleToggleSourceKeyVisibility = useCallback((id: string) => {
    setSourceDrafts((prev) =>
      prev.map((source) => {
        if (source.id !== id) {
          return source;
        }
        return { ...source, showKey: !source.showKey };
      }),
    );
  }, []);

  const handleAddSource = useCallback(() => {
    setSourceDrafts((prev) => [...prev, { ...createCatalogSource(), showKey: false }]);
  }, []);

  const handleRemoveSource = useCallback((id: string) => {
    if (id === DEFAULT_CATALOG_SOURCE.id) {
      return;
    }
    setSourceDrafts((prev) => prev.filter((source) => source.id !== id));
    setSourceErrors((prev) => {
      if (!prev[id]) {
        return prev;
      }
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const handleResetSources = useCallback(() => {
    setSourceDrafts(prepareEditableSources(storedSources));
    setSourceErrors({});
  }, [storedSources]);

  const handleSaveSources = useCallback(() => {
    const errors = validateCatalogSources(sourceDrafts);
    if (Object.keys(errors).length) {
      setSourceErrors(errors);
      toast.error('Resolve catalog source errors before saving.');
      return;
    }
    const sanitized = sourceDrafts.map((source) => ({
      id: source.id,
      url: source.url.trim(),
      type: source.type,
      key: source.key?.trim() ?? '',
    }));
    const nextSources = writeStoredCatalogSources(sanitized);
    setStoredSources(nextSources);
    setSourceDrafts(prepareEditableSources(nextSources));
    setSourceErrors({});
    toast.success('Catalog sources saved.');
  }, [sourceDrafts]);

  return (
    <div className="rdx-module">
      <header className="rdx-module__header">
        <h1>Settings</h1>
      </header>
      <section className="rdx-module__section">
        <h2>Open WebUI Token</h2>
        <p className="settings-description">
          Provide the bearer token from your Open WebUI session (Playground). The token is stored in localStorage so the Models page can access the Open WebUI configuration APIs.
        </p>
        <div className="settings-card">
          <div className="settings-token-field">
            <div className="settings-token-label">
              <span>Bearer token</span>
              <button
                type="button"
                className="settings-button settings-button--ghost"
                onClick={handleToggleMask}
                disabled={!tokenValue}
              >
                {isMasked ? 'Show token' : 'Hide token'}
              </button>
            </div>
            <textarea
              value={displayValue}
              onChange={handleChange}
              readOnly={isMasked}
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
              aria-label="Open WebUI token"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="settings-token-actions">
            <button type="button" className="settings-button settings-button--ghost" onClick={handleClear}>
              Clear
            </button>
            <button
              type="button"
              className="settings-button settings-button--primary"
              onClick={handleSave}
              disabled={!hasChanges}
            >
              Save
            </button>
          </div>
        </div>
      </section>
      <section className="rdx-module__section">
        <h2>MCP Catalog Sources</h2>
        <p className="settings-description settings-description--multiline">
          Configure catalog endpoints. Keys remain in your browser storage and never leave your machine.
        </p>
        <div className="settings-card settings-card--sources">
          <div className="settings-sources-list">
            {sourceDrafts.map((source) => (
              <div
                key={source.id}
                className={`settings-source${source.isDefault ? ' settings-source--default' : ''}`}
              >
                <div className="settings-source__header">
                  <div className="settings-source__title-group">
                    <span className="settings-source__title">
                      {source.isDefault ? 'Default source' : 'Custom source'}
                    </span>
                    <span className="settings-source__subtitle">
                      {source.label ?? (source.url || 'Pending configuration')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="settings-button settings-button--ghost"
                    onClick={() => handleRemoveSource(source.id)}
                    disabled={source.isDefault}
                  >
                    Remove
                  </button>
                </div>
                <div className="settings-source__row">
                  <label className="settings-source__field">
                    <span>Type</span>
                    <select
                      value={source.type}
                      onChange={(event) => handleSourceTypeChange(source.id, event.target.value)}
                      disabled={source.isDefault}
                    >
                      <option value="http">HTTP</option>
                      <option value="registry">Registry</option>
                    </select>
                  </label>
                  <label className="settings-source__field settings-source__field--grow">
                    <span>Source URL</span>
                    <input
                      type="text"
                      value={source.url}
                      onChange={(event) => handleSourceUrlChange(source.id, event.target.value)}
                      placeholder={source.type === 'registry' ? 'registry.example.com/namespace' : 'https://example.com/api'}
                      disabled={source.isDefault}
                    />
                  </label>
                </div>
                <div className="settings-source__row">
                  <label className="settings-source__field settings-source__field--grow">
                    <span>Access key (optional)</span>
                    <div className="settings-source__key-control">
                      <input
                        type={source.showKey ? 'text' : 'password'}
                        value={source.key}
                        onChange={(event) => handleSourceKeyChange(source.id, event.target.value)}
                        placeholder="sk_example"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="settings-button settings-button--ghost"
                        onClick={() => handleToggleSourceKeyVisibility(source.id)}
                        disabled={!source.key}
                      >
                        {source.showKey ? 'Hide' : 'Show'} key
                      </button>
                    </div>
                    <span className="settings-helper">Stored privately in localStorage.</span>
                  </label>
                </div>
                {sourceErrors[source.id] && (
                  <div className="settings-source__error">{sourceErrors[source.id]}</div>
                )}
              </div>
            ))}
          </div>
          <div className="settings-sources-actions">
            <button type="button" className="settings-button settings-button--ghost" onClick={handleAddSource}>
              Add source
            </button>
            <div className="settings-token-actions">
              <button
                type="button"
                className="settings-button settings-button--ghost"
                onClick={handleResetSources}
                disabled={!catalogSourcesChanged}
              >
                Revert
              </button>
              <button
                type="button"
                className="settings-button settings-button--primary"
                onClick={handleSaveSources}
                disabled={!catalogSourcesChanged}
              >
                Save
              </button>
            </div>
            <p className="settings-helper">
              Registry sources are stored for future releases. The Catalog currently fetches HTTP sources only.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

type EditableCatalogSource = CatalogSourceDefinition & { showKey?: boolean };

function prepareEditableSources(sources: CatalogSourceDefinition[]): EditableCatalogSource[] {
  return sources.map((source) => ({
    ...source,
    key: source.key ?? '',
    showKey: false,
  }));
}

function areCatalogSourceListsEqual(
  stored: CatalogSourceDefinition[],
  drafts: EditableCatalogSource[],
): boolean {
  if (stored.length !== drafts.length) {
    return false;
  }
  for (let index = 0; index < stored.length; index += 1) {
    const a = normalizeSource(stored[index]);
    const b = normalizeSource(drafts[index]);
    if (a.id !== b.id || a.url !== b.url || a.type !== b.type || a.key !== b.key) {
      return false;
    }
  }
  return true;
}

function normalizeSource(source: CatalogSourceDefinition): {
  id: string;
  url: string;
  type: string;
  key: string;
} {
  const url = source.id === DEFAULT_CATALOG_SOURCE.id ? DEFAULT_CATALOG_SOURCE.url : source.url.trim();
  return {
    id: source.id,
    url,
    type: source.type,
    key: (source.key ?? '').trim(),
  };
}

function validateCatalogSources(sources: EditableCatalogSource[]): Record<string, string> {
  const errors: Record<string, string> = {};
  sources.forEach((source) => {
    const trimmedUrl = source.url.trim();
    if (!trimmedUrl) {
      errors[source.id] = 'Source URL is required.';
      return;
    }
    if (source.type === 'http' && !/^https?:\/\//i.test(trimmedUrl)) {
      errors[source.id] = 'HTTP sources must start with http:// or https://';
    }
  });
  return errors;
}
