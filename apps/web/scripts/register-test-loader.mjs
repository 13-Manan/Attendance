// Registered via `node --import ./scripts/register-test-loader.mjs --test ...`
// (see package.json's "test" script). Node's native `node --test` runner
// strips TypeScript types but does not resolve the two things Next.js's
// bundler normally resolves for us: extensionless relative imports
// (`./service`, not `./service.ts`) and the `@/*` -> `src/*` path alias from
// tsconfig.json. This hook bridges both gaps so existing source files can be
// imported by tests completely unmodified: no new dependency, no change to
// any import statement anywhere in the codebase.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath, dirname } from "node:path";

const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];
const HAS_EXTENSION = /\.[a-zA-Z0-9]+$/;
const SRC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "src");

function withResolvedExtension(urlWithoutExtension) {
  if (HAS_EXTENSION.test(urlWithoutExtension)) return urlWithoutExtension;
  for (const ext of EXTENSIONS) {
    if (existsSync(fileURLToPath(urlWithoutExtension + ext))) {
      return urlWithoutExtension + ext;
    }
  }
  return urlWithoutExtension;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const aliasedUrl = pathToFileURL(resolvePath(SRC_DIR, specifier.slice(2))).href;
      return nextResolve(withResolvedExtension(aliasedUrl), context);
    }

    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const candidateUrl = new URL(specifier, context.parentURL).href;
      const resolved = withResolvedExtension(candidateUrl);
      if (resolved !== candidateUrl) {
        // withResolvedExtension returned an absolute URL; nextResolve wants
        // a specifier it can re-resolve against the same parentURL.
        return nextResolve(resolved, context);
      }
    }

    return nextResolve(specifier, context);
  },
});
