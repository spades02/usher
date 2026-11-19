/**
 * Schema interop via the Standard Schema + Standard JSON Schema specs
 * (https://standardschema.dev). Any library implementing both works with
 * Usher: Zod >= 4.2, ArkType, Valibot (via `toStandardJsonSchema`), or a
 * hand-written schema.
 *
 * The interfaces are copied rather than imported, as the spec recommends,
 * so Usher's public API depends on no schema library or SDK types.
 */

interface StandardTypedProps<Input, Output> {
  readonly version: 1;
  readonly vendor: string;
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

interface StandardValidateProps<Input, Output> extends StandardTypedProps<Input, Output> {
  readonly validate: (
    value: unknown,
  ) => StandardResult<Output> | Promise<StandardResult<Output>>;
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

interface StandardJsonSchemaProps<Input, Output> extends StandardTypedProps<Input, Output> {
  readonly jsonSchema: {
    readonly input: (options: { target: string }) => Record<string, unknown>;
    readonly output: (options: { target: string }) => Record<string, unknown>;
  };
}

/** A schema Usher can both validate with and describe to agents as JSON Schema. */
export interface UsherSchema<Input = unknown, Output = Input> {
  readonly "~standard": StandardValidateProps<Input, Output> &
    StandardJsonSchemaProps<Input, Output>;
}

export type InferInput<S extends UsherSchema> = NonNullable<S["~standard"]["types"]>["input"];
export type InferOutput<S extends UsherSchema> = NonNullable<S["~standard"]["types"]>["output"];

export function toJsonSchema(
  schema: UsherSchema,
  io: "input" | "output",
): Record<string, unknown> {
  return schema["~standard"].jsonSchema[io]({ target: "draft-2020-12" });
}

export function isUsherSchema(value: unknown): value is UsherSchema {
  const std = (value as UsherSchema | undefined)?.["~standard"];
  return (
    typeof std === "object" &&
    std !== null &&
    typeof std.validate === "function" &&
    typeof std.jsonSchema?.input === "function"
  );
}
