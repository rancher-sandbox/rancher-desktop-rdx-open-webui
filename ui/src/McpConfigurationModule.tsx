import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { toast } from 'react-toastify';
import './ModuleContent.css';
import './McpConfigurationModule.css';
import {
  fetchComposeDetails,
  readConfigFromHost,
  readStoredMcpoConfig,
  restartMcpoService,
  writeConfigToHost,
  writeStoredMcpoConfig,
} from './mcpoConfig';
import { syncMcpoWithOpenWebui } from './mcpoSync';
import type { ComposeDetails } from './mcpoConfig';

export default function McpConfigurationModule() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [composeDetails, setComposeDetails] = useState<ComposeDetails | null>(null);
  const initialStoredConfig = useMemo(() => readStoredMcpoConfig() ?? '', []);
  const [configText, setConfigText] = useState(initialStoredConfig);
  const [savedText, setSavedText] = useState(initialStoredConfig);
  const [busy, setBusy] = useState(false);

  const hasChanges = configText !== savedText;

  const loadConfiguration = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const details = await fetchComposeDetails();
      const text = await readConfigFromHost(details.configDir);
      setComposeDetails(details);
      setConfigText(text);
      setSavedText(text);
      writeStoredMcpoConfig(text);
      void syncMcpoWithOpenWebui(text);
    } catch (cause) {
      const message = formatError(cause);
      console.error('[mcp-config] load failed', message);
      setError(message);
      setComposeDetails(null);
      setConfigText('');
      setSavedText('');
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
    try {
      const parsed = JSON.parse(configText);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Configuration must be a JSON object.');
      }
    } catch (cause) {
      toast.error(`Invalid JSON: ${cause instanceof Error ? cause.message : cause}`);
      return;
    }
    setBusy(true);
    try {
      await writeConfigToHost(composeDetails.configDir, configText);
      await restartMcpoService(composeDetails.projectName, composeDetails.composeFile);
      setSavedText(configText);
      writeStoredMcpoConfig(configText);
      toast.success('mcpo configuration updated and service restarted.');
      void syncMcpoWithOpenWebui(configText);
    } catch (cause) {
      toast.error(`Failed to update configuration: ${formatError(cause)}`);
    } finally {
      setBusy(false);
    }
  }, [composeDetails, configText]);

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
    </div>
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
