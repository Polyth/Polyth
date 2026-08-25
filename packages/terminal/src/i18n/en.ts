/**
 * Canonical English messages owned by the terminal package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "terminalview.clearTerminal": "Clear terminal",
  "terminalview.clearTerminalShortcut": "Clear terminal (Ctrl+Shift+K)",
  "terminalview.closeValue": "Close {title}",
  "terminalview.closeSearch": "Close search",
  "terminalview.closeSearchShortcut": "Close (Escape)",
  "terminalview.connected": "Connected",
  "terminalview.connecting": "Connecting",
  "terminalview.copy": "Copy",
  "terminalview.disconnected": "Disconnected",
  "terminalview.doubleClickToRename": "Double-click to rename",
  "terminalview.exited": "·exited",
  "terminalview.find": "Find",
  "terminalview.findInTerminal": "Find in terminal",
  "terminalview.findInTerminalShortcut": "Find in terminal (Ctrl+Shift+F)",
  "terminalview.matchCase": "Match case",
  "terminalview.newTerminal": "New terminal",
  "terminalview.newOutput": "New output",
  "terminalview.nextMatch": "Next match",
  "terminalview.nextMatchShortcut": "Next match (Enter)",
  "terminalview.noProjectSelected": "No project selected",
  "terminalview.noTerminalYet": "No terminal yet",
  "terminalview.openLinkShortcut": "{url} — Ctrl/Cmd+click to open",
  "terminalview.openAProjectToUseTheTerminal": "Open a project to use the terminal.",
  "terminalview.openAShellInTheProjectFolder": "Open a shell in the project folder.",
  "terminalview.openTerminal": "Open Terminal",
  "terminalview.openTerminalShortcut": "Open Terminal ({shortcut})",
  "terminalview.paste": "Paste",
  "terminalview.previousMatch": "Previous match",
  "terminalview.previousMatchShortcut": "Previous match (Shift+Enter)",
  "terminalview.processExited": "process exited",
  "terminalview.processExitedCodeValue": "process exited (code {code})",
  "terminalview.reconnecting": "Reconnecting",
  "terminalview.scrollToBottomShortcut": "Scroll to bottom (Ctrl+Shift+End)",
  "terminalview.selectAll": "Select all",
  "terminalview.shellValue": "shell · {value}",
  "terminalview.statusDoubleClickToRename": "{status} · double-click to rename",
  "terminalview.terminalTabName": "Terminal tab name",
  "terminalview.terminalValue": "Terminal {title}",
  "terminalview.useRegularExpression": "Use regular expression",
} as const;

export type TerminalMessageKey = keyof typeof en;
export type TerminalMessages = Record<TerminalMessageKey, string>;
