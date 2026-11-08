import { parseArgs } from "@earendil-works/pi-coding-agent";

export interface ForwardFlagsConfig {
  forwardParentFlags?: boolean;
}

// Re-emit unknown flags as `--name=value` so the child's parseArgs preserves
// dash-prefixed values and cannot consume child flags after a bare core name.
// Booleans use `--name=true`; pi treats boolean extension flags as true in this form.
export function deriveForwardedFlags(argv: string[], config: ForwardFlagsConfig): string[] {
  if (config.forwardParentFlags === false) return [];
  const parsed = parseArgs(argv.slice(2));
  if (parsed.extensions !== undefined || parsed.noExtensions) return [];
  return [...parsed.unknownFlags].map(([name, value]) => `--${name}=${value}`);
}
