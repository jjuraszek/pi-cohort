import { parseArgs } from "@earendil-works/pi-coding-agent";

export interface ForwardFlagsConfig {
  forwardParentFlags?: boolean;
}

// The child pi reads its argv with the same parseArgs, so whatever the parent's
// pi classified as an unknown (extension) flag is exactly what the child will.
// Values are re-emitted in `--name=value` form: pi reads `--lens -x` as `--lens`
// plus an unknown `-x` option, while `--lens=-x` keeps the value.
export function deriveForwardedFlags(argv: string[], config: ForwardFlagsConfig): string[] {
  if (config.forwardParentFlags === false) return [];
  const parsed = parseArgs(argv.slice(2));
  if (parsed.extensions !== undefined || parsed.noExtensions) return [];
  return [...parsed.unknownFlags].map(([name, value]) => (value === true ? `--${name}` : `--${name}=${value}`));
}
