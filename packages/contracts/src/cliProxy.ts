import * as Schema from "effect/Schema";
import { PositiveInt } from "./baseSchemas.ts";

export const CliProxyStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("stopped") }),
  Schema.Struct({ state: Schema.Literal("starting") }),
  Schema.Struct({ state: Schema.Literal("running"), pid: PositiveInt }),
  Schema.Struct({ state: Schema.Literal("stopping") }),
  Schema.Struct({ state: Schema.Literal("failed"), message: Schema.String }),
]);
export type CliProxyStatus = typeof CliProxyStatus.Type;

export const CliProxyAction = Schema.Literals(["start", "stop", "restart"]);
export type CliProxyAction = typeof CliProxyAction.Type;

export class CliProxyManagementError extends Schema.TaggedError<CliProxyManagementError>()(
  "CliProxyManagementError",
  { message: Schema.String },
) {}
