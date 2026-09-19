import {
  ChatBubbleLeftIcon,
  LockOpenIcon,
  RocketLaunchIcon,
  SparklesIcon,
  SwatchIcon,
} from "@heroicons/react/24/outline";
import type { ExecutionProfileId, MessageModes } from "core";

interface ModeIconProps {
  mode: MessageModes | ExecutionProfileId;
  className?: string;
}

export function ModeIcon({
  mode,
  className = "xs:h-3 xs:w-3 h-3 w-3",
}: ModeIconProps) {
  switch (mode) {
    case "agent":
    case "interactive":
      return <SparklesIcon className={className} />;
    case "full_access":
      return <LockOpenIcon className={className} />;
    case "plan":
      return <SwatchIcon className={className} />;
    case "chat":
      return <ChatBubbleLeftIcon className={className} />;
    case "background":
      return <RocketLaunchIcon className={className} />;
  }
}
