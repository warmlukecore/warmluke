import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

// The app's two import styles, neither of which plain Node resolves:
// TypeScript writes "./types" for "./types.ts", and Next rewrites "@/x"
// to "src/x". Handling both here is why a script can import src/lib
// directly and test it.
const SRC = pathToFileURL(resolvePath(process.cwd(), "src") + "/").href;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const url = SRC + specifier.slice(2);
    try {
      return await next(url, context);
    } catch {
      return await next(`${url}.ts`, context);
    }
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    try {
      return await next(specifier, context);
    } catch {
      return await next(`${specifier}.ts`, context);
    }
  }
  return next(specifier, context);
}
