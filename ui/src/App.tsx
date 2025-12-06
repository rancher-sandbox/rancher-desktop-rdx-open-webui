import { ReactNode, useEffect, useMemo, useState } from 'react';
import { createDockerDesktopClient } from '@docker/extension-api-client';
import { toast } from 'react-toastify';
import WebpageFrame from './WebpageFrame';
import InstallView from './InstallView';
import LoadingView from './LoadingView';
import ToastNotification from './ToastNotification';
import SidebarLayout, { ModuleDefinition } from './SidebarLayout';
import PlaygroundModule from './PlaygroundModule';
import ObservabilityModule from './ObservabilityModule';
import McpCatalogModule from './McpCatalogModule';
import McpConfigurationModule from './McpConfigurationModule';
import SettingsModule from './SettingsModule';
import ModelsModule from './ModelsModule';
import { syncMcpoWithOpenWebui } from './mcpoSync';
import {
  fetchComposeDetails,
  normalizeConfigText,
  readConfigFromHost,
  readStoredMcpoConfig,
  restartMcpoService,
  writeConfigToHost,
} from './mcpoConfig';
import { ensureOpenAiProxyConnection } from './openAiConnections';

const ddClient = createDockerDesktopClient();

type ModuleId =
  | 'playground'
  | 'observability'
  | 'mcp-catalog'
  | 'mcp-configuration'
  | 'models'
  | 'settings';

const flushContentModules = new Set<ModuleId>(['playground', 'observability']);

const iconColorProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const icons: Record<string, ReactNode> = {
  playground: (
    <svg {...iconColorProps}>
      <path d="M9.5 2.75h5" />
      <path d="M9 2.75v3.04l-5.32 9.24A3.25 3.25 0 006.56 19h10.88a3.25 3.25 0 002.88-4.97L15 5.79V2.75" />
      <path d="M7.25 14.25h9.5" />
      <path d="M9 9.75h6" />
    </svg>
  ),
  observability: (
    <svg {...iconColorProps}>
      <path d="M12 5.5a6.5 6.5 0 016.45 5.5A6.5 6.5 0 0112 16.5a6.5 6.5 0 01-6.45-5.5A6.5 6.5 0 0112 5.5z" />
      <circle cx="12" cy="11" r="2.2" />
      <path d="M6.5 19.5l2.2-3" strokeWidth={1.2} />
      <path d="M17.5 19.5l-2.2-3" strokeWidth={1.2} />
    </svg>
  ),
  catalog: (
    <svg {...iconColorProps}>
      <rect x={4} y={4} width={6.5} height={6.5} rx={1.2} fill="currentColor" stroke="none" />
      <rect x={13.5} y={4} width={6.5} height={6.5} rx={1.2} fill="currentColor" stroke="none" />
      <rect x={4} y={13.5} width={6.5} height={6.5} rx={1.2} fill="currentColor" stroke="none" />
      <rect x={13.5} y={13.5} width={6.5} height={6.5} rx={1.2} fill="currentColor" stroke="none" />
    </svg>
  ),
  configuration: (
    <svg {...iconColorProps}>
      <path d="M8 4H6a2 2 0 00-2 2v3a2 2 0 01-2 2 2 2 0 012 2v3a2 2 0 002 2h2" />
      <path d="M16 4h2a2 2 0 012 2v3a2 2 0 002 2 2 2 0 00-2 2v3a2 2 0 01-2 2h-2" />
    </svg>
  ),
  models: (
    <svg {...iconColorProps}>
      <path d="M4.5 7.5l7.5-4 7.5 4" />
      <path d="M4.5 7.5v8L12 20l7.5-4.5v-8" />
      <path d="M4.5 15.5l7.5-4.5 7.5 4.5" />
    </svg>
  ),
  settings: (
    <svg {...iconColorProps}>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 2.75v1.7" />
      <path d="M12 19.55v1.7" />
      <path d="M4.45 7.1l1.2 1.2" />
      <path d="M18.35 16.9l1.2 1.2" />
      <path d="M2.75 12h1.7" />
      <path d="M19.55 12h1.7" />
      <path d="M4.45 16.9l1.2-1.2" />
      <path d="M18.35 7.1l1.2-1.2" />
    </svg>
  ),
};

const moduleDefinitions: ModuleDefinition[] = [
  {
    id: 'models',
    title: 'Models',
    description: 'Pull & Run LLMs',
    icon: icons.models,
  },
  {
    id: 'mcp',
    title: 'MCP',
    badge: 'M',
    children: [
      {
        id: 'mcp-catalog',
        title: 'Catalog',
        description: 'Discover & Run MCPs',
        icon: icons.catalog,
      },
      {
        id: 'mcp-configuration',
        title: 'Configuration',
        description: 'MCP Proxy configuration',
        icon: icons.configuration,
      },
    ],
  },
  {
    id: 'observability',
    title: 'Observability',
    description: 'Powered by OTEL',
    icon: icons.observability,
  },
  {
    id: 'playground',
    title: 'Playground',
    description: 'Powered by Open WebUI',
    icon: icons.playground,
  },
  {
    id: 'settings',
    title: 'Settings',
    description: 'Extension preferences',
    icon: icons.settings,
  },
];

export function App() {
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [started, setStarted] = useState(false);
  const [activeModule, setActiveModule] = useState<ModuleId>('playground');

  const executable = `installer${ddClient.host.platform === 'win32' ? '.exe' : ''}`;

  async function runInstaller(...args: string[]) {
    const { host } = ddClient.extension;
    if (!host) {
      throw new Error(`Extension API does not have host`);
    }
    return await host.cli.exec(executable, args);
  }

  useEffect(() => {
    (async () => {
      try {
        const { stdout, stderr } = await runInstaller('--mode=check');
        stderr.trim() && console.error(stderr.trimEnd());
        console.debug(`Installation check: ${stdout.trim()}`);
        if (stdout.trim() === 'true') {
          setInstalled(true);
        }
        setChecked(true);
      } catch (ex) {
        console.error(ex);
        setError(`${ex}`);
      }
    })();
  }, []);

  function install() {
    (async () => {
      try {
        console.log(`Installing ollama to...`);
        setInstalling(true);
        const { stdout, stderr } = await runInstaller('--mode=install');
        stderr.trim() && console.error(stderr.trimEnd());
        stdout.trim() && console.debug(stdout.trimEnd());
        setInstalled(true);
      } catch (ex) {
        console.error(ex);
        setError(`${ex}`);
      }
    })();
  }

  useEffect(() => {
    (async () => {
      try {
        if (installed) {
          const { stdout, stderr } = await runInstaller('--mode=start');
          stderr.trim() && console.error(stderr.trimEnd());
          stdout.trim() && console.debug(stdout.trimEnd());
          setStarted(true);
        }
      } catch (ex) {
        console.error(ex);
        setError(`${ex}`);
      }
    })();
  }, [installed]);

  useEffect(() => {
    if (!started) {
      setActiveModule('models');
    }
  }, [started]);

  useEffect(() => {
    if (!started) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cached = readStoredMcpoConfig();
        const normalizedCached = cached ? normalizeConfigText(cached) : '';
        const details = await fetchComposeDetails();
        if (cancelled) {
          return;
        }
        const current = await readConfigFromHost(details.configDir);
        if (cancelled) {
          return;
        }
        const normalizedCurrent = normalizeConfigText(current);
        let finalConfig = current;
        if (cached && normalizedCached && normalizedCached !== normalizedCurrent) {
          await writeConfigToHost(details.configDir, cached);
          if (cancelled) {
            return;
          }
          await restartMcpoService(details.projectName, details.composeFile);
          finalConfig = cached;
        }
        if (cancelled) {
          return;
        }
        await syncMcpoWithOpenWebui(finalConfig);
      } catch (error) {
        console.error('[mcp-config] Failed to sync configuration on startup', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [started]);

  useEffect(() => {
    if (!started) {
      return;
    }
    ensureOpenAiProxyConnection().catch((error) => {
      console.error('[openai-config] Failed to ensure OpenAI proxy connection', error);
    });
  }, [started]);

  const moduleMap = useMemo<Record<ModuleId, JSX.Element>>(
    () => ({
      playground: <PlaygroundModule />,
      observability: <ObservabilityModule />,
      'mcp-catalog': <McpCatalogModule />,
      'mcp-configuration': <McpConfigurationModule />,
      models: <ModelsModule />,
      settings: <SettingsModule />,
    }),
    [],
  );

  let content;

  if (error) {
    content = <div className="error">{error}</div>;
  } else if (!installed && !installing && checked) {
    content = <InstallView install={install} />;
  } else if (!started) {
    content = <LoadingView />;
  } else {
    const activeContent = moduleMap[activeModule] ?? moduleMap.playground;
    content = (
      <SidebarLayout
        modules={moduleDefinitions}
        activeModuleId={activeModule}
        onSelectModule={(moduleId) => setActiveModule(moduleId as ModuleId)}
        contentVariant={flushContentModules.has(activeModule) ? 'flush' : 'default'}
      >
        {activeContent}
      </SidebarLayout>
    );
  }

  return (
    <>
      {content}
      <ToastNotification />
    </>
  );
}
