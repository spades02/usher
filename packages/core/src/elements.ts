/**
 * `import "@usherjs/core/elements"` registers <usher-connect> and <usher-agents>
 * in the browser (ADR 0009). Safe to import during server rendering: it does
 * nothing without a `window`.
 */
import { installUsherElements } from "./ui/elements.js";

export { installUsherElements };

const win = (globalThis as { window?: unknown }).window;
if (win) installUsherElements(win);
