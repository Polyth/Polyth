// P1-W2 icon system: every UI *action* glyph comes from Lucide through this
// curated map, so one action always uses one icon at a token-driven size.
// Domain/project identity marks (provider logos, project icons, the legacy
// domain set in src/icons.tsx) keep their existing assets.
//
// Import icons from here — not from "lucide-react" directly — so the set
// stays reviewable and swap-outs happen in one place.
import {
  Archive,
  Bell,
  KeyRound,
  Pencil,
  Repeat,
  Search,
  Sparkles,
  Square,
  Volume2,
  type LucideIcon,
} from "lucide-react";

/** String-keyed command descriptors resolve only through this allowlist. */
export const COMMAND_ICONS: Readonly<Record<string, LucideIcon>> = {
  archive: Archive,
  bell: Bell,
  edit: Pencil,
  key: KeyRound,
  search: Search,
  sparkle: Sparkles,
  stop: Square,
  volume: Volume2,
};

export function commandIcon(name: string | undefined): LucideIcon | undefined {
  return name ? COMMAND_ICONS[name] : undefined;
}

export {
  // dismiss / confirm
  X as CloseIcon,
  Check as CheckIcon,
  CircleCheck as SuccessIcon,
  CircleAlert as ErrorIcon,
  TriangleAlert as WarningIcon,
  Info as InfoIcon,
  CircleHelp as HelpIcon,
  // navigation
  Menu as MenuIcon,
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  ChevronRight as ChevronRightIcon,
  ChevronLeft as ChevronLeftIcon,
  ArrowLeft as BackIcon,
  ExternalLink as ExternalLinkIcon,
  // common actions
  Plus as AddIcon,
  Plus as PlusIcon,
  Minus as MinusIcon,
  Link as LinkIcon,
  Pencil as EditIcon,
  SquarePen as ComposeIcon,
  Trash2 as DeleteIcon,
  Copy as CopyIcon,
  FileText as MarkdownIcon,
  Braces as JsonIcon,
  ClipboardCheck as CopiedIcon,
  Download as DownloadIcon,
  Download as FetchIcon,
  ArrowDownToLine as PullIcon,
  ArrowUpFromLine as PushIcon,
  Upload as UploadIcon,
  RefreshCw as RefreshIcon,
  // Sync is a bidirectional exchange, not a read-only refresh: keep the two
  // glyphs distinct so the mutating action never reads as a reload.
  Repeat as SyncIcon,
  RotateCcw as UndoIcon,
  RotateCw as RedoIcon,
  GitFork as ForkIcon,
  Search as SearchIcon,
  ListFilter as FilterIcon,
  ArrowUpDown as SortIcon,
  Ellipsis as MoreIcon,
  EllipsisVertical as MoreVerticalIcon,
  GripVertical as DragHandleIcon,
  Eye as ShowIcon,
  EyeOff as HideIcon,
  Image as ImageIcon,
  Scan as ScanIcon,
  Target as TargetIcon,
  Pin as PinIcon,
  Star as FavoriteIcon,
  Send as SendIcon,
  // A queued follow-up is still a send action. The composer adds a tiny queue
  // badge in CSS instead of replacing the familiar send glyph with ListPlus.
  Send as QueueIcon,
  Mic as MicIcon,
  Play as PlayIcon,
  Square as StopIcon,
  Pause as PauseIcon,
  Settings as SettingsIcon,
  LogOut as SignOutIcon,
  Lock as LockIcon,
  Unlock as UnlockIcon,
  PanelLeft as SidebarIcon,
  PanelRight as DockSideIcon,
  PanelBottom as DockBottomIcon,
  Maximize2 as ExpandIcon,
  Minimize2 as CollapseIcon,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
  CornerDownLeft as EnterIcon,
  // workspace objects that appear inside action controls
  House as HomeIcon,
  Folder as FolderIcon,
  // "Add project" and "new chat" are different creations. A bare Plus for both
  // reads as the same action twice, so each keeps the object it creates.
  FolderPlus as AddProjectIcon,
  FolderUp as ParentFolderIcon,
  File as FileIcon,
  FileDiff as FileDiffIcon,
  Terminal as TerminalIcon,
  GitBranch as BranchIcon,
  FolderGit2 as WorktreeIcon,
  GitPullRequest as PullRequestIcon,
  CirclePlus as StageIcon,
  Workflow as WorkflowIcon,
  User as SessionIcon,
  Globe as GlobeIcon,
  Bell as BellIcon,
  Clock as ClockIcon,
  CalendarClock as ScheduleIcon,
  MessageSquare as ChatIcon,
  MessageSquarePlus as NewChatIcon,
  BookOpen as DocsIcon,
  Sparkles as AssistIcon,
  Layers as LayersIcon,
  Package as PackageIcon,
  Puzzle as PluginIcon,
  KeyRound as KeyIcon,
  ShieldCheck as ShieldIcon,
  Server as ServerIcon,
  Database as DatabaseIcon,
  Loader as LoaderIcon,
  // package identity glyphs; all monochrome Lucide SVGs
  ArrowLeftRight as HandoffIcon,
  BrainCircuit as BrainIcon,
  ChartLine as ChartIcon,
  ChartPie as UsageIcon,
  Code as CodeIcon,
  Combine as CombineIcon,
  Command as CommandIcon,
  Compass as CompassIcon,
  Cpu as CpuIcon,
  FileInput as FileInputIcon,
  FlaskConical as FlaskIcon,
  // lucide-react does not export these brand marks. Keep compatibility aliases backed
  // by distinct git workflow glyphs while action code uses the semantic ForkIcon above.
  GitFork as GithubIcon,
  GitMerge as GitlabIcon,
  History as HistoryIcon,
  Keyboard as KeyboardIcon,
  ListChecks as TasksIcon,
  MousePointer as PointerIcon,
  Network as NetworkIcon,
  Palette as PaletteIcon,
  QrCode as QrCodeIcon,
  Route as RouteIcon,
} from "lucide-react";

export type { LucideIcon } from "lucide-react";
