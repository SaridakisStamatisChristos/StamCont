import type { JsonObject, JsonValue } from "./protocol";

export const AGENT_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;

export type AgentDiagnosticEventType =
  | "session.start"
  | "session.end"
  | "recovery"
  | "model.start"
  | "model.end"
  | "tool.start"
  | "tool.end"
  | "context_budget"
  | "compaction"
  | "cancellation"
  | "failure";

export interface AgentProviderDiagnosticIdentity {
  readonly driver: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface AgentDiagnosticEvent {
  readonly schemaVersion: typeof AGENT_DIAGNOSTICS_SCHEMA_VERSION;
  readonly type: AgentDiagnosticEventType;
  readonly timestamp: number;
  readonly sessionId?: string;
  readonly executionProfile?: string;
  readonly provider?: AgentProviderDiagnosticIdentity;
  readonly responseId?: string;
  readonly eventId?: string;
  readonly itemId?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly providerRequestId?: string;
  readonly durationMs?: number;
  readonly details?: JsonObject;
}

export type AgentDiagnosticsSink = (
  event: Readonly<AgentDiagnosticEvent>,
) => void | Promise<void>;

export interface AgentDiagnosticContext {
  readonly sessionId?: string;
  readonly executionProfile?: string;
  readonly provider?: AgentProviderDiagnosticIdentity;
}

export interface AgentDebugBundle {
  readonly schemaVersion: typeof AGENT_DIAGNOSTICS_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly version: string;
  readonly platform: {
    readonly platform: string;
    readonly arch: string;
    readonly node: string;
  };
  readonly runtimeFlags: {
    readonly ci: boolean;
    readonly nodeEnv?: string;
  };
  readonly sessionId?: string;
  readonly executionProfiles: readonly string[];
  readonly providers: readonly AgentProviderDiagnosticIdentity[];
  readonly summary: {
    readonly eventCount: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly compactions: number;
    readonly cancellations: number;
    readonly failures: number;
    readonly recoveryEvents: number;
  };
  readonly events: readonly AgentDiagnosticEvent[];
}

export interface BuildAgentDebugBundleOptions {
  readonly sessionId?: string;
  readonly version?: string;
}

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|private[_-]?key|opaque|encrypted|reasoning|content|prompt|input|output)/i;

export async function emitAgentDiagnostic(
  sink: AgentDiagnosticsSink | undefined,
  event: Omit<AgentDiagnosticEvent, "schemaVersion" | "details"> & {
    readonly details?: JsonObject;
  },
): Promise<void> {
  if (!sink) {
    return;
  }

  const safeEvent: AgentDiagnosticEvent = {
    ...event,
    schemaVersion: AGENT_DIAGNOSTICS_SCHEMA_VERSION,
    ...(event.details
      ? { details: redactAgentDiagnosticObject(event.details) }
      : {}),
  };

  try {
    await sink(safeEvent);
  } catch {
    // Diagnostics are deliberately non-authoritative. Observability must
    // never alter agent execution, durability, cancellation, or tool policy.
  }
}

export function redactAgentDiagnosticObject(
  value: Readonly<Record<string, unknown>>,
): JsonObject {
  const redacted: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : redactValue(entry, new WeakSet<object>());
  }
  return redacted;
}

export function extractProviderRequestId(
  metadata: JsonObject | undefined,
): string | undefined {
  if (!metadata) {
    return undefined;
  }

  for (const key of [
    "requestId",
    "request_id",
    "providerRequestId",
    "provider_request_id",
  ]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  const continueMetadata = asObject(metadata.continue);
  for (const key of ["requestId", "request_id", "responseId"]) {
    const value = continueMetadata?.[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export function describeAgentModelDriver(
  driver: unknown,
): AgentProviderDiagnosticIdentity {
  const record = asObject(driver);
  const capabilities = asObject(record?.capabilities);
  return {
    driver:
      typeof record?.constructor === "function" &&
      typeof (record.constructor as { name?: unknown }).name === "string"
        ? (record.constructor as { name: string }).name
        : "AgentModelDriver",
    ...(typeof capabilities?.providerName === "string"
      ? { provider: capabilities.providerName }
      : {}),
    ...(typeof capabilities?.model === "string"
      ? { model: capabilities.model }
      : {}),
  };
}

export class AgentDiagnosticsBuffer {
  private readonly events: AgentDiagnosticEvent[] = [];

  constructor(readonly maxEvents = 2_000) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
      throw new RangeError(
        "AgentDiagnosticsBuffer maxEvents must be a positive safe integer",
      );
    }
  }

  readonly sink: AgentDiagnosticsSink = (event) => {
    this.events.push(cloneDiagnosticEvent(event));
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  };

  list(sessionId?: string): readonly AgentDiagnosticEvent[] {
    return this.events
      .filter(
        (event) =>
          sessionId === undefined || event.sessionId === sessionId,
      )
      .map(cloneDiagnosticEvent);
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) {
      this.events.length = 0;
      return;
    }
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index].sessionId === sessionId) {
        this.events.splice(index, 1);
      }
    }
  }

  buildDebugBundle(
    options: BuildAgentDebugBundleOptions = {},
  ): AgentDebugBundle {
    return buildAgentDebugBundle(this.list(options.sessionId), options);
  }
}

export function buildAgentDebugBundle(
  sourceEvents: readonly AgentDiagnosticEvent[],
  options: BuildAgentDebugBundleOptions = {},
): AgentDebugBundle {
  const events = sourceEvents
    .filter(
      (event) =>
        options.sessionId === undefined ||
        event.sessionId === options.sessionId,
    )
    .map((event) => ({
      ...cloneDiagnosticEvent(event),
      ...(event.details
        ? { details: redactAgentDiagnosticObject(event.details) }
        : {}),
    }));

  const profiles = uniqueStrings(
    events.map((event) => event.executionProfile),
  );
  const providers = uniqueProviders(
    events.flatMap((event) => (event.provider ? [event.provider] : [])),
  );

  return {
    schemaVersion: AGENT_DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    version: options.version ?? "unknown",
    platform: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    runtimeFlags: {
      ci: Boolean(process.env.CI),
      ...(process.env.NODE_ENV
        ? { nodeEnv: process.env.NODE_ENV }
        : {}),
    },
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    executionProfiles: profiles,
    providers,
    summary: {
      eventCount: events.length,
      modelCalls: events.filter((event) => event.type === "model.end").length,
      toolCalls: events.filter((event) => event.type === "tool.end").length,
      compactions: events.filter((event) => event.type === "compaction").length,
      cancellations: events.filter(
        (event) => event.type === "cancellation",
      ).length,
      failures: events.filter((event) => event.type === "failure").length,
      recoveryEvents: events.filter((event) => event.type === "recovery").length,
    },
    events,
  };
}

export function serializeAgentDebugBundle(
  bundle: AgentDebugBundle,
): string {
  return JSON.stringify(bundle, null, 2) + "\n";
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen));
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const output: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(record)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : redactValue(entry, seen);
  }
  return output;
}

function cloneDiagnosticEvent(
  event: Readonly<AgentDiagnosticEvent>,
): AgentDiagnosticEvent {
  return {
    ...event,
    ...(event.provider ? { provider: { ...event.provider } } : {}),
    ...(event.details
      ? { details: JSON.parse(JSON.stringify(event.details)) as JsonObject }
      : {}),
  };
}

function uniqueStrings(
  values: readonly (string | undefined)[],
): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function uniqueProviders(
  values: readonly AgentProviderDiagnosticIdentity[],
): readonly AgentProviderDiagnosticIdentity[] {
  const seen = new Set<string>();
  const output: AgentProviderDiagnosticIdentity[] = [];
  for (const value of values) {
    const key = [value.driver, value.provider ?? "", value.model ?? ""].join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push({ ...value });
  }
  return output;
}

function asObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
