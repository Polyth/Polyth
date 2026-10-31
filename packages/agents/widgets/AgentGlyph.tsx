import type { AgentColorDto } from "@polyth/session/web-api";
import {
  AssistIcon,
  BellIcon,
  BotIcon,
  BrainIcon,
  ChartIcon,
  ChatIcon,
  CodeIcon,
  CompassIcon,
  DocsIcon,
  FlaskIcon,
  Icon,
  MonitoringIcon,
  PullRequestIcon,
  ScheduleIcon,
  ShieldIcon,
  ShowIcon,
  TerminalIcon,
  WebSearchIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import type { AgentIconId } from "../src/agentPrompt.ts";

/** The agent's identity mark. `bot` is the default: a new agent is a robot
 *  until the person picks another glyph. */
export const AGENT_ICONS: Record<AgentIconId, typeof AssistIcon> = {
  bot: BotIcon,
  assist: AssistIcon,
  review: PullRequestIcon,
  eye: ShowIcon,
  bell: BellIcon,
  chart: ChartIcon,
  schedule: ScheduleIcon,
  shield: ShieldIcon,
  terminal: TerminalIcon,
  brain: BrainIcon,
  search: WebSearchIcon,
  monitor: MonitoringIcon,
  code: CodeIcon,
  flask: FlaskIcon,
  compass: CompassIcon,
  docs: DocsIcon,
  chat: ChatIcon,
};

/** The agent's identity mark: its glyph on a tile washed in its colour. */
export default function AgentGlyph({ icon, color, size = "md" }: {
  icon?: string;
  color?: AgentColorDto;
  size?: "sm" | "md" | "lg";
}) {
  const glyph = AGENT_ICONS[icon as AgentIconId] ?? BotIcon;
  return (
    <span className="agent-glyph" data-color={color ?? "neutral"} data-size={size} aria-hidden="true">
      <Icon icon={glyph} size={size === "lg" ? "lg" : size === "sm" ? "sm" : "md"} />
    </span>
  );
}

/** The agent's glyph on a round tile in its colour. While it works, an arc
 *  travels round the tile: the same mark in the navigator, on its page and
 *  at the end of its conversation. */
export function AgentMark({ icon, color, working, size = "md" }: {
  icon?: string | undefined;
  color?: AgentColorDto | undefined;
  working: boolean;
  size?: "sm" | "md";
}) {
  const glyph = AGENT_ICONS[icon as AgentIconId] ?? BotIcon;
  return (
    <span className="agent-mark" data-color={color ?? "neutral"} data-working={working || undefined} data-size={size} aria-hidden="true">
      <Icon icon={glyph} size="sm" />
    </span>
  );
}
