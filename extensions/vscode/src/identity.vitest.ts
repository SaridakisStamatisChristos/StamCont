import { describe, expect, it } from "vitest";

import packageJson from "../package.json";
import {
  getCompatibleCommandIds,
  LEGACY_VSCODE_COMMAND_PREFIX,
  STAMCONT_VSCODE_COMMAND_PREFIX,
  toStamContCommandId,
  VSCODE_COMPATIBILITY_EXTENSION_ID,
} from "./identity";

describe("VS Code command identity compatibility", () => {
  it("maps Continue-era commands to a StamCont primary alias", () => {
    expect(toStamContCommandId("continue.newSession")).toBe(
      "stamcont.newSession",
    );
    expect(getCompatibleCommandIds("continue.newSession")).toEqual([
      "continue.newSession",
      "stamcont.newSession",
    ]);
  });

  it("does not manufacture aliases for unrelated command namespaces", () => {
    expect(getCompatibleCommandIds("workbench.action.reloadWindow")).toEqual([
      "workbench.action.reloadWindow",
    ]);
  });

  it("keeps the installed extension ID explicit as a compatibility identity", () => {
    expect(VSCODE_COMPATIBILITY_EXTENSION_ID).toBe("Continue.continue");
  });
});

describe("VS Code PR20 manifest contract", () => {
  const manifest = packageJson as any;
  const contributedCommands = manifest.contributes.commands as Array<{
    command: string;
  }>;

  const legacyCommandIds = new Set(
    contributedCommands
      .map((entry) => entry.command)
      .filter((command) =>
        command.startsWith(LEGACY_VSCODE_COMMAND_PREFIX),
      ),
  );

  const stamcontCommandIds = new Set(
    contributedCommands
      .map((entry) => entry.command)
      .filter((command) =>
        command.startsWith(STAMCONT_VSCODE_COMMAND_PREFIX),
      ),
  );

  it("preserves marketplace identity until StamCont owns a publisher target", () => {
    expect(manifest.publisher).toBe("Continue");
    expect(manifest.name).toBe("continue");
    expect(manifest.displayName).toMatch(/^StamCont\b/);
  });

  it("contributes a StamCont alias for every legacy Continue command", () => {
    for (const legacyCommandId of legacyCommandIds) {
      expect(stamcontCommandIds.has(toStamContCommandId(legacyCommandId))).toBe(
        true,
      );
    }
  });

  it("uses StamCont command IDs for built-in keybindings", () => {
    for (const keybinding of manifest.contributes.keybindings ?? []) {
      if (typeof keybinding.command === "string") {
        expect(keybinding.command.startsWith("continue.")).toBe(false);
      }
    }
  });

  it("uses StamCont command IDs for manifest menu command references", () => {
    for (const entries of Object.values(manifest.contributes.menus ?? {})) {
      for (const entry of entries as any[]) {
        if (
          typeof entry.command === "string" &&
          entry.when !== "false"
        ) {
          expect(entry.command.startsWith("continue.")).toBe(false);
        }
      }
    }
  });

  it("retains and hides legacy commands in the command palette", () => {
    const hiddenLegacyCommands = new Set(
      (manifest.contributes.menus.commandPalette ?? [])
        .filter((entry: any) => entry.when === "false")
        .map((entry: any) => entry.command),
    );

    for (const legacyCommandId of legacyCommandIds) {
      expect(hiddenLegacyCommands.has(legacyCommandId)).toBe(true);
    }
  });

  it("keeps configuration keys in the persisted Continue namespace", () => {
    const keys = Object.keys(
      manifest.contributes.configuration.properties ?? {},
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith("continue."))).toBe(true);
    expect(keys.some((key) => key.startsWith("stamcont."))).toBe(false);
  });

  it("keeps view/container IDs stable so VS Code layout state survives upgrade", () => {
    expect(
      manifest.contributes.viewsContainers.activitybar.map((x: any) => x.id),
    ).toContain("continue");
    expect(
      manifest.contributes.viewsContainers.panel.map((x: any) => x.id),
    ).toContain("continueConsole");
    expect(manifest.contributes.views.continue[0].id).toBe(
      "continue.continueGUIView",
    );
    expect(manifest.contributes.views.continueConsole[0].id).toBe(
      "continue.continueConsoleView",
    );
    expect(manifest.activationEvents).toContain(
      "onView:continueGUIView",
    );
  });

  it("activates for every StamCont command alias on older supported VS Code versions", () => {
    const activationEvents = new Set(manifest.activationEvents);
    for (const commandId of stamcontCommandIds) {
      expect(activationEvents.has(`onCommand:${commandId}`)).toBe(true);
    }
  });

  it("keeps the URI activation contract intact", () => {
    expect(manifest.activationEvents).toContain("onUri");
  });
});
