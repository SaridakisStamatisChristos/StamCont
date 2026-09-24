export type FilesystemScope = "none" | "workspace" | "unrestricted";
export type ShellScope = "none" | "workspace" | "unrestricted";
export type NetworkScope = "none" | "restricted" | "full";
export type ApprovalMode = "always" | "policy" | "never";

export interface ExecutionCapabilities {
  filesystem: Readonly<{
    read: FilesystemScope;
    write: FilesystemScope;
  }>;
  shell: ShellScope;
  network: NetworkScope;
  processControl: boolean;
  backgroundJobs: boolean;
  mcp: boolean;
  subagents: boolean;
  computerControl: boolean;
  approvalMode: ApprovalMode;
}

export interface ExecutionProfile {
  id: string;
  label: string;
  description: string;
  capabilities: Readonly<ExecutionCapabilities>;
}

export interface CapabilityRequirement {
  filesystemRead?: FilesystemScope;
  filesystemWrite?: FilesystemScope;
  shell?: ShellScope;
  network?: NetworkScope;
  processControl?: boolean;
  backgroundJobs?: boolean;
  mcp?: boolean;
  subagents?: boolean;
  computerControl?: boolean;
}

const filesystemRank: Record<FilesystemScope, number> = {
  none: 0,
  workspace: 1,
  unrestricted: 2,
};

const shellRank: Record<ShellScope, number> = {
  none: 0,
  workspace: 1,
  unrestricted: 2,
};

const networkRank: Record<NetworkScope, number> = {
  none: 0,
  restricted: 1,
  full: 2,
};

const approvalPrivilegeRank: Record<ApprovalMode, number> = {
  always: 0,
  policy: 1,
  never: 2,
};

export function freezeCapabilities(
  value: ExecutionCapabilities,
): Readonly<ExecutionCapabilities> {
  return Object.freeze({
    ...value,
    filesystem: Object.freeze({ ...value.filesystem }),
  });
}

export function cloneCapabilities(
  value: Readonly<ExecutionCapabilities>,
): ExecutionCapabilities {
  return {
    ...value,
    filesystem: { ...value.filesystem },
  };
}

export function intersectExecutionCapabilities(
  parent: Readonly<ExecutionCapabilities>,
  requested: Readonly<ExecutionCapabilities>,
): Readonly<ExecutionCapabilities> {
  const filesystemRead =
    filesystemRank[parent.filesystem.read] <=
    filesystemRank[requested.filesystem.read]
      ? parent.filesystem.read
      : requested.filesystem.read;
  const filesystemWrite =
    filesystemRank[parent.filesystem.write] <=
    filesystemRank[requested.filesystem.write]
      ? parent.filesystem.write
      : requested.filesystem.write;
  const shell =
    shellRank[parent.shell] <= shellRank[requested.shell]
      ? parent.shell
      : requested.shell;
  const network =
    networkRank[parent.network] <= networkRank[requested.network]
      ? parent.network
      : requested.network;
  const approvalMode =
    approvalPrivilegeRank[parent.approvalMode] <=
    approvalPrivilegeRank[requested.approvalMode]
      ? parent.approvalMode
      : requested.approvalMode;

  return freezeCapabilities({
    filesystem: {
      read: filesystemRead,
      write: filesystemWrite,
    },
    shell,
    network,
    processControl:
      parent.processControl && requested.processControl,
    backgroundJobs:
      parent.backgroundJobs && requested.backgroundJobs,
    mcp: parent.mcp && requested.mcp,
    subagents: parent.subagents && requested.subagents,
    computerControl:
      parent.computerControl && requested.computerControl,
    approvalMode,
  });
}

export function isExecutionCapabilitySubset(
  candidate: Readonly<ExecutionCapabilities>,
  ceiling: Readonly<ExecutionCapabilities>,
): boolean {
  return (
    filesystemRank[candidate.filesystem.read] <=
      filesystemRank[ceiling.filesystem.read] &&
    filesystemRank[candidate.filesystem.write] <=
      filesystemRank[ceiling.filesystem.write] &&
    shellRank[candidate.shell] <= shellRank[ceiling.shell] &&
    networkRank[candidate.network] <= networkRank[ceiling.network] &&
    (!candidate.processControl || ceiling.processControl) &&
    (!candidate.backgroundJobs || ceiling.backgroundJobs) &&
    (!candidate.mcp || ceiling.mcp) &&
    (!candidate.subagents || ceiling.subagents) &&
    (!candidate.computerControl || ceiling.computerControl) &&
    approvalPrivilegeRank[candidate.approvalMode] <=
      approvalPrivilegeRank[ceiling.approvalMode]
  );
}

export function intersectExecutionProfiles(
  parent: Readonly<ExecutionProfile>,
  requested: Readonly<ExecutionProfile>,
): Readonly<ExecutionProfile> {
  const capabilities = intersectExecutionCapabilities(
    parent.capabilities,
    requested.capabilities,
  );

  if (capabilitiesEqual(capabilities, requested.capabilities)) {
    return requested;
  }
  if (capabilitiesEqual(capabilities, parent.capabilities)) {
    return parent;
  }

  return defineProfile({
    id: `nested:${parent.id}&${requested.id}`,
    label: `${requested.label} (nested)`,
    description:
      `Nested execution bounded by parent profile "${parent.id}" and requested profile "${requested.id}".`,
    capabilities: cloneCapabilities(capabilities),
  });
}

function capabilitiesEqual(
  left: Readonly<ExecutionCapabilities>,
  right: Readonly<ExecutionCapabilities>,
): boolean {
  return (
    left.filesystem.read === right.filesystem.read &&
    left.filesystem.write === right.filesystem.write &&
    left.shell === right.shell &&
    left.network === right.network &&
    left.processControl === right.processControl &&
    left.backgroundJobs === right.backgroundJobs &&
    left.mcp === right.mcp &&
    left.subagents === right.subagents &&
    left.computerControl === right.computerControl &&
    left.approvalMode === right.approvalMode
  );
}

function defineProfile(
  profile: Omit<ExecutionProfile, "capabilities"> & {
    capabilities: ExecutionCapabilities;
  },
): Readonly<ExecutionProfile> {
  return Object.freeze({
    ...profile,
    capabilities: freezeCapabilities(profile.capabilities),
  });
}

export const EXECUTION_PROFILES = Object.freeze({
  plan: defineProfile({
    id: "plan",
    label: "Plan",
    description:
      "Workspace inspection and planning with no filesystem writes. Shell access remains available inside the workspace.",
    capabilities: {
      filesystem: { read: "workspace", write: "none" },
      shell: "workspace",
      network: "restricted",
      processControl: false,
      backgroundJobs: false,
      mcp: true,
      subagents: true,
      computerControl: false,
      approvalMode: "always",
    },
  }),
  interactive: defineProfile({
    id: "interactive",
    label: "Interactive",
    description:
      "Normal coding-agent operation inside the workspace with policy-driven approvals.",
    capabilities: {
      filesystem: { read: "workspace", write: "workspace" },
      shell: "workspace",
      network: "restricted",
      processControl: true,
      backgroundJobs: true,
      mcp: true,
      subagents: true,
      computerControl: false,
      approvalMode: "policy",
    },
  }),
  full_access: defineProfile({
    id: "full_access",
    label: "Full Access",
    description:
      "Unrestricted local execution, filesystem, network, process, MCP, subagent, background-job, and computer-control capabilities without per-command approval.",
    capabilities: {
      filesystem: { read: "unrestricted", write: "unrestricted" },
      shell: "unrestricted",
      network: "full",
      processControl: true,
      backgroundJobs: true,
      mcp: true,
      subagents: true,
      computerControl: true,
      approvalMode: "never",
    },
  }),
});

export type BuiltInExecutionProfileId = keyof typeof EXECUTION_PROFILES;

export function getExecutionProfile(
  id: BuiltInExecutionProfileId,
): Readonly<ExecutionProfile> {
  return EXECUTION_PROFILES[id];
}

export function createCustomExecutionProfile(
  id: string,
  label: string,
  description: string,
  capabilities: ExecutionCapabilities,
): Readonly<ExecutionProfile> {
  if (!id.trim()) {
    throw new Error("Execution profile id must be non-empty");
  }
  if (!label.trim()) {
    throw new Error("Execution profile label must be non-empty");
  }

  return defineProfile({ id, label, description, capabilities });
}

function requireBoolean(
  missing: string[],
  label: string,
  required: boolean | undefined,
  actual: boolean,
): void {
  if (required === true && !actual) {
    missing.push(label);
  }
}

export function getMissingCapabilities(
  actual: Readonly<ExecutionCapabilities>,
  required: CapabilityRequirement | undefined,
): string[] {
  if (!required) {
    return [];
  }

  const missing: string[] = [];

  if (
    required.filesystemRead &&
    filesystemRank[actual.filesystem.read] <
      filesystemRank[required.filesystemRead]
  ) {
    missing.push(`filesystem.read:${required.filesystemRead}`);
  }

  if (
    required.filesystemWrite &&
    filesystemRank[actual.filesystem.write] <
      filesystemRank[required.filesystemWrite]
  ) {
    missing.push(`filesystem.write:${required.filesystemWrite}`);
  }

  if (required.shell && shellRank[actual.shell] < shellRank[required.shell]) {
    missing.push(`shell:${required.shell}`);
  }

  if (
    required.network &&
    networkRank[actual.network] < networkRank[required.network]
  ) {
    missing.push(`network:${required.network}`);
  }

  requireBoolean(
    missing,
    "processControl",
    required.processControl,
    actual.processControl,
  );
  requireBoolean(
    missing,
    "backgroundJobs",
    required.backgroundJobs,
    actual.backgroundJobs,
  );
  requireBoolean(missing, "mcp", required.mcp, actual.mcp);
  requireBoolean(missing, "subagents", required.subagents, actual.subagents);
  requireBoolean(
    missing,
    "computerControl",
    required.computerControl,
    actual.computerControl,
  );

  return missing;
}
