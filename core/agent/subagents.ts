import {
  cloneCapabilities,
  createCustomExecutionProfile,
  getExecutionProfile,
  isExecutionCapabilitySubset,
  type BuiltInExecutionProfileId,
  type ExecutionCapabilities,
  type ExecutionProfile,
} from "./capabilities";
import {
  AgentDiagnosticsBuffer,
  type AgentDebugBundle,
} from "./diagnostics";
import type { AgentDurableContextOptions } from "./lifecycle";
import {
  runAgentLoop,
  type AgentLoopResult,
} from "./loop";
import type {
  AgentModelDriver,
  AgentModelInputItem,
  AgentModelToolDefinition,
  AgentToolExecutionContext,
  AgentToolExecutionOutcome,
  AgentToolExecutor,
} from "./model";
import {
  AgentSessionStore,
  type AgentSessionReplay,
} from "./persistence";
import type {
  AgentRunEvent,
  AgentToolCallItem,
  JsonObject,
  JsonValue,
} from "./protocol";
import { AgentKernel } from "./kernel";
import { AgentSession } from "./session";
import {
  AgentCapabilityDeniedError,
  AgentToolAuthorizationDeniedError,
  AgentToolNotFoundError,
} from "./tools";

export const AGENT_SUBAGENT_RELATION_SCHEMA_VERSION = 1 as const;

export interface AgentSubagentRelation {
  readonly schemaVersion: typeof AGENT_SUBAGENT_RELATION_SCHEMA_VERSION;
  readonly type: "subagent_relation";
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly requestedProfileId: string;
  readonly effectiveProfile: {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly capabilities: Readonly<ExecutionCapabilities>;
  };
  readonly createdAt: number;
}

export interface AgentSubagentRuntimeOptions {
  readonly rootDirectory: string;
  readonly kernel?: AgentKernel;
  readonly diagnostics?: AgentDiagnosticsBuffer;
}

interface AgentSubagentExecutionOptions {
  readonly driver: AgentModelDriver;
  readonly context: AgentDurableContextOptions;
  readonly tools?: readonly AgentModelToolDefinition[];
  readonly modelMetadata?: JsonObject;
  readonly maxIterations?: number;
  readonly onEvent?: (
    event: AgentRunEvent,
  ) => void | Promise<void>;
}

export interface RunAgentSubagentOptions
  extends AgentSubagentExecutionOptions {
  readonly parent: AgentSession;
  readonly input: readonly AgentModelInputItem[];
  readonly id?: string;
  readonly profile?:
    | BuiltInExecutionProfileId
    | Readonly<ExecutionProfile>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ResumeAgentSubagentOptions
  extends AgentSubagentExecutionOptions {
  readonly parent: AgentSession;
  readonly childSessionId: string;
}

export interface AgentSubagentRunResult {
  readonly child: AgentSession;
  readonly relation: AgentSubagentRelation;
  readonly result: AgentLoopResult;
  readonly resumed: boolean;
}

export class AgentSubagentRuntime {
  readonly kernel: AgentKernel;
  readonly diagnostics: AgentDiagnosticsBuffer;
  private readonly activeChildren = new Map<string, AgentSession>();

  constructor(private readonly options: AgentSubagentRuntimeOptions) {
    this.kernel = options.kernel ?? new AgentKernel();
    this.diagnostics =
      options.diagnostics ?? new AgentDiagnosticsBuffer();
  }

  getDebugBundle(
    childSessionId: string,
    version?: string,
  ): AgentDebugBundle {
    return this.diagnostics.buildDebugBundle({
      sessionId: childSessionId,
      ...(version ? { version } : {}),
    });
  }

  async run(
    options: RunAgentSubagentOptions,
  ): Promise<AgentSubagentRunResult> {
    options.parent.assertActive();

    const requestedProfile = resolveProfile(
      options.profile ?? options.parent.profile,
    );
    const child = await this.kernel.forkSession(
      options.parent,
      {
        id: options.id,
        profile: requestedProfile,
        metadata: options.metadata,
      },
    );

    if (child.id === options.parent.id) {
      child.close();
      throw new Error(
        "A nested agent session must have an id distinct from its parent",
      );
    }
    assertChildCapabilityInvariant(child, options.parent);

    const relation = createRelation(
      options.parent,
      child,
      requestedProfile.id,
    );

    return this.executeChild(
      child,
      relation,
      options.input,
      options,
      false,
      [relationToMetadata(relation)],
    );
  }

  async resume(
    options: ResumeAgentSubagentOptions,
  ): Promise<AgentSubagentRunResult> {
    options.parent.assertActive();

    const relation = await loadDurableAgentSubagentRelation(
      this.options.rootDirectory,
      options.childSessionId,
    );
    if (!relation) {
      throw new Error(
        `Durable subagent session "${options.childSessionId}" has no persisted parent/child relationship`,
      );
    }
    if (relation.parentSessionId !== options.parent.id) {
      throw new Error(
        `Durable subagent session "${options.childSessionId}" belongs to parent "${relation.parentSessionId}", not "${options.parent.id}"`,
      );
    }

    const persistedProfile = createCustomExecutionProfile(
      relation.effectiveProfile.id,
      relation.effectiveProfile.label,
      relation.effectiveProfile.description,
      cloneCapabilities(relation.effectiveProfile.capabilities),
    );
    const child = await this.kernel.forkSession(
      options.parent,
      {
        id: relation.childSessionId,
        profile: persistedProfile,
        metadata: {
          restoredFromDurableRelation: true,
        },
      },
    );
    assertChildCapabilityInvariant(child, options.parent);

    return this.executeChild(
      child,
      relation,
      [],
      options,
      true,
      undefined,
    );
  }

  getActiveChildren(
    parentSessionId?: string,
  ): readonly AgentSession[] {
    return [...this.activeChildren.values()].filter(
      (child) =>
        parentSessionId === undefined ||
        child.parentSessionId === parentSessionId,
    );
  }

  private async executeChild(
    child: AgentSession,
    relation: AgentSubagentRelation,
    input: readonly AgentModelInputItem[],
    options: AgentSubagentExecutionOptions,
    resumed: boolean,
    initialMetadata?: readonly JsonObject[],
  ): Promise<AgentSubagentRunResult> {
    if (this.activeChildren.has(child.id)) {
      child.close();
      throw new Error(
        `Subagent session "${child.id}" already has an active run`,
      );
    }

    this.activeChildren.set(child.id, child);
    let store: AgentSessionStore | undefined;
    try {
      store = await AgentSessionStore.open({
        rootDirectory: this.options.rootDirectory,
        sessionId: child.id,
      });

      const tools =
        options.tools ??
        describeAgentKernelTools(this.kernel);
      const result = await runAgentLoop({
        driver: options.driver,
        input,
        tools,
        toolExecutor: new AgentKernelToolExecutor(
          this.kernel,
          child,
        ),
        signal: child.signal,
        maxIterations: options.maxIterations,
        metadata: options.modelMetadata,
        onEvent: options.onEvent
          ? async (event) => options.onEvent?.(event)
          : undefined,
        diagnostics: this.diagnostics.sink,
        diagnosticContext: {
          sessionId: child.id,
          executionProfile: child.profile.id,
        },
        durability: {
          store,
          context: options.context,
          initialMetadata,
        },
      });

      return {
        child,
        relation,
        result,
        resumed,
      };
    } finally {
      this.activeChildren.delete(child.id);
      try {
        await store?.close();
      } finally {
        if (child.state === "active") {
          await this.kernel.closeSession(child);
        }
      }
    }
  }
}

export class AgentKernelToolExecutor implements AgentToolExecutor {
  constructor(
    private readonly kernel: AgentKernel,
    private readonly session: AgentSession,
  ) {}

  async execute(
    toolCall: AgentToolCallItem,
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecutionOutcome> {
    if (context.signal.aborted || this.session.signal.aborted) {
      throw new Error("Subagent tool execution was cancelled");
    }

    try {
      const output = await this.kernel.executeTool(
        this.session,
        toolCall.name,
        toolCall.input,
      );
      if (context.signal.aborted || this.session.signal.aborted) {
        throw new Error("Subagent tool execution was cancelled");
      }
      return {
        status: "success",
        output: toJsonValue(output),
      };
    } catch (error) {
      if (context.signal.aborted || this.session.signal.aborted) {
        throw error;
      }
      return {
        status: "failure",
        error: kernelToolError(error, toolCall),
      };
    }
  }
}

export function describeAgentKernelTools(
  kernel: AgentKernel,
): readonly AgentModelToolDefinition[] {
  return kernel.tools.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));
}

export async function loadDurableAgentSubagentRelation(
  rootDirectory: string,
  childSessionId: string,
): Promise<AgentSubagentRelation | undefined> {
  const store = await AgentSessionStore.open({
    rootDirectory,
    sessionId: childSessionId,
  });
  try {
    return getAgentSubagentRelation(await store.replay());
  } finally {
    await store.close();
  }
}

export function getAgentSubagentRelation(
  replay: Pick<AgentSessionReplay, "metadata">,
): AgentSubagentRelation | undefined {
  for (let index = replay.metadata.length - 1; index >= 0; index -= 1) {
    const relation = parseRelation(replay.metadata[index]);
    if (relation) {
      return relation;
    }
  }
  return undefined;
}

function resolveProfile(
  profile: BuiltInExecutionProfileId | Readonly<ExecutionProfile>,
): Readonly<ExecutionProfile> {
  return typeof profile === "string"
    ? getExecutionProfile(profile)
    : profile;
}

function createRelation(
  parent: AgentSession,
  child: AgentSession,
  requestedProfileId: string,
): AgentSubagentRelation {
  return {
    schemaVersion: AGENT_SUBAGENT_RELATION_SCHEMA_VERSION,
    type: "subagent_relation",
    parentSessionId: parent.id,
    childSessionId: child.id,
    requestedProfileId,
    effectiveProfile: {
      id: child.profile.id,
      label: child.profile.label,
      description: child.profile.description,
      capabilities: cloneCapabilities(child.capabilities),
    },
    createdAt: child.createdAt,
  };
}

function relationToMetadata(
  relation: AgentSubagentRelation,
): JsonObject {
  return {
    schemaVersion: relation.schemaVersion,
    type: relation.type,
    parentSessionId: relation.parentSessionId,
    childSessionId: relation.childSessionId,
    requestedProfileId: relation.requestedProfileId,
    effectiveProfile: {
      id: relation.effectiveProfile.id,
      label: relation.effectiveProfile.label,
      description: relation.effectiveProfile.description,
      capabilities: capabilitiesToJson(
        relation.effectiveProfile.capabilities,
      ),
    },
    createdAt: relation.createdAt,
  };
}

function capabilitiesToJson(
  capabilities: Readonly<ExecutionCapabilities>,
): JsonObject {
  return {
    filesystem: {
      read: capabilities.filesystem.read,
      write: capabilities.filesystem.write,
    },
    shell: capabilities.shell,
    network: capabilities.network,
    processControl: capabilities.processControl,
    backgroundJobs: capabilities.backgroundJobs,
    mcp: capabilities.mcp,
    subagents: capabilities.subagents,
    computerControl: capabilities.computerControl,
    approvalMode: capabilities.approvalMode,
  };
}

function parseRelation(
  value: JsonObject,
): AgentSubagentRelation | undefined {
  if (
    value.type !== "subagent_relation" ||
    value.schemaVersion !==
      AGENT_SUBAGENT_RELATION_SCHEMA_VERSION
  ) {
    return undefined;
  }

  if (
    typeof value.parentSessionId !== "string" ||
    !value.parentSessionId ||
    typeof value.childSessionId !== "string" ||
    !value.childSessionId ||
    typeof value.requestedProfileId !== "string" ||
    !value.requestedProfileId ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    throw new Error("Persisted subagent relationship metadata is invalid");
  }

  const profile = asObject(value.effectiveProfile);
  const capabilities = asObject(profile?.capabilities);
  const filesystem = asObject(capabilities?.filesystem);
  if (
    !profile ||
    typeof profile.id !== "string" ||
    !profile.id ||
    typeof profile.label !== "string" ||
    typeof profile.description !== "string" ||
    !capabilities ||
    !filesystem ||
    !isScope(filesystem.read, ["none", "workspace", "unrestricted"]) ||
    !isScope(filesystem.write, ["none", "workspace", "unrestricted"]) ||
    !isScope(capabilities.shell, ["none", "workspace", "unrestricted"]) ||
    !isScope(capabilities.network, ["none", "restricted", "full"]) ||
    typeof capabilities.processControl !== "boolean" ||
    typeof capabilities.backgroundJobs !== "boolean" ||
    typeof capabilities.mcp !== "boolean" ||
    typeof capabilities.subagents !== "boolean" ||
    typeof capabilities.computerControl !== "boolean" ||
    !isScope(capabilities.approvalMode, ["always", "policy", "never"])
  ) {
    throw new Error(
      "Persisted subagent effective profile metadata is invalid",
    );
  }

  return {
    schemaVersion: AGENT_SUBAGENT_RELATION_SCHEMA_VERSION,
    type: "subagent_relation",
    parentSessionId: value.parentSessionId,
    childSessionId: value.childSessionId,
    requestedProfileId: value.requestedProfileId,
    effectiveProfile: {
      id: profile.id,
      label: profile.label,
      description: profile.description,
      capabilities: {
        filesystem: {
          read: filesystem.read as ExecutionCapabilities["filesystem"]["read"],
          write: filesystem.write as ExecutionCapabilities["filesystem"]["write"],
        },
        shell: capabilities.shell as ExecutionCapabilities["shell"],
        network: capabilities.network as ExecutionCapabilities["network"],
        processControl: capabilities.processControl,
        backgroundJobs: capabilities.backgroundJobs,
        mcp: capabilities.mcp,
        subagents: capabilities.subagents,
        computerControl: capabilities.computerControl,
        approvalMode:
          capabilities.approvalMode as ExecutionCapabilities["approvalMode"],
      },
    },
    createdAt: value.createdAt,
  };
}

function assertChildCapabilityInvariant(
  child: AgentSession,
  parent: AgentSession,
): void {
  if (
    !isExecutionCapabilitySubset(
      child.capabilities,
      parent.capabilities,
    )
  ) {
    throw new Error(
      `Nested session "${child.id}" exceeded parent "${parent.id}" capabilities`,
    );
  }
}

function kernelToolError(
  error: unknown,
  toolCall: AgentToolCallItem,
) {
  const details: JsonObject = {
    itemId: toolCall.id,
    callId: toolCall.callId,
    toolName: toolCall.name,
  };

  if (error instanceof AgentCapabilityDeniedError) {
    return {
      code: "kernel_rejection",
      message: error.message,
      details: {
        ...details,
        missingCapabilities: [...error.missingCapabilities],
      },
    };
  }
  if (error instanceof AgentToolAuthorizationDeniedError) {
    return {
      code: error.code,
      message: error.message,
      details,
    };
  }
  if (error instanceof AgentToolNotFoundError) {
    return {
      code: "kernel_rejection",
      message: error.message,
      details,
    };
  }
  return {
    code: "tool_failure",
    message:
      error instanceof Error ? error.message : String(error),
    details,
  };
}

function toJsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error(
      "Subagent tool output is not JSON serializable",
    );
  }
  return JSON.parse(encoded) as JsonValue;
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

function isScope<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  );
}
