import { registerHooks } from "node:module";

const relativeSpecifier = /^(?:\.\.?\/)/;
const explicitExtension = /\.[a-z0-9]+(?:[?#].*)?$/i;
const recoverableResolutionErrors = new Set(["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (relativeSpecifier.test(specifier) && !explicitExtension.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch (error) {
        if (!error || !recoverableResolutionErrors.has(error.code)) throw error;
      }
    }

    return nextResolve(specifier, context);
  }
});
