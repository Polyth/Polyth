import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseError } from "../errors.ts";
import { baseCharacter, type KeyChord, type Modifier, type NamedKey } from "../keys.ts";
import { runCommand, type CommandRunner } from "../process.ts";
import type { ComputerDriver, DesktopState, DesktopWindow, InputStep } from "../types.ts";

/** Virtual-key codes (WinUser.h). */
const NAMED: Record<NamedKey, number> = {
  enter: 0x0d, escape: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08, delete: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
};
const OEM: Record<string, number> = {
  ";": 0xba, "=": 0xbb, ",": 0xbc, "-": 0xbd, ".": 0xbe, "/": 0xbf, "`": 0xc0, "[": 0xdb, "\\": 0xdc, "]": 0xdd, "'": 0xde,
};
const MODIFIER_VK: Record<Modifier, number> = { ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b };
/** Keys that need KEYEVENTF_EXTENDEDKEY, or Windows reads them as the numpad. */
const EXTENDED = new Set([0x2d, 0x2e, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28, 0x5b]);

export interface WindowsKeyPress { vk: number; modifiers: number[]; extended: number[] }

export const windowsKeyPress = (chord: KeyChord): WindowsKeyPress => {
  const modifiers = new Set(chord.modifiers);
  let vk: number | undefined;
  if (chord.key?.kind === "named") vk = NAMED[chord.key.name];
  else if (chord.key?.kind === "char") {
    const base = baseCharacter(chord.key.char);
    if (base.shift) modifiers.add("shift");
    vk = OEM[base.char] ?? base.char.toUpperCase().charCodeAt(0);
  }
  const mods = (["ctrl", "alt", "shift", "meta"] as const).filter((m) => modifiers.has(m)).map((m) => MODIFIER_VK[m]);
  if (vk === undefined && !mods.length) throw new ComputerUseError("invalid-input", "keys names no key");
  return { vk: vk ?? -1, modifiers: mods, extended: [...(vk === undefined ? [] : [vk]), ...mods].filter((code) => EXTENDED.has(code)) };
};

/** C# helper compiled by Add-Type on each run. The process is made per-monitor
 * DPI aware first, so every coordinate is a physical pixel of the primary
 * display, matching the screenshot. */
const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PolythComputer {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

  public static void Init() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
    SetProcessDPIAware();
  }
  public static int Width() { return GetSystemMetrics(0); }
  public static int Height() { return GetSystemMetrics(1); }
  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }

  static INPUT Mouse(uint flags, int data) {
    INPUT input = new INPUT(); input.type = 0; input.u.mi.dwFlags = flags; input.u.mi.mouseData = data; return input;
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT input = new INPUT(); input.type = 1; input.u.ki.wVk = vk; input.u.ki.wScan = scan; input.u.ki.dwFlags = flags; return input;
  }
  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new InvalidOperationException("Windows blocked the input (an elevated window may be in front)");
  }
  static uint[] Buttons(string button) {
    if (button == "right") return new uint[] { 0x0008, 0x0010 };
    if (button == "middle") return new uint[] { 0x0020, 0x0040 };
    return new uint[] { 0x0002, 0x0004 };
  }
  public static void KeyDown(int vk, bool extended) { Send(Key((ushort)vk, 0, extended ? 1u : 0u)); }
  public static void KeyUp(int vk, bool extended) { Send(Key((ushort)vk, 0, (extended ? 1u : 0u) | 0x0002)); }
  public static void Move(int x, int y) { if (!SetCursorPos(x, y)) throw new InvalidOperationException("Windows refused to move the pointer"); }
  public static void Click(int x, int y, string button, int count) {
    uint[] b = Buttons(button);
    Move(x, y);
    for (int i = 0; i < count; i++) { Send(Mouse(b[0], 0), Mouse(b[1], 0)); Thread.Sleep(40); }
  }
  public static void Drag(int[] xs, int[] ys, string button) {
    uint[] b = Buttons(button);
    Move(xs[0], ys[0]);
    Send(Mouse(b[0], 0));
    for (int i = 1; i < xs.Length; i++) { Thread.Sleep(30); Move(xs[i], ys[i]); Send(Mouse(0x0001, 0)); }
    Thread.Sleep(50);
    Send(Mouse(b[1], 0));
  }
  public static void Scroll(int x, int y, int dx, int dy) {
    Move(x, y);
    if (dy != 0) Send(Mouse(0x0800, -dy * 120));
    if (dx != 0) Send(Mouse(0x1000, dx * 120));
  }
  public static void Type(string text) {
    foreach (char c in text) {
      if (c == '\n') { Send(Key(0x0D, 0, 0), Key(0x0D, 0, 0x0002)); }
      else if (c != '\r') { Send(Key(0, c, 0x0004), Key(0, c, 0x0004 | 0x0002)); }
      Thread.Sleep(8);
    }
  }
  public static void Capture(int x, int y, int width, int height, int outWidth, int outHeight, string path) {
    using (Bitmap source = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(source)) { g.CopyFromScreen(x, y, 0, 0, new Size(width, height)); }
      using (Bitmap output = new Bitmap(outWidth, outHeight, PixelFormat.Format24bppRgb)) {
        using (Graphics g = Graphics.FromImage(output)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.PixelOffsetMode = PixelOffsetMode.HighQuality;
          g.DrawImage(source, new Rectangle(0, 0, outWidth, outHeight));
        }
        output.Save(path, ImageFormat.Png);
      }
    }
  }
  public static List<object[]> Windows() {
    List<object[]> result = new List<object[]>();
    IntPtr foreground = GetForegroundWindow();
    EnumWindows(delegate (IntPtr hwnd, IntPtr lParam) {
      if (result.Count >= 60 || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
      if (GetWindow(hwnd, 4) != IntPtr.Zero) return true;            // owned popups
      if ((GetWindowLong(hwnd, -20) & 0x00000080) != 0) return true;  // WS_EX_TOOLWINDOW
      int cloaked; if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      int length = GetWindowTextLength(hwnd); if (length == 0) return true;
      StringBuilder title = new StringBuilder(length + 1); GetWindowText(hwnd, title, title.Capacity);
      RECT rect; GetWindowRect(hwnd, out rect);
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      string app = ""; try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }
      result.Add(new object[] { hwnd.ToInt64().ToString(), title.ToString(), app, (int)pid, rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top, hwnd == foreground });
      return true;
    }, IntPtr.Zero);
    return result;
  }
  public static void Focus(long id) {
    IntPtr hwnd = new IntPtr(id);
    if (!IsWindowVisible(hwnd)) throw new ArgumentException("not-found");
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
    // Windows only lets the foreground process take focus; a bare Alt tap
    // makes this process count as the last input source.
    Send(Key(0x12, 0, 0), Key(0x12, 0, 0x0002));
    if (!SetForegroundWindow(hwnd)) throw new InvalidOperationException("Windows did not bring that window to the front");
  }
}
`;

/** PowerShell half. The request arrives in an environment variable as JSON,
 * so no model text is ever spliced into script source. */
const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
# Window titles are Unicode; the console default is an OEM code page.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition $env:POLYTH_COMPUTER_CSHARP -ReferencedAssemblies System.Drawing
[PolythComputer]::Init()
$request = $env:POLYTH_COMPUTER_REQUEST | ConvertFrom-Json
function State { $c = [PolythComputer]::Cursor(); @{ screen = @{ width = [PolythComputer]::Width(); height = [PolythComputer]::Height() }; cursor = @{ x = $c[0]; y = $c[1] } } }
function Press($step) {
  for ($r = 0; $r -lt $step.repeat; $r++) {
    foreach ($m in $step.modifiers) { [PolythComputer]::KeyDown($m, $step.extended -contains $m) }
    if ($step.vk -ge 0) { [PolythComputer]::KeyDown($step.vk, $step.extended -contains $step.vk); [PolythComputer]::KeyUp($step.vk, $step.extended -contains $step.vk) }
    [array]::Reverse($step.modifiers); foreach ($m in $step.modifiers) { [PolythComputer]::KeyUp($m, $step.extended -contains $m) }; [array]::Reverse($step.modifiers)
    if ($r + 1 -lt $step.repeat) { Start-Sleep -Milliseconds 60 }
  }
}
function Hold($modifiers, [scriptblock]$body) {
  foreach ($m in $modifiers) { [PolythComputer]::KeyDown($m, $m -eq 0x5b) }
  try { & $body } finally { foreach ($m in $modifiers) { [PolythComputer]::KeyUp($m, $m -eq 0x5b) } }
}
try {
  switch ($request.op) {
    'state' { $result = State }
    'capture' {
      $s = State
      $r = $request.region; if (-not $r) { $r = @{ x = 0; y = 0; width = $s.screen.width; height = $s.screen.height } }
      [PolythComputer]::Capture($r.x, $r.y, $r.width, $r.height, $request.output.width, $request.output.height, $request.path)
      $result = $s
    }
    'perform' {
      $step = $request.step
      switch ($step.kind) {
        'move' { [PolythComputer]::Move($step.to.x, $step.to.y) }
        'click' { Hold $step.modifierKeys { [PolythComputer]::Click($step.at.x, $step.at.y, $step.button, $step.count) } }
        'drag' { Hold $step.modifierKeys { [PolythComputer]::Drag([int[]]($step.path | ForEach-Object { $_.x }), [int[]]($step.path | ForEach-Object { $_.y }), $step.button) } }
        'scroll' { Hold $step.modifierKeys { [PolythComputer]::Scroll($step.at.x, $step.at.y, $step.dx, $step.dy) } }
        'type' { [PolythComputer]::Type($step.text) }
        'key' { Press $step }
      }
      Start-Sleep -Milliseconds 50
      $result = State
    }
    'windows' {
      $result = @([PolythComputer]::Windows() | ForEach-Object { @{ id = $_[0]; title = $_[1]; app = $_[2]; pid = $_[3]; bounds = @{ x = $_[4]; y = $_[5]; width = $_[6]; height = $_[7] }; focused = $_[8] } })
    }
    'focus' { [PolythComputer]::Focus([long]$request.id); $result = @{} }
  }
  [Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 6 -Compress))
} catch {
  $message = $_.Exception.InnerException.Message; if (-not $message) { $message = $_.Exception.Message }
  [Console]::Error.Write("POLYTH_ERROR:" + $message)
  exit 3
}
`;

const ENCODED = Buffer.from(POWERSHELL, "utf16le").toString("base64");

export const windowsRequestStep = (step: InputStep): Record<string, unknown> => {
  const modifierKeys = (modifiers: readonly Modifier[]) => modifiers.map((modifier) => MODIFIER_VK[modifier]);
  switch (step.kind) {
    case "key":
      return { kind: "key", repeat: step.repeat, ...windowsKeyPress(step.chord) };
    case "click":
    case "drag":
    case "scroll":
      return { ...step, modifierKeys: modifierKeys(step.modifiers) };
    default:
      return { ...step };
  }
};

export interface WindowsDriverOptions {
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
}

export function createWindowsDriver(options: WindowsDriverOptions = {}): ComputerDriver {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const powershell = async <T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    try {
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED], {
        env: { ...env, POLYTH_COMPUTER_REQUEST: JSON.stringify(request), POLYTH_COMPUTER_CSHARP: CSHARP },
        ...(signal ? { signal } : {}),
        // Add-Type compiles the helper on every run.
        timeoutMs: 30_000,
      });
      const text = stdout.toString("utf8").trim();
      return (text ? JSON.parse(text) : {}) as T;
    } catch (error) {
      if (!(error instanceof ComputerUseError)) throw error;
      const raised = /POLYTH_ERROR:(.*)$/s.exec(error.message)?.[1]?.trim();
      if (raised === "not-found") throw new ComputerUseError("not-found", "That window is gone; list them again with action \"windows\"");
      if (raised) throw new ComputerUseError("driver-failed", raised);
      throw error;
    }
  };
  return {
    platform: "windows",
    async probe(signal) {
      try {
        await powershell<DesktopState>({ op: "state" }, signal);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    state: (signal) => powershell<DesktopState>({ op: "state" }, signal),
    async capture(request, signal) {
      const dir = await mkdtemp(join(tmpdir(), "polyth-computer-"));
      try {
        const path = join(dir, "capture.png");
        const state = await powershell<DesktopState>({ op: "capture", region: request.region ?? null, output: request.output, path }, signal);
        return { ...state, png: await readFile(path) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    perform: (step, signal) => powershell<DesktopState>({ op: "perform", step: windowsRequestStep(step) }, signal),
    async windows(signal) {
      // ConvertTo-Json may unwrap a one-item list, or print nothing for none.
      const listed = await powershell<DesktopWindow[] | DesktopWindow | Record<string, never>>({ op: "windows" }, signal);
      if (Array.isArray(listed)) return listed;
      return "id" in listed ? [listed as DesktopWindow] : [];
    },
    async focus(id, signal) {
      if (!/^\d+$/.test(id)) throw new ComputerUseError("invalid-input", "window must be an id from action \"windows\"");
      await powershell({ op: "focus", id }, signal);
    },
  };
}
