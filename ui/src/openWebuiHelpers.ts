import { toast } from 'react-toastify';

export const OPEN_WEBUI_TOKEN_STORAGE_KEY = 'rdx.open-webui-token';

const reportedDebugMessages = new Set<string>();

export function reportOpenWebUIDebug(message: string) {
  const id = `openwebui-debug-${message}`;
  if (reportedDebugMessages.has(id)) {
    return;
  }
  reportedDebugMessages.add(id);
  toast.info(message, { toastId: id, autoClose: 15000 });
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
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) {
        // accessing key to catch quota errors
        window.localStorage.getItem(key);
      }
    }
  } catch (error) {
    reportOpenWebUIDebug(
      `Failed to enumerate localStorage keys: ${error instanceof Error ? error.message : String(error)}`,
    );
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
      if (parsed && typeof parsed === 'object') {
        if (typeof (parsed as any).token === 'string') {
          return (parsed as any).token;
        }
        if (typeof (parsed as any).access_token === 'string') {
          return (parsed as any).access_token;
        }
      }
      return raw;
    } catch (error) {
      reportOpenWebUIDebug(
        `Failed to parse token JSON; using raw string (${error instanceof Error ? error.message : String(error)})`,
      );
      return raw;
    }
  } catch (error) {
    reportOpenWebUIDebug(
      `Unexpected error while reading token: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
