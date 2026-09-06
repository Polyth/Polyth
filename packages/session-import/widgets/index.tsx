import "./styles.css";
import { useState } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { createApiTransport, defineWebPackage } from "@polyth/web-sdk";
import { Button, Dialog, Notice, Select } from "../../../apps/web/src/components/ui/index.ts";
import { openSession } from "../../../apps/web/src/init.ts";
import { upsertSession } from "../../../apps/web/src/store.ts";
const api = createApiTransport();
type Source = {
    id: string;
    name: string;
    unavailable?: boolean;
    items: Array<{
        ref: string;
        title: string;
    }>;
};
function ImportButton({ projectId }: {
    projectId: string;
}) {
    const [open, setOpen] = useState(false);
    const [sources, setSources] = useState<Source[]>([]);
    const [ref, setRef] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [requestId, setRequestId] = useState("");
    const browse = async () => { setOpen(true); setBusy(true); setError(""); setRef(""); setRequestId(crypto.randomUUID()); try {
        setSources(await api.get<Source[]>(`/api/session-import/sources?projectId=${encodeURIComponent(projectId)}`));
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    const ingest = async () => { setBusy(true); setError(""); try {
        const result = await api.post<SessionProjection>("/api/session-import/snapshot", { projectId, ref, requestId });
        upsertSession(result);
        await openSession(result.id);
        setOpen(false);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    return <div className="pkg-session-import"><Button size="sm" variant="ghost" onClick={() => void browse()}>Import conversation</Button>
    {open && <Dialog title="Import conversation" onClose={() => { if (!busy)
            setOpen(false); }}><div className="pkg-session-import pkg-session-import-dialog">
      <p>Bring a snapshot of an existing conversation into this project. Continue it with any ready harness.</p>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      {!busy && !sources.some((s) => s.items.length) && <Notice>No native conversations are available for this project.</Notice>}
      <Select label="Conversation" value={ref} disabled={busy} options={sources.flatMap((s) => s.items.map((item) => ({ value: item.ref, label: item.title, group: s.name })))} onChange={(value) => { setRef(value); setRequestId(crypto.randomUUID()); }}/>
      {sources.filter((s) => s.unavailable).map((s) => <p key={s.id}>{s.name} is unavailable.</p>)}
      <Button disabled={!ref} busy={busy} onClick={() => void ingest()}>Import snapshot</Button>
    </div></Dialog>}
  </div>;
}
export default defineWebPackage((host) => () => host.slots.register({ id: "session-import.open", slot: "sidebar.project.actions", render: (props) => <ImportButton projectId={String(props.projectId)}/> }));
