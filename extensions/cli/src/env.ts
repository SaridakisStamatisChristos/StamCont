import * as os from "os";
import * as path from "path";

import dotenv from "dotenv";

dotenv.config();

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

/**
 * Resolve a StamCont-prefixed environment variable with a Continue-era
 * compatibility fallback. A non-empty STAMCONT_* value always wins.
 */
export function readIdentityEnv(
  source: EnvironmentSource,
  stamcontName: string,
  continueName: string,
): string | undefined {
  const stamcontValue = source[stamcontName];
  if (stamcontValue !== undefined && stamcontValue !== "") {
    return stamcontValue;
  }
  return source[continueName];
}

export interface ResolvedCliEnvironment {
  apiBase: string;
  stamcontHome: string;
  /**
   * Compatibility alias retained while downstream code migrates terminology.
   * This resolves to exactly the same directory as stamcontHome.
   */
  continueHome: string;
}

export function resolveCliEnvironment(
  source: EnvironmentSource = process.env,
  homeDir: string = os.homedir(),
): ResolvedCliEnvironment {
  const apiBase =
    readIdentityEnv(source, "STAMCONT_API_BASE", "CONTINUE_API_BASE") ??
    "https://api.continue.dev/";

  // Keep ~/.continue as the default in PR19 so existing auth, config, indexes,
  // migrations, and sessions cannot be stranded by the identity migration.
  const globalDir =
    readIdentityEnv(source, "STAMCONT_GLOBAL_DIR", "CONTINUE_GLOBAL_DIR") ||
    path.join(homeDir, ".continue");

  return {
    apiBase,
    stamcontHome: globalDir,
    continueHome: globalDir,
  };
}

export const env = resolveCliEnvironment();
