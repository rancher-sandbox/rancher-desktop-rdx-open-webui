import { createDockerDesktopClient } from '@docker/extension-api-client';

const ddClient = createDockerDesktopClient();

const EXTENSION_IDENTIFIER = 'rancher-desktop-rdx-open-webui';
const MCPO_FILE_NAME = 'config.json';
const MCPO_RELATIVE_PATH = `linux/mcpo/${MCPO_FILE_NAME}`;
const EXTENSION_IMAGE = ddClient.extension.image;
export const MCPO_BASE_URL = 'http://host.docker.internal:11600';

export const MCPO_CONFIG_STORAGE_KEY = 'rdx.mcpo-config-cache';

export interface ComposeDetails {
  projectName: string;
  composeFile: string;
  configDir: string;
  configPath: string;
}

interface McpoServerInfo {
  name?: string;
  description?: string;
}

interface RawMcpoServerDefinition {
  command?: string;
  args?: string[];
  info?: McpoServerInfo;
}

interface RawMcpoConfig {
  mcpServers?: Record<string, RawMcpoServerDefinition>;
}

export interface McpoServerDefinition {
  id: string;
  name: string;
  description: string;
  url: string;
}

interface ComposeEntry {
  Name?: string;
  ConfigFiles?: string;
}

function stripLastSegment(path: string): string {
  if (!path) {
    return '';
  }
  const updated = path.replace(/[\\/][^\\/]+$/, '');
  return updated === path ? '' : updated;
}

function parseComposeOutput(raw: string): ComposeEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === 'object') {
      return [parsed as ComposeEntry];
    }
  } catch {
    // fallback to multi-line parsing
  }
  const entries: ComposeEntry[] = [];
  trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      try {
        const parsed = JSON.parse(line);
        entries.push(parsed as ComposeEntry);
      } catch {
        // ignore malformed line
      }
    });
  return entries;
}

function normalizeConfigFiles(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

export function normalizeConfigText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

export function parseMcpoConfig(text: string): RawMcpoConfig {
  try {
    const parsed = JSON.parse(text) as RawMcpoConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function extractMcpoServers(configText: string): McpoServerDefinition[] {
  const parsed = parseMcpoConfig(configText);
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    return [];
  }
  return Object.entries(parsed.mcpServers)
    .map(([id, definition]): McpoServerDefinition | null => {
      if (!id) {
        return null;
      }
      const info = definition?.info ?? {};
      const name = typeof info.name === 'string' && info.name.trim() ? info.name.trim() : id;
      const description = typeof info.description === 'string' ? info.description : '';
      return {
        id,
        name,
        description,
        url: `${MCPO_BASE_URL}/${id}`,
      };
    })
    .filter((entry): entry is McpoServerDefinition => Boolean(entry));
}

export async function fetchComposeDetails(): Promise<ComposeDetails> {
  const { stdout } = await ddClient.docker.cli.exec('compose', ['ls', '--format', 'json']);
  const entries = parseComposeOutput(stdout ?? '');
  if (!entries.length) {
    throw new Error('No Docker Compose stacks found.');
  }
  const target = entries.find((entry) => {
    const name = entry.Name ?? '';
    const configFiles = entry.ConfigFiles ?? '';
    return name.includes(EXTENSION_IDENTIFIER) || configFiles.includes(EXTENSION_IDENTIFIER);
  });
  if (!target) {
    throw new Error('Unable to locate the Rancher Desktop MCP stack.');
  }
  const configFiles = normalizeConfigFiles(target.ConfigFiles);
  if (!configFiles.length) {
    throw new Error('Compose stack is missing config metadata.');
  }
  const composeFile = configFiles[0];
  const composeDirectory = stripLastSegment(composeFile);
  const separator = composeFile.includes('\\') ? '\\' : '/';
  const relativePath = MCPO_RELATIVE_PATH.replace(/\//g, separator);
  const configPath = composeDirectory ? `${composeDirectory}${separator}${relativePath}` : relativePath;
  const configDir = stripLastSegment(configPath);
  return {
    projectName: target.Name ?? 'mcpo',
    composeFile,
    configDir,
    configPath,
  };
}

async function runDocker(args: string[]) {
  const result = await ddClient.docker.cli.exec('run', args);
  if (result.stderr?.trim()) {
    console.debug('[docker run]', result.stderr.trim());
  }
  return result.stdout ?? '';
}

export async function readConfigFromHost(configDir: string): Promise<string> {
  if (!configDir) {
    throw new Error('Unknown mcpo configuration directory.');
  }
  const volumeArg = `${configDir}:/rdx-mcpo`;
  const targetPath = `/rdx-mcpo/${MCPO_FILE_NAME}`;
  const stdout = await runDocker([
    '--rm',
    '-v',
    volumeArg,
    '--entrypoint',
    'cat',
    EXTENSION_IMAGE,
    targetPath,
  ]);
  return stdout;
}

function encodeBase64(content: string): string {
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return window.btoa(unescape(encodeURIComponent(content)));
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(content, 'utf-8').toString('base64');
  }
  throw new Error('Base64 encoding is not supported in this environment.');
}

export async function writeConfigToHost(configDir: string, content: string) {
  if (!configDir) {
    throw new Error('Unknown mcpo configuration directory.');
  }
  const encoded = encodeBase64(content);
  const volumeArg = `${configDir}:/rdx-mcpo`;
  const shellCommand = `printf '%s' '${encoded}' | base64 -d >/rdx-mcpo/${MCPO_FILE_NAME}`;
  await runDocker([
    '--rm',
    '-v',
    volumeArg,
    '--entrypoint',
    'sh',
    EXTENSION_IMAGE,
    '-c',
    shellCommand,
  ]);
}

export async function restartMcpoService(projectName: string, composeFile: string) {
  await ddClient.docker.cli.exec('compose', ['-f', composeFile, '-p', projectName, 'restart', 'mcpo']);
}

export function readStoredMcpoConfig(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    return window.localStorage.getItem(MCPO_CONFIG_STORAGE_KEY);
  } catch (error) {
    console.warn('[mcp-config] Failed to read cached config', error);
    return null;
  }
}

export function writeStoredMcpoConfig(value: string | null) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    if (value === null) {
      window.localStorage.removeItem(MCPO_CONFIG_STORAGE_KEY);
    } else {
      window.localStorage.setItem(MCPO_CONFIG_STORAGE_KEY, value);
    }
  } catch (error) {
    console.warn('[mcp-config] Failed to persist cached config', error);
  }
}
