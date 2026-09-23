import type { Tool } from "core";
import type { AgentSurfaceToolPolicy } from "core/agent/surface";

import { isEditTool } from "../../util/toolCallState";
import { DEFAULT_TOOL_SETTING } from "../slices/uiSlice";
import type { RootState } from "../store";

export function getAgentSurfaceToolPolicies(
  state: RootState,
  activeTools: readonly Tool[],
): Record<string, AgentSurfaceToolPolicy> {
  return Object.fromEntries(
    activeTools.map((tool) => {
      const name = tool.function.name;
      const policy: AgentSurfaceToolPolicy = isEditTool(name)
        ? "allowedWithoutPermission"
        : (state.ui.toolSettings[name] ??
          tool.defaultToolPolicy ??
          DEFAULT_TOOL_SETTING);
      return [name, policy];
    }),
  );
}
