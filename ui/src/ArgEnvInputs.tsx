import './ArgEnvInputs.css';

export interface ArgRow {
  id: string;
  value: string;
}

export interface EnvRow {
  id: string;
  key: string;
  value: string;
}

export function createArgRow(value = ''): ArgRow {
  return { id: `arg-${Math.random().toString(36).slice(2, 9)}`, value };
}

export function createEnvRow(): EnvRow {
  return { id: `env-${Math.random().toString(36).slice(2, 9)}`, key: '', value: '' };
}

interface ArgEnvInputsProps {
  args?: ArgRow[];
  envs?: EnvRow[];
  disabled?: boolean;
  onChangeArgs?: (rows: ArgRow[]) => void;
  onChangeEnvs?: (rows: EnvRow[]) => void;
  showArgs?: boolean;
  showEnvs?: boolean;
  argsLabel?: string;
  envsLabel?: string;
  argsEmptyLabel?: string;
  envsEmptyLabel?: string;
  addArgLabel?: string;
  addEnvLabel?: string;
}

export function ArgEnvInputs({
  args = [],
  envs = [],
  disabled = false,
  onChangeArgs,
  onChangeEnvs,
  showArgs = true,
  showEnvs = true,
  argsLabel = 'Arguments',
  envsLabel = 'Environment variables',
  argsEmptyLabel = 'No arguments yet.',
  envsEmptyLabel = 'No environment variables yet.',
  addArgLabel = 'Add argument',
  addEnvLabel = 'Add variable',
}: ArgEnvInputsProps) {
  const handleAddArg = () => onChangeArgs?.([...args, createArgRow()]);
  const handleRemoveArg = (rowId: string) => onChangeArgs?.(args.filter((row) => row.id !== rowId));
  const handleUpdateArg = (rowId: string, value: string) =>
    onChangeArgs?.(args.map((row) => (row.id === rowId ? { ...row, value } : row)));

  const handleAddEnv = () => onChangeEnvs?.([...envs, createEnvRow()]);
  const handleRemoveEnv = (rowId: string) => onChangeEnvs?.(envs.filter((row) => row.id !== rowId));
  const handleUpdateEnv = (rowId: string, field: 'key' | 'value', value: string) =>
    onChangeEnvs?.(envs.map((row) => (row.id === rowId ? { ...row, [field]: value } : row)));

  return (
    <div className="arg-env-inputs">
      {showArgs && (
        <div className="arg-env-section">
          <div className="arg-env-header">
            <span>{argsLabel}</span>
            <button type="button" onClick={handleAddArg} disabled={disabled || !onChangeArgs}>
              {addArgLabel}
            </button>
          </div>
          <div className="arg-env-list">
            {args.length === 0 && <div className="arg-env-empty">{argsEmptyLabel}</div>}
            {args.map((arg) => (
              <div key={arg.id} className="arg-env-row arg-env-row--args">
                <input
                  type="text"
                  value={arg.value}
                  onChange={(event) => handleUpdateArg(arg.id, event.target.value)}
                  placeholder="--arg"
                  disabled={disabled || !onChangeArgs}
                />
                <button
                  type="button"
                  onClick={() => handleRemoveArg(arg.id)}
                  disabled={disabled || !onChangeArgs}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {showEnvs && (
        <div className="arg-env-section">
          <div className="arg-env-header">
            <span>{envsLabel}</span>
            <button type="button" onClick={handleAddEnv} disabled={disabled || !onChangeEnvs}>
              {addEnvLabel}
            </button>
          </div>
          <div className="arg-env-list">
            {envs.length === 0 && <div className="arg-env-empty">{envsEmptyLabel}</div>}
            {envs.map((env) => (
              <div key={env.id} className="arg-env-row arg-env-row--env">
                <input
                  type="text"
                  value={env.key}
                  onChange={(event) => handleUpdateEnv(env.id, 'key', event.target.value)}
                  placeholder="API_KEY"
                  disabled={disabled || !onChangeEnvs}
                />
                <input
                  type="text"
                  value={env.value}
                  onChange={(event) => handleUpdateEnv(env.id, 'value', event.target.value)}
                  placeholder="value"
                  disabled={disabled || !onChangeEnvs}
                />
                <button
                  type="button"
                  onClick={() => handleRemoveEnv(env.id)}
                  disabled={disabled || !onChangeEnvs}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function argsFromRows(rows: ArgRow[]): string[] {
  return rows.map((row) => row.value.trim()).filter(Boolean);
}

export function envFromRows(rows: EnvRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  rows.forEach((row) => {
    const key = row.key.trim();
    if (key) {
      env[key] = row.value;
    }
  });
  return env;
}
