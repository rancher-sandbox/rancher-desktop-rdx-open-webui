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
} from './mcpoConfig';
import { syncMcpoWithOpenWebui } from './mcpoSync';
import type { ComposeDetails } from './mcpoConfig';

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
