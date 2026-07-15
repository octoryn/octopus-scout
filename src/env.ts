import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function isDisabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
  const idx = body.indexOf("=");
  if (idx <= 0) return undefined;
  const key = body.slice(0, idx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
  let value = body.slice(idx + 1);
  if (!value.trimStart().startsWith('"') && !value.trimStart().startsWith("'")) {
    value = value.replace(/\s+#.*$/, "");
  }
  return [key, unquote(value)];
}

/**
 * Load a dotenv-style file into `env` without overriding explicit process vars.
 *
 * Defaults to `${cwd}/.env`. Override with `OCTORYN_SCOUT_ENV_FILE=/path/file`,
 * or disable with `OCTORYN_SCOUT_DISABLE_DOTENV=1`.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  if (isDisabled(env.OCTORYN_SCOUT_DISABLE_DOTENV)) return undefined;
  const configured = env.OCTORYN_SCOUT_ENV_FILE;
  const file = configured ? resolve(cwd, configured) : resolve(cwd, ".env");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (env[key] === undefined) env[key] = value;
  }
  return file;
}

loadEnvFile();
