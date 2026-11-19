import { installUsherElements } from "./elements.js";

/**
 * The elements as a classic script, served at `{basePath}/elements.js` for
 * any backend (ADR 0009). From source it is the function's own text. The
 * build replaces this module with a minified copy of the same function
 * (scripts/postbuild.mjs, ADR 0010), and scripts/check-package.mjs runs the
 * result in a DOM before every release.
 */
export const ELEMENTS_SCRIPT = `/* Usher elements (ADR 0009) */\n(${installUsherElements.toString()})(window);\n`;
