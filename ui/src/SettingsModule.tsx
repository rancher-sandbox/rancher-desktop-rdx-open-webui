import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { toast } from 'react-toastify';
import { readStoredOpenWebUIToken, writeStoredOpenWebUIToken } from './ModelsModule';
import './ModuleContent.css';
import './SettingsModule.css';

export default function SettingsModule() {
  const initialToken = typeof window === 'undefined' ? '' : readStoredOpenWebUIToken() ?? '';
  const [storedToken, setStoredToken] = useState(initialToken);
  const [tokenValue, setTokenValue] = useState(initialToken);
  const [isMasked, setIsMasked] = useState(initialToken.length > 0);

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
    </div>
  );
}
