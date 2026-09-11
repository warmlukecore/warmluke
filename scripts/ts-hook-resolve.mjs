export async function resolve(specifier, context, next) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    try {
      return await next(specifier, context);
    } catch {
      return await next(`${specifier}.ts`, context);
    }
  }
  return next(specifier, context);
}
