/**
 * Register the .js → .ts loader hook for integration tests.
 *
 * Usage: node --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Source files use .js import extensions (TypeScript ESM convention) but
 * files on disk are .ts — the loader rewrites .js → .ts at resolve time.
 * Types are handled by node's built-in stripping (default since 23.6);
 * no source file uses transform-requiring features (parameter properties,
 * enums, namespaces).
 */

import { register } from "node:module";

register(new URL("./ts-loader.mjs", import.meta.url));
