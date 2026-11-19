import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createUsher, defineTool, type UsherSchema } from "../src/index.js";
import { authOptions, connectAgent } from "./helpers.js";

const app = { name: "x", version: "1" };
const common = { ...authOptions, app };
const base = {
  name: "ok_tool",
  description: "Does a thing.",
  input: z.object({}),
  effect: "read" as const,
  handler: () => null,
};

describe("startup validation", () => {
  it.each([
    ["duplicate names", [base, base], /duplicate name/],
    ["invalid names", [{ ...base, name: "has spaces" }], /invalid name/],
    ["missing description", [{ ...base, description: "  " }], /description is required/],
    ["missing effect", [{ ...base, effect: undefined as never }], /effect must be one of/],
    ["non-object input", [{ ...base, input: z.string() as never }], /must describe an object/],
    ["non-object output", [{ ...base, output: z.array(z.string()) as never }], /must describe an object/],
    ["non-schema input", [{ ...base, input: { foo: "bar" } as never }], /not a supported schema/],
  ])("rejects %s", (_label, tools, message) => {
    expect(() => createUsher({ ...common, tools })).toThrow(message);
  });
});

describe("schema-library neutrality", () => {
  /**
   * A schema hand-written against the Standard Schema + Standard JSON Schema
   * specs, standing in for Valibot / ArkType / any compliant library.
   */
  const handRolled: UsherSchema<{ city: string }> = {
    "~standard": {
      version: 1,
      vendor: "hand-rolled",
      validate: (value) =>
        typeof value === "object" && value !== null && typeof (value as any).city === "string"
          ? { value: value as { city: string } }
          : { issues: [{ message: "city must be a string" }] },
      jsonSchema: {
        input: () => ({
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        }),
        output: () => ({
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        }),
      },
    },
  };

  const usher = createUsher({
    ...common,
    tools: [
      defineTool({
        name: "weather",
        description: "Weather for a city.",
        input: handRolled,
        effect: "read",
        // `city` is typed as string, inferred from the hand-rolled schema.
        handler: ({ city }) => ({ city, forecast: "sunny" }),
      }),
    ],
  });

  it("serves a tool whose schema comes from a non-Zod library", async () => {
    const client = await connectAgent(usher);
    const { tools } = await client.listTools();
    expect(tools[0]?.inputSchema.required).toEqual(["city"]);

    const result = await client.callTool({ name: "weather", arguments: { city: "Lahore" } });
    expect(result.structuredContent).toEqual({ city: "Lahore", forecast: "sunny" });
    await client.close();
  });
});

describe("type inference", () => {
  it("types handler input and enforces output shape at compile time", () => {
    defineTool({
      name: "typed",
      description: "Type-level test.",
      input: z.object({ qty: z.number().int() }),
      output: z.object({ total: z.number() }),
      effect: "write",
      handler: ({ qty }) => {
        const n: number = qty;
        // @ts-expect-error - `qty` is a number, not a string
        const s: string = qty;
        void s;
        return { total: n * 2 };
      },
    });

    defineTool({
      name: "typed_bad_output",
      description: "Type-level test.",
      input: z.object({}),
      output: z.object({ total: z.number() }),
      effect: "read",
      // @ts-expect-error - handler must return { total: number }
      handler: () => ({ total: "lots" }),
    });
    expect(true).toBe(true);
  });
});
