import { registerHooks } from "node:module";

const relativeSpecifier = /^(?:\.\.?\/)/;
const explicitExtension = /\.[a-z0-9]+(?:[?#].*)?$/i;
const typescriptParent = /\.(?:[cm]?ts)(?:[?#].*)?$/i;
const recoverableResolutionErrors = new Set(["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT", "MODULE_NOT_FOUND"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parentUrl = typeof context.parentURL === "string" ? context.parentURL : "";
    const shouldResolveAsTypeScript =
      typescriptParent.test(parentUrl) &&
      !parentUrl.includes("/node_modules/") &&
      relativeSpecifier.test(specifier) &&
      !explicitExtension.test(specifier);

    if (shouldResolveAsTypeScript) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch (error) {
        if (!error || !recoverableResolutionErrors.has(error.code)) throw error;
      }
    }

    return nextResolve(specifier, context);
  }
});
