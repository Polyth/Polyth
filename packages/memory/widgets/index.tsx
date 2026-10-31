import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import MemorySettings from "./MemorySettings.tsx";

export default defineWebPackage((host) => () => {
  const unregister = host.projectSettings.register({
    id: "memory",
    order: 30,
    label: host.ui.locale.translate("memory.name"),
    description: host.ui.locale.translate("memory.description"),
    icon: "brain",
    visible: () => true,
    render: ({ projectId, project, mobile, onBack, onClose }) => (
      <MemorySettings
        projectId={projectId}
        project={project}
        mobile={mobile}
        locale={host.ui.locale.get()}
        translate={host.ui.locale.translate}
        onBack={onBack}
        onClose={onClose}
      />
    ),
  });
  return unregister;
});
