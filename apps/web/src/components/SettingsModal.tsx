import SettingsView from "./SettingsView.tsx";

export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <SettingsView onClose={onClose} />;
}
