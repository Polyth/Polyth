// P1-W2 icon system: every UI *action* glyph comes from Lucide through this
// curated map, so one action always uses one icon at a token-driven size.
// Domain/project identity marks (provider logos, project icons, the legacy
// domain set in src/icons.tsx) keep their existing assets.
//
// Import icons from here — not from "lucide-react" directly — so the set
// stays reviewable and swap-outs happen in one place.
import {
  Archive,
  AtSign,
  Bell,
  createLucideIcon,
  AudioLines,
  KeyRound,
  Mic,
  Pencil,
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
  mic: Mic,
  search: Search,
  sparkle: Sparkles,
  stop: Square,
  "voice-mode": AudioLines,
  volume: Volume2,
};

export function commandIcon(name: string | undefined): LucideIcon | undefined {
  return name ? COMMAND_ICONS[name] : undefined;
}

// The plane, badge, and plus share one viewBox. CSS positioning a second SVG
// against the button made the plus drift at different control sizes.
export const QueueSendIcon = createLucideIcon("QueueSend", [
  // The plane's tip is cut at the badge disc's edge and the outline closes
  // along the disc circle: the plus is a hole in the disc, so anything drawn
  // behind it shows straight through the cross. An uncut tip at the disc
  // centre filled the plus's middle; truncated, the plane flies into the
  // badge and the hole stays clear in every tone.
  ["path", { d: "M13.089 7.544 3.1 11.2a.8.8 0 0 0 0 1.5l6.2 2 2 6.2a.8.8 0 0 0 1.5 0L16.456 10.911A5.4 5.4 0 0 1 13.089 7.544Z", key: "plane" }],
  ["path", { d: "m9.3 14.7 5.082-5.082", key: "fold" }],
  // The badge is one even-odd path, so the plus is a real hole in the disc and
  // always shows the action fill behind it. Painting it separately in a fixed
  // colour vanished whenever that colour matched the fill (the running split is
  // accent ink on an accent wash) and read as the wrong colour on the phone
  // action, whose fill is the text token.
  ["path", {
    d: "M18.2 0.4a5.4 5.4 0 1 0 0 10.8 5.4 5.4 0 1 0 0-10.8ZM17.3 3.2h1.8v1.7h1.7v1.8h-1.7v1.7h-1.8V6.7h-1.7V4.9h1.7Z",
    fill: "currentColor",
    fillRule: "evenodd",
    stroke: "none",
    key: "badge",
  }],
]);

export {
  // dismiss / confirm
  X as CloseIcon,
  Check as CheckIcon,
  SquareCheckBig as SelectIcon,
  CircleCheck as SuccessIcon,
  Timer as TimerIcon,
  CircleAlert as ErrorIcon,
  TriangleAlert as WarningIcon,
  Info as InfoIcon,
  CircleHelp as HelpIcon,
  // transient error-toast categories
  WifiOff as OfflineIcon,
  HardDrive as StorageIcon,
  ServerCrash as ServerErrorIcon,
  Ban as BlockedIcon,
  // navigation
  Menu as MenuIcon,
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  ChevronRight as ChevronRightIcon,
  ChevronLeft as ChevronLeftIcon,
  SkipBack as SkipBackIcon,
  SkipForward as SkipForwardIcon,
  ArrowLeft as BackIcon,
  ExternalLink as ExternalLinkIcon,
  // common actions
  Plus as AddIcon,
  Plus as PlusIcon,
  Minus as MinusIcon,
  Link as LinkIcon,
  Paperclip as AttachmentIcon,
  Pencil as EditIcon,
  SquarePen as ComposeIcon,
  Trash2 as DeleteIcon,
  Archive as ArchiveIcon,
  ArchiveRestore as RestoreIcon,
  Copy as CopyIcon,
  TextQuote as QuoteIcon,
  Reply as ReplyIcon,
  Share as ShareIcon,
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
  Bookmark as BookmarkIcon,
  Star as FavoriteIcon,
  Send as SendIcon,
  Mic as MicIcon,
  MicOff as MicOffIcon,
  AudioLines as VoiceModeIcon,
  Captions as CaptionsIcon,
  CaptionsOff as CaptionsOffIcon,
  Volume2 as SpeakerIcon,
  VolumeOff as SpeakerOffIcon,
  Play as PlayIcon,
  Square as StopIcon,
  Pause as PauseIcon,
  Settings as SettingsIcon,
  LogOut as SignOutIcon,
  Lock as LockIcon,
  Unlock as UnlockIcon,
  // One panel glyph for the sidebar: the frame never changes, only the
  // arrow's side, so the rail and the classic toolbar share one control.
  PanelLeftClose as SidebarCollapseIcon,
  PanelLeftOpen as SidebarExpandIcon,
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
  // A multi-repository project's repository scope (several stacked folders).
  Folders as RepositoriesIcon,
  GitPullRequest as PullRequestIcon,
  CirclePlus as StageIcon,
  // Source control objects and view shapes. A stash is set-aside work, so it
  // borrows the archive box rather than a generic layer stack.
  GitCommitHorizontal as CommitIcon,
  GitCompareArrows as CompareIcon,
  Tag as TagIcon,
  Archive as StashIcon,
  ArchiveRestore as StashApplyIcon,
  FolderOpen as FolderOpenIcon,
  ListTree as TreeViewIcon,
  List as ListViewIcon,
  LayoutGrid as GridViewIcon,
  SquareKanban as BoardViewIcon,
  // Layout elements a person places between items (Workspace headings and dividers).
  Heading as HeadingIcon,
  SeparatorHorizontal as DividerIcon,
  // Direction of a sorted column or a metric's change.
  ArrowUp as ArrowUpIcon,
  ArrowDown as ArrowDownIcon,
  SlidersHorizontal as ViewOptionsIcon,
  WrapText as WrapIcon,
  Columns2 as SplitViewIcon,
  Rows2 as UnifiedViewIcon,
  Workflow as WorkflowIcon,
  User as SessionIcon,
  // People-first conversations have no agent: a group glyph, not a status mark.
  UsersRound as PeopleIcon,
  // A chat other people can open (navigator marker, Share action).
  Users as SharedIcon,
  Globe as GlobeIcon,
  // Interface language picker (the globe already means the Browser).
  Languages as LanguageIcon,
  Bell as BellIcon,
  AtSign as MentionIcon,
  Clock as ClockIcon,
  CalendarClock as ScheduleIcon,
  CalendarDays as CalendarIcon,
  MessageSquare as ChatIcon,
  MessageSquarePlus as NewChatIcon,
  BookOpen as DocsIcon,
  Sparkles as AssistIcon,
  Layers as LayersIcon,
  Package as PackageIcon,
  LayoutGrid as AppsIcon,
  Puzzle as PluginIcon,
  KeyRound as KeyIcon,
  ShieldCheck as ShieldIcon,
  ShieldAlert as ShieldAlertIcon,
  Shield as ShieldEmptyIcon,
  Server as ServerIcon,
  Database as DatabaseIcon,
  Loader as LoaderIcon,
  // package identity glyphs; all monochrome Lucide SVGs
  Activity as MonitoringIcon,
  ArrowLeftRight as HandoffIcon,
  CloudCog as InfrastructureIcon,
  Container as ContainerIcon,
  // Google's own apps launcher; lucide-react ships no Google brand mark.
  Grip as GoogleIcon,
  ScrollText as RecapIcon,
  Shapes as PlaygroundIcon,
  Clapperboard as CreativeStudioIcon,
  Telescope as WebSearchIcon,
  TextSearch as FindInTextIcon,
  BrainCircuit as BrainIcon,
  ChartLine as ChartIcon,
  ChartPie as UsageIcon,
  Code as CodeIcon,
  Combine as CombineIcon,
  Command as CommandIcon,
  Compass as CompassIcon,
  Cpu as CpuIcon,
  GraduationCap as CoachIcon,
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
  // Identity marks a person picks for their own custom actions.
  Zap as ZapIcon,
  Rocket as RocketIcon,
  Hammer as BuildIcon,
  Wrench as WrenchIcon,
  Bug as BugIcon,
  Cloud as CloudIcon,
  Gauge as GaugeIcon,
  GitMerge as MergeIcon,
  Eraser as EraserIcon,
  Bot as BotIcon,
  WandSparkles as WandIcon,
  Mail as MailIcon,
  Flag as FlagIcon,
  Lightbulb as LightbulbIcon,
  Power as PowerIcon,
  Plug as PlugIcon,
  Coffee as CoffeeIcon,
  Flame as FlameIcon,
  Heart as HeartIcon,
  Camera as CameraIcon,
  Music as MusicIcon,
  Monitor as MonitorIcon,
  Smartphone as SmartphoneIcon,
  Webhook as WebhookIcon,
  // feedback on an agent's report, and the notebook it keeps
  ThumbsUp as ThumbsUpIcon,
  ThumbsDown as ThumbsDownIcon,
  NotebookPen as NotebookIcon,
  HeartPulse as HeartbeatIcon,
} from "lucide-react";

export type { LucideIcon } from "lucide-react";

