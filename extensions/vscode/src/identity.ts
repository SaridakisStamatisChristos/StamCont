/**
 * VS Code product-identity compatibility helpers.
 *
 * PR20 introduces StamCont command IDs without removing the Continue-era
 * command namespace. Configuration, view/container, URI, and marketplace IDs
 * intentionally remain compatibility identifiers until a dedicated migration
 * can preserve persisted state and an owned marketplace identity exists.
 */
export const LEGACY_VSCODE_COMMAND_PREFIX = "continue.";
export const STAMCONT_VSCODE_COMMAND_PREFIX = "stamcont.";

export const VSCODE_COMPATIBILITY_EXTENSION_ID = "Continue.continue";

export function toStamContCommandId(command: string): string {
  if (!command.startsWith(LEGACY_VSCODE_COMMAND_PREFIX)) {
    return command;
  }

  return `${STAMCONT_VSCODE_COMMAND_PREFIX}${command.slice(
    LEGACY_VSCODE_COMMAND_PREFIX.length,
  )}`;
}

export function getCompatibleCommandIds(command: string): string[] {
  const stamcontCommand = toStamContCommandId(command);

  return stamcontCommand === command ? [command] : [command, stamcontCommand];
}
