// Icon system: every UI *action* glyph comes from Lucide through this curated
// map, so one action always uses one icon at a token-driven size.
// Domain/project identity marks (provider logos, project icons, the legacy
// domain set in src/icons.tsx) keep their existing assets.
//
// Import icons from here — not from "lucide-react" — so the set stays
// reviewable and swap-outs happen in one place. The glyph data is vendored
// from Lucide (ISC, see ./LUCIDE-LICENSE and ./iconNodes.ts): add or refresh an
// icon with `node scripts/icons/lucide.mjs add <Name>` and wire it below.
import { createIcon, createLucideIcon, type LucideIcon } from "./iconBase.tsx";
import * as nodes from "./iconNodes.ts";

// One component per Lucide glyph in use. The kebab name is the glyph's Lucide
// name, so the rendered `lucide-<name>` classes stay identical to upstream; the
// alias list preserves the extra legacy classes Lucide emits for renamed icons.
const Activity = createIcon("activity", nodes.Activity);
const Archive = createIcon("archive", nodes.Archive);
const ArchiveRestore = createIcon("archive-restore", nodes.ArchiveRestore);
const ArrowDown = createIcon("arrow-down", nodes.ArrowDown);
const ArrowDownToLine = createIcon("arrow-down-to-line", nodes.ArrowDownToLine);
const ArrowLeft = createIcon("arrow-left", nodes.ArrowLeft);
const ArrowLeftRight = createIcon("arrow-left-right", nodes.ArrowLeftRight);
const ArrowUp = createIcon("arrow-up", nodes.ArrowUp);
const ArrowUpDown = createIcon("arrow-up-down", nodes.ArrowUpDown);
const ArrowUpFromLine = createIcon("arrow-up-from-line", nodes.ArrowUpFromLine);
const AtSign = createIcon("at-sign", nodes.AtSign);
const AudioLines = createIcon("audio-lines", nodes.AudioLines);
const Ban = createIcon("ban", nodes.Ban);
const Bell = createIcon("bell", nodes.Bell);
const Bookmark = createIcon("bookmark", nodes.Bookmark);
const BookOpen = createIcon("book-open", nodes.BookOpen);
const Bot = createIcon("bot", nodes.Bot);
const Braces = createIcon("braces", nodes.Braces, ["curly-braces"]);
const BrainCircuit = createIcon("brain-circuit", nodes.BrainCircuit);
const Bug = createIcon("bug", nodes.Bug);
const CalendarClock = createIcon("calendar-clock", nodes.CalendarClock);
const CalendarDays = createIcon("calendar-days", nodes.CalendarDays);
const Camera = createIcon("camera", nodes.Camera);
const Captions = createIcon("captions", nodes.Captions, ["subtitles"]);
const CaptionsOff = createIcon("captions-off", nodes.CaptionsOff);
const ChartLine = createIcon("chart-line", nodes.ChartLine, ["line-chart"]);
const ChartPie = createIcon("chart-pie", nodes.ChartPie, ["pie-chart"]);
const Check = createIcon("check", nodes.Check);
const ChevronDown = createIcon("chevron-down", nodes.ChevronDown);
const ChevronLeft = createIcon("chevron-left", nodes.ChevronLeft);
const ChevronRight = createIcon("chevron-right", nodes.ChevronRight);
const ChevronUp = createIcon("chevron-up", nodes.ChevronUp);
const CircleAlert = createIcon("circle-alert", nodes.CircleAlert, ["alert-circle"]);
const CircleCheck = createIcon("circle-check", nodes.CircleCheck, ["check-circle-2"]);
const CircleHelp = createIcon("circle-question-mark", nodes.CircleHelp, ["help-circle","circle-help"]);
const CirclePlus = createIcon("circle-plus", nodes.CirclePlus, ["plus-circle"]);
const Clapperboard = createIcon("clapperboard", nodes.Clapperboard);
const ClipboardCheck = createIcon("clipboard-check", nodes.ClipboardCheck);
const Clock = createIcon("clock", nodes.Clock);
const Cloud = createIcon("cloud", nodes.Cloud);
const CloudCog = createIcon("cloud-cog", nodes.CloudCog);
const Code = createIcon("code", nodes.Code);
const Coffee = createIcon("coffee", nodes.Coffee);
const Columns2 = createIcon("columns-2", nodes.Columns2, ["columns"]);
const Combine = createIcon("combine", nodes.Combine);
const Command = createIcon("command", nodes.Command);
const Compass = createIcon("compass", nodes.Compass);
const Container = createIcon("container", nodes.Container);
const Copy = createIcon("copy", nodes.Copy);
const CornerDownLeft = createIcon("corner-down-left", nodes.CornerDownLeft);
const CornerDownRight = createIcon("corner-down-right", nodes.CornerDownRight);
const Cpu = createIcon("cpu", nodes.Cpu);
const Database = createIcon("database", nodes.Database);
const Download = createIcon("download", nodes.Download);
const Ellipsis = createIcon("ellipsis", nodes.Ellipsis, ["more-horizontal"]);
const EllipsisVertical = createIcon("ellipsis-vertical", nodes.EllipsisVertical, ["more-vertical"]);
const Eraser = createIcon("eraser", nodes.Eraser);
const ExternalLink = createIcon("external-link", nodes.ExternalLink);
const Eye = createIcon("eye", nodes.Eye);
const EyeOff = createIcon("eye-off", nodes.EyeOff);
const File = createIcon("file", nodes.File);
const FileDiff = createIcon("file-diff", nodes.FileDiff);
const FileInput = createIcon("file-input", nodes.FileInput);
const FileText = createIcon("file-text", nodes.FileText);
const Flag = createIcon("flag", nodes.Flag);
const Flame = createIcon("flame", nodes.Flame);
const FlaskConical = createIcon("flask-conical", nodes.FlaskConical);
const Folder = createIcon("folder", nodes.Folder);
const FolderGit2 = createIcon("folder-git-2", nodes.FolderGit2);
const FolderOpen = createIcon("folder-open", nodes.FolderOpen);
const FolderPlus = createIcon("folder-plus", nodes.FolderPlus);
const Folders = createIcon("folders", nodes.Folders);
const FolderUp = createIcon("folder-up", nodes.FolderUp);
const Gauge = createIcon("gauge", nodes.Gauge);
const GitBranch = createIcon("git-branch", nodes.GitBranch);
const GitCommitHorizontal = createIcon("git-commit-horizontal", nodes.GitCommitHorizontal, ["git-commit"]);
const GitCompareArrows = createIcon("git-compare-arrows", nodes.GitCompareArrows);
const GitFork = createIcon("git-fork", nodes.GitFork);
const GitMerge = createIcon("git-merge", nodes.GitMerge);
const GitPullRequest = createIcon("git-pull-request", nodes.GitPullRequest);
const Globe = createIcon("globe", nodes.Globe);
const GraduationCap = createIcon("graduation-cap", nodes.GraduationCap);
const Grip = createIcon("grip", nodes.Grip);
const GripVertical = createIcon("grip-vertical", nodes.GripVertical);
const Hammer = createIcon("hammer", nodes.Hammer);
const HardDrive = createIcon("hard-drive", nodes.HardDrive);
const Heading = createIcon("heading", nodes.Heading);
const Heart = createIcon("heart", nodes.Heart);
const HeartPulse = createIcon("heart-pulse", nodes.HeartPulse);
const History = createIcon("rotate-ccw-clock", nodes.History, ["history"]);
const House = createIcon("house", nodes.House, ["home"]);
const Image = createIcon("image", nodes.Image);
const Info = createIcon("info", nodes.Info);
const Keyboard = createIcon("keyboard", nodes.Keyboard);
const KeyRound = createIcon("key-round", nodes.KeyRound);
const Languages = createIcon("languages", nodes.Languages);
const Layers = createIcon("layers", nodes.Layers, ["layers-3"]);
const LayoutGrid = createIcon("layout-grid", nodes.LayoutGrid);
const Lightbulb = createIcon("lightbulb", nodes.Lightbulb);
const Link = createIcon("link", nodes.Link);
const List = createIcon("list", nodes.List);
const ListChecks = createIcon("list-checks", nodes.ListChecks);
const ListFilter = createIcon("list-filter", nodes.ListFilter);
const ListTree = createIcon("list-tree", nodes.ListTree);
const Loader = createIcon("loader", nodes.Loader);
const Lock = createIcon("lock", nodes.Lock);
const LogOut = createIcon("log-out", nodes.LogOut);
const Mail = createIcon("mail", nodes.Mail);
const Maximize2 = createIcon("maximize-2", nodes.Maximize2);
const Menu = createIcon("menu", nodes.Menu);
const MessageSquare = createIcon("message-square", nodes.MessageSquare);
const MessageSquarePlus = createIcon("message-square-plus", nodes.MessageSquarePlus);
const Mic = createIcon("mic", nodes.Mic);
const MicOff = createIcon("mic-off", nodes.MicOff);
const Minimize2 = createIcon("minimize-2", nodes.Minimize2);
const Minus = createIcon("minus", nodes.Minus);
const Monitor = createIcon("monitor", nodes.Monitor);
const MousePointer = createIcon("mouse-pointer", nodes.MousePointer);
const Music = createIcon("eighth-notes", nodes.Music, ["music"]);
const Network = createIcon("network", nodes.Network);
const NotebookPen = createIcon("notebook-pen", nodes.NotebookPen);
const Package = createIcon("package", nodes.Package);
const Palette = createIcon("palette", nodes.Palette);
const PanelBottom = createIcon("panel-bottom", nodes.PanelBottom);
const PanelLeftClose = createIcon("panel-left-close", nodes.PanelLeftClose, ["sidebar-close"]);
const PanelLeftOpen = createIcon("panel-left-open", nodes.PanelLeftOpen, ["sidebar-open"]);
const PanelRight = createIcon("panel-right", nodes.PanelRight);
const Paperclip = createIcon("paperclip", nodes.Paperclip);
const Pause = createIcon("pause", nodes.Pause);
const Pencil = createIcon("pencil", nodes.Pencil);
const Pin = createIcon("pin", nodes.Pin);
const Play = createIcon("play", nodes.Play);
const Plug = createIcon("plug", nodes.Plug);
const Plus = createIcon("plus", nodes.Plus);
const Power = createIcon("power", nodes.Power);
const Puzzle = createIcon("puzzle", nodes.Puzzle);
const QrCode = createIcon("qr-code", nodes.QrCode);
const RefreshCw = createIcon("refresh-cw", nodes.RefreshCw);
const Repeat = createIcon("repeat", nodes.Repeat);
const Reply = createIcon("reply", nodes.Reply);
const Rocket = createIcon("rocket", nodes.Rocket);
const RotateCcw = createIcon("rotate-ccw", nodes.RotateCcw);
const RotateCw = createIcon("rotate-cw", nodes.RotateCw);
const Route = createIcon("route", nodes.Route);
const Rows2 = createIcon("rows-2", nodes.Rows2, ["rows"]);
const Scale = createIcon("scale", nodes.Scale);
const Scan = createIcon("scan", nodes.Scan);
const ScrollText = createIcon("scroll-text", nodes.ScrollText);
const Search = createIcon("search", nodes.Search);
const Send = createIcon("send", nodes.Send);
const SeparatorHorizontal = createIcon("separator-horizontal", nodes.SeparatorHorizontal);
const Server = createIcon("server", nodes.Server);
const ServerCrash = createIcon("server-crash", nodes.ServerCrash);
const Settings = createIcon("settings", nodes.Settings);
const Shapes = createIcon("shapes", nodes.Shapes);
const Share = createIcon("share", nodes.Share);
const Shield = createIcon("shield", nodes.Shield);
const ShieldAlert = createIcon("shield-alert", nodes.ShieldAlert);
const ShieldCheck = createIcon("shield-check", nodes.ShieldCheck);
const SkipBack = createIcon("skip-back", nodes.SkipBack);
const SkipForward = createIcon("skip-forward", nodes.SkipForward);
const SlidersHorizontal = createIcon("sliders-horizontal", nodes.SlidersHorizontal);
const Smartphone = createIcon("smartphone", nodes.Smartphone);
const Sparkles = createIcon("sparkles", nodes.Sparkles, ["stars"]);
const Square = createIcon("square", nodes.Square);
const SquareCheckBig = createIcon("square-check-big", nodes.SquareCheckBig, ["check-square"]);
const SquareKanban = createIcon("square-kanban", nodes.SquareKanban, ["kanban-square"]);
const SquarePen = createIcon("square-pen", nodes.SquarePen, ["pen-box","edit","pen-square"]);
const Star = createIcon("star", nodes.Star);
const Tag = createIcon("tag", nodes.Tag);
const Target = createIcon("target", nodes.Target);
const Telescope = createIcon("telescope", nodes.Telescope);
const Terminal = createIcon("terminal", nodes.Terminal);
const TextQuote = createIcon("text-quote", nodes.TextQuote);
const TextSearch = createIcon("text-search", nodes.TextSearch);
const ThumbsDown = createIcon("thumbs-down", nodes.ThumbsDown);
const ThumbsUp = createIcon("thumbs-up", nodes.ThumbsUp);
const Timer = createIcon("timer", nodes.Timer);
const Trash2 = createIcon("trash", nodes.Trash2, ["trash-2"]);
const TriangleAlert = createIcon("triangle-alert", nodes.TriangleAlert, ["alert-triangle"]);
const Unlock = createIcon("lock-open", nodes.Unlock, ["unlock"]);
const Upload = createIcon("upload", nodes.Upload);
const User = createIcon("user", nodes.User);
const Users = createIcon("users", nodes.Users);
const UsersRound = createIcon("users-round", nodes.UsersRound, ["users-2"]);
const Volume2 = createIcon("volume-2", nodes.Volume2);
const VolumeOff = createIcon("volume-off", nodes.VolumeOff);
const WandSparkles = createIcon("wand-sparkles", nodes.WandSparkles, ["wand-2"]);
const Webhook = createIcon("webhook", nodes.Webhook);
const WifiOff = createIcon("wifi-off", nodes.WifiOff);
const Workflow = createIcon("workflow", nodes.Workflow);
const WrapText = createIcon("text-wrap", nodes.WrapText, ["wrap-text"]);
const Wrench = createIcon("wrench", nodes.Wrench);
const X = createIcon("x", nodes.X);
const Zap = createIcon("zap", nodes.Zap);
const ZoomIn = createIcon("zoom-in", nodes.ZoomIn);
const ZoomOut = createIcon("zoom-out", nodes.ZoomOut);

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

export type { LucideIcon } from "./iconBase.tsx";

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
  CornerDownRight as QueueNextIcon,
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
  Scale as JudgeIcon,
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
};
