// P1-W2 core UI primitives — the design-system component surface.
// New core UI and (during Phase 1c) package widgets compose these instead of
// minting bespoke button/menu/dialog classes. Usage guide:
// docs/ui-redesign/design-system.md
export { default as Button, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button.tsx";
export { default as IconButton, type IconButtonProps, type IconButtonVariant, type IconButtonSize } from "./IconButton.tsx";
export { default as Icon, type IconProps, type IconSize } from "./Icon.tsx";
export * from "./icons.ts";
export { default as TextInput, type TextInputProps } from "./TextInput.tsx";
export { default as Textarea, type TextareaProps } from "./Textarea.tsx";
export { default as Checkbox, type CheckboxProps } from "./Checkbox.tsx";
export { default as Switch, type SwitchProps } from "./Switch.tsx";
export { default as Select, type SelectProps, type SelectOption } from "./Select.tsx";
export { default as Badge, type BadgeProps, type BadgeTone } from "./Badge.tsx";
export { default as Separator, type SeparatorProps } from "./Separator.tsx";
export { default as Spinner, type SpinnerProps, type SpinnerSize } from "./Spinner.tsx";
export { default as Progress, type ProgressProps } from "./Progress.tsx";
export { default as Skeleton, type SkeletonProps } from "./Skeleton.tsx";
export { default as VisuallyHidden } from "./VisuallyHidden.tsx";
export { default as Tabs, TabPanel, tabId, tabPanelId, type TabsProps, type TabItem, type TabPanelProps } from "./Tabs.tsx";
export { default as Tooltip, type TooltipProps } from "./Tooltip.tsx";
export { default as Popover, type PopoverProps } from "./Popover.tsx";
export { default as Menu, type MenuProps, type MenuEntry, type MenuAction, type MenuTriggerProps } from "./Menu.tsx";
export { default as Dialog, type DialogProps, type DialogSize } from "./Dialog.tsx";
export { default as ResponsiveOverlay, type ResponsiveOverlayProps } from "./ResponsiveOverlay.tsx";
export {
  useAnchoredPosition,
  type AnchoredPosition,
  type AnchoredPositionOptions,
  type AnchoredAlign,
  type AnchoredSide,
} from "./useAnchoredPosition.ts";

// Canonical primitives that already lived elsewhere, re-exported so ui/ is
// the one import surface. Sheet stays the phone overlay engine; the a11y
// Dialog module stays the modal focus/scroll-lock engine; alerts stay the
// confirm/prompt strategy.
export { default as EmptyState, type EmptyStateVariant } from "../EmptyState.tsx";
export { default as Sheet, SheetRow, SheetSection, type SheetProps, type SheetSearch, type SheetRowProps } from "../mobile/Sheet.tsx";
export { useModalSurface, useModalScrollLock } from "../a11y/Dialog.tsx";
export { useDismissibleMenu } from "../a11y/Menu.ts";
export { confirmAlert, promptAlert } from "../../alerts.ts";
