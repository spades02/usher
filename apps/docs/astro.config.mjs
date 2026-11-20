// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// The docs site (ADR 0011). Static output: host it anywhere.
export default defineConfig({
  telemetry: false,
  site: "https://usher.dev",
  integrations: [
    starlight({
      title: "Usher",
      description: "Let your customers bring their own AI agent.",
      lastUpdated: false,
      sidebar: [
        { label: "Start here", items: ["getting-started", "concepts/how-it-works", "concepts/security"] },
        {
          label: "Guides",
          items: [
            "guides/tools",
            "guides/frameworks",
            "guides/storage",
            "guides/plugins",
            "guides/customer-ui",
            "guides/operator-console",
            "guides/standalone",
            "guides/deployment",
          ],
        },
        { label: "For your customers", items: ["customers/connect-an-assistant"] },
        {
          label: "Reference",
          items: ["reference/api", { label: "Decisions (ADRs)", items: [{ autogenerate: { directory: "decisions" } }] }],
        },
      ],
    }),
  ],
});
