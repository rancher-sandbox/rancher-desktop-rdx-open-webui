import { ReactNode, useEffect, useMemo, useState } from 'react';
import './SidebarLayout.css';

export interface ModuleDefinition {
  id: string;
  title: string;
  description?: string;
  badge?: string;
  icon?: ReactNode;
  children?: ModuleDefinition[];
}

type SidebarLayoutProps = {
  modules: ModuleDefinition[];
  activeModuleId: string;
  onSelectModule: (moduleId: string) => void;
  children: ReactNode;
  contentVariant?: 'default' | 'flush';
};

export default function SidebarLayout({
  modules,
  activeModuleId,
  onSelectModule,
  children,
  contentVariant = 'default',
}: SidebarLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);

  const categoryIds = useMemo(() => {
    const ids = new Set<string>();
    const collect = (items: ModuleDefinition[]) => {
      items.forEach((item) => {
        if (item.children?.length) {
          ids.add(item.id);
          collect(item.children);
        }
      });
    };
    collect(modules);
    return ids;
  }, [modules]);

  const parentByChild = useMemo(() => {
    const map = new Map<string, string>();
    const traverse = (items: ModuleDefinition[], parentId?: string) => {
      items.forEach((item) => {
        if (parentId) {
          map.set(item.id, parentId);
        }
        if (item.children?.length) {
          traverse(item.children, item.id);
        }
      });
    };
    traverse(modules);
    return map;
  }, [modules]);

  const activeAncestors = useMemo(() => {
    const ancestors = new Set<string>();
    let current = activeModuleId;
    while (current) {
      const parent = parentByChild.get(current);
      if (!parent) {
        break;
      }
      ancestors.add(parent);
      current = parent;
    }
    return ancestors;
  }, [activeModuleId, parentByChild]);

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    () => new Set(categoryIds),
  );

  useEffect(() => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      categoryIds.forEach((id) => {
        if (!next.has(id)) {
          next.add(id);
        }
      });
      return next;
    });
  }, [categoryIds]);

  useEffect(() => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      activeAncestors.forEach((id) => next.add(id));
      return next;
    });
  }, [activeAncestors]);

  const computeBadge = (module: ModuleDefinition) =>
    module.badge ??
    module.title
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0]?.toUpperCase())
      .join('')
      .slice(0, 2);

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  const renderModule = (module: ModuleDefinition, depth = 0): ReactNode => {
    const hasChildren = !!module.children?.length;
    if (hasChildren) {
      const isExpanded = expandedCategories.has(module.id);
      const isAncestorActive = activeAncestors.has(module.id);
      return (
        <div
          key={module.id}
          className={`rdx-sidebar__group${isAncestorActive ? ' is-active' : ''}`}
        >
          <button
            type="button"
            className={`rdx-sidebar__group-button${isExpanded ? ' is-expanded' : ''}`}
            onClick={() => toggleCategory(module.id)}
            aria-expanded={isExpanded}
            aria-controls={`rdx-subnav-${module.id}`}
          >
            <span className="rdx-sidebar__group-caret" aria-hidden="true">
              {isExpanded ? '▾' : '▸'}
            </span>
            <span className="rdx-sidebar__group-label">{module.title}</span>
          </button>
          <div
            id={`rdx-subnav-${module.id}`}
            className={`rdx-sidebar__subnav${isExpanded ? ' is-open' : ''}`}
            aria-hidden={!isExpanded}
          >
            {module.children!.map((child) => renderModule(child, depth + 1))}
          </div>
        </div>
      );
    }

    const isActive = module.id === activeModuleId;
    const badge = computeBadge(module);
    const iconContent = module.icon ?? badge;
    const paddingLeft = collapsed ? undefined : `${0.8 + depth * 0.65}rem`;

    return (
      <button
        key={module.id}
        type="button"
        className={`rdx-sidebar__item${isActive ? ' is-active' : ''}`}
        onClick={() => onSelectModule(module.id)}
        title={module.title}
        style={paddingLeft ? { paddingLeft } : undefined}
      >
        <span className="rdx-sidebar__item-icon" aria-hidden="true">
          {typeof iconContent === 'string' ? (
            <span className="rdx-sidebar__item-initials">{iconContent}</span>
          ) : (
            iconContent
          )}
        </span>
        <span className="rdx-sidebar__item-content">
          <span className="rdx-sidebar__item-label">{module.title}</span>
          {module.description && (
            <span className="rdx-sidebar__item-description">{module.description}</span>
          )}
        </span>
      </button>
    );
  };

  const shellClassName = `rdx-shell${collapsed ? ' rdx-shell--collapsed' : ''}`;
  const contentClassName = `rdx-content${contentVariant === 'flush' ? ' rdx-content--flush' : ''}`;

  return (
    <div className={shellClassName}>
      <aside className="rdx-sidebar" aria-label="Module navigation">
        <div className="rdx-sidebar__header">
          <span className="rdx-sidebar__title">AI Workbench</span>
          <button
            type="button"
            className="rdx-sidebar__collapse"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
          >
            <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
          </button>
        </div>
        <nav className="rdx-sidebar__nav">
          {modules.map((module) => renderModule(module))}
        </nav>
      </aside>
      <main className={contentClassName} role="region">
        {children}
      </main>
    </div>
  );
}
