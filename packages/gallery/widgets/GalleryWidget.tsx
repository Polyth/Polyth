import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ComponentType } from "react";
import type { JsonObject, ModelDescriptor, RuntimeFeaturesDto } from "@polyth/contracts";
import { effectiveAttachmentSupport, harnessModels } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import ModelPicker from "@polyth/models/model-picker";
import type { WebPackageHost, WidgetRenderContext } from "@polyth/web-sdk";
import {
  GALLERY_DEFAULT_INSTRUCTION,
  GALLERY_MAX_ATTACHMENTS,
  buildGalleryMessage,
  normalizeGalleryPath,
  type GalleryAnnotation,
  type GalleryImage,
} from "../src/shared.ts";
import type { AnnotationTool } from "./AnnotationLayer.tsx";
import { GalleryGrid } from "./GalleryGrid.tsx";
import { GalleryLightbox } from "./GalleryLightbox.tsx";
import { createGalleryTranslate } from "./galleryI18n.ts";
import { galleryAttachment, newClientOperationId } from "./galleryApi.ts";
import { loadAnnotations, saveAnnotations, type AnnotationsByImage } from "./galleryState.ts";
import { useGalleryImages } from "./useGalleryImages.ts";

interface GalleryWidgetProps extends WidgetRenderContext {
  host: WebPackageHost;
}

const modelKeyOf = (model: Pick<ModelDescriptor, "providerID" | "modelID">): string => `${model.providerID}::${model.modelID}`;

export function GalleryWidget({ host, projectId, sessionId, editing, config, updateConfig }: GalleryWidgetProps) {
  const t = createGalleryTranslate(host.ui.locale.get());

  const folder = useMemo(() => {
    const raw = typeof config.folder === "string" ? config.folder : "";
    return normalizeGalleryPath(raw) ?? "";
  }, [config.folder]);
  const recursive = config.recursive !== false;

  const [reloadToken, setReloadToken] = useState(0);
  const { listing, loading, error } = useGalleryImages(projectId, sessionId, folder, recursive, reloadToken);

  const [byImage, setByImage] = useState<AnnotationsByImage>(() => loadAnnotations(projectId));
  useEffect(() => {
    setByImage(loadAnnotations(projectId));
  }, [projectId]);
  useEffect(() => {
    saveAnnotations(projectId, byImage);
  }, [projectId, byImage]);

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("off");
  const [instruction, setInstruction] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [sendError, setSendError] = useState("");

  const [catalog, setCatalog] = useState<ModelDescriptor[]>([]);
  const [runtimeFeatures, setRuntimeFeatures] = useState<RuntimeFeaturesDto | null>(null);

  useEffect(() => {
    let current = true;
    api.listModels()
      .then((models) => { if (current) setCatalog(models); })
      .catch(() => { if (current) setCatalog([]); });
    return () => { current = false; };
  }, [projectId]);

  useEffect(() => {
    if (!sessionId) {
      setRuntimeFeatures(null);
      return;
    }
    let current = true;
    api.runtimeFeatures(sessionId)
      .then((features) => { if (current) setRuntimeFeatures(features); })
      .catch(() => { if (current) setRuntimeFeatures(null); });
    return () => { current = false; };
  }, [sessionId]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const session = sessionId ? host.sessions.get(sessionId) : undefined;
  const harnessId = session?.resolvedHarnessId;

  const imageModels = useMemo(() => {
    const forHarness = harnessModels(catalog, harnessId);
    if (!runtimeFeatures) return forHarness;
    const harnessImage = runtimeFeatures.attachmentSupport.image;
    if (harnessImage === "unsupported") return [];
    const harnessCapabilities = {
      ...runtimeFeatures.capabilities,
      attachments: { modalities: runtimeFeatures.attachmentSupport },
    };
    return forHarness.filter((model) => {
      const support = effectiveAttachmentSupport(
        harnessCapabilities,
        model.capabilities,
        runtimeFeatures.remote === true,
        runtimeFeatures.materializeAvailable === true,
      );
      const level = support.image;
      return level === undefined ? harnessImage === undefined : level === "native" || level === "emulated";
    });
  }, [catalog, harnessId, runtimeFeatures]);

  const storedModelKey = typeof config.modelKey === "string" ? config.modelKey : "";
  const effectiveModel = useMemo(() => {
    const stored = imageModels.find((model) => modelKeyOf(model) === storedModelKey);
    if (stored) return stored;
    const sessionModel = session?.model
      ? imageModels.find((model) => model.providerID === session.model?.providerID && model.modelID === session.model?.modelID)
      : undefined;
    return sessionModel ?? imageModels[0];
  }, [imageModels, storedModelKey, session?.model]);

  const images = listing?.images ?? [];
  const activeIndex = activePath ? images.findIndex((image) => image.path === activePath) : -1;
  const activeImage = activeIndex >= 0 ? images[activeIndex] : undefined;
  const activeAnnotations = activeImage ? byImage[activeImage.path] ?? [] : [];

  const rawUrl = useCallback(
    (path: string) => (projectId ? api.filesRawUrl(projectId, path, sessionId ?? undefined) : ""),
    [projectId, sessionId],
  );

  const toggleSelect = useCallback((path: string) => {
    setSelectedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const addAnnotation = useCallback((annotation: GalleryAnnotation) => {
    const path = activeImage?.path;
    if (!path) return;
    setByImage((previous) => ({
      ...previous,
      [path]: [...(previous[path] ?? []), annotation],
    }));
    setActiveAnnotationId(annotation.id);
  }, [activeImage?.path]);

  const updateComment = useCallback((id: string, comment: string) => {
    const path = activeImage?.path;
    if (!path) return;
    setByImage((previous) => ({
      ...previous,
      [path]: (previous[path] ?? []).map((annotation) =>
        annotation.id === id ? { ...annotation, comment } : annotation),
    }));
  }, [activeImage?.path]);

  const deleteAnnotation = useCallback((id: string) => {
    const path = activeImage?.path;
    if (!path) return;
    setByImage((previous) => {
      const remaining = (previous[path] ?? []).filter((annotation) => annotation.id !== id);
      const next = { ...previous };
      if (remaining.length > 0) next[path] = remaining;
      else delete next[path];
      return next;
    });
    setActiveAnnotationId((current) => (current === id ? null : current));
  }, [activeImage?.path]);

  const closeLightbox = useCallback(() => {
    setActivePath(null);
    setActiveAnnotationId(null);
    setTool("off");
  }, []);

  const openImage = useCallback((path: string) => {
    setActivePath(path);
    setActiveAnnotationId(null);
    setTool("off");
  }, []);

  const navigate = useCallback((nextIndex: number) => {
    const image = images[nextIndex];
    if (!image) return;
    setActivePath(image.path);
    setActiveAnnotationId(null);
  }, [images]);

  const toSend = useMemo(() => {
    const annotated = images.filter((image) => (byImage[image.path]?.length ?? 0) > 0);
    const selected = images.filter((image) => selectedPaths.has(image.path));
    const seen = new Set<string>();
    const merged: GalleryImage[] = [];
    for (const image of [...annotated, ...selected]) {
      if (seen.has(image.path)) continue;
      seen.add(image.path);
      merged.push(image);
    }
    return merged;
  }, [images, byImage, selectedPaths]);

  const overflow = toSend.length > GALLERY_MAX_ATTACHMENTS;
  const attached = toSend.slice(0, GALLERY_MAX_ATTACHMENTS);

  const send = useCallback(async () => {
    if (!projectId) return;
    if (attached.length === 0) {
      setSendError(t("gallery.selectToSend"));
      return;
    }
    setSendError("");
    const messageImages = attached.map((image) => ({
      path: image.path,
      name: image.name,
      annotations: byImage[image.path] ?? [],
    }));
    const text = buildGalleryMessage({
      folder,
      instruction: instruction.trim() || GALLERY_DEFAULT_INSTRUCTION,
      images: messageImages,
    });

    if (!sessionId) {
      host.conversation.startNewSession(projectId, { draft: text });
      const modelHarnessId = effectiveModel?.harnessId ?? harnessId;
      if (effectiveModel && modelHarnessId) {
        host.executionDraft.update(projectId, {
          model: {
            harnessId: modelHarnessId,
            providerID: effectiveModel.providerID,
            modelID: effectiveModel.modelID,
          },
        });
      }
      setNotice(t("gallery.seedDraft"));
      return;
    }

    setSending(true);
    try {
      const attachments = attached.map((image) => galleryAttachment({
        projectId,
        sessionId,
        path: image.path,
        name: image.name,
        mime: image.mime,
        size: image.size,
      }));
      // A busy session queues the review behind the current turn instead of
      // racing it; an idle session admits it normally.
      const busy = session?.status === "working" || session?.status === "waiting";
      await api.sendMessage(sessionId, {
        text,
        attachments,
        clientOperationId: newClientOperationId(),
        ...(busy ? { delivery: "queue" } : {}),
        ...(effectiveModel
          ? { model: { providerID: effectiveModel.providerID, modelID: effectiveModel.modelID } as JsonObject }
          : {}),
      });
      setNotice(t("gallery.sent"));
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [projectId, sessionId, attached, byImage, folder, instruction, effectiveModel, harnessId, host, session?.status, t]);

  const changeFolder = useCallback((next: string) => {
    setActivePath(null);
    setSelectedPaths(new Set());
    updateConfig({ ...config, folder: next });
  }, [config, updateConfig]);

  const selectAllVisible = useCallback(() => {
    setSelectedPaths(new Set(images.map((image) => image.path)));
  }, [images]);
  const clearSelection = useCallback(() => setSelectedPaths(new Set()), []);

  const { Button, Checkbox, EmptyState, IconButton, Menu, Textarea } = host.ui.components;
  const icons = host.ui.icons;

  if (!projectId) {
    return (
      <div className="gallery-widget" data-editing={editing || undefined}>
        <div className="gallery-center"><EmptyState title={t("gallery.title")} description={t("gallery.chooseProject")} /></div>
      </div>
    );
  }

  const folderOptions = listing?.folders ?? [];
  const parent = folder !== "" ? listing?.parent ?? null : null;
  const folderEntries = [
    ...(folder !== "" ? [{ id: "root", label: t("gallery.projectRoot"), icon: icons.home, onSelect: () => changeFolder("") }] : []),
    ...(parent !== null && parent !== "" ? [{ id: "up", label: t("gallery.back"), icon: icons.back, onSelect: () => changeFolder(parent) }] : []),
    ...(folder !== "" && folderOptions.length > 0 ? ["separator" as const] : []),
    ...folderOptions.map((entry) => ({ id: `folder:${entry.path}`, label: entry.name, icon: icons.files, onSelect: () => changeFolder(entry.path) })),
  ];
  const TriggerButton = Button as unknown as ComponentType<Record<string, unknown>>;

  return (
    <div className={`gallery-widget${editing ? " is-editing" : ""}`} data-editing={editing || undefined}>
      <div className="gallery-toolbar">
        <Menu label={t("gallery.folderPicker")} entries={folderEntries}>
          {(trigger) => (
            <TriggerButton
              {...trigger}
              className="gallery-folder-trigger"
              size="sm"
              variant="ghost"
              iconStart={icons.files}
              iconEnd={icons.chevronDown}
              title={folder || t("gallery.projectRoot")}
              disabled={editing || folderEntries.length === 0}
            >
              <span className="gallery-folder-label">{folder || t("gallery.projectRoot")}</span>
            </TriggerButton>
          )}
        </Menu>
        <span className="gallery-count">{t("gallery.count", { count: images.length })}</span>
        <IconButton icon={icons.refresh} label={t("gallery.refresh")} size="sm" variant="quiet" disabled={editing} onClick={() => setReloadToken((value) => value + 1)} />
        <Checkbox
          className="gallery-recursive"
          checked={recursive}
          disabled={editing}
          label={t("gallery.recursive")}
          onChange={(checked: boolean) => updateConfig({ ...config, recursive: checked })}
        />
      </div>

      <div className="gallery-scroll">
        {loading && <p className="gallery-status" role="status">{t("gallery.loading")}</p>}
        {!loading && error && (
          <div className="gallery-center">
            <EmptyState title={t("gallery.error")} description={error} actionLabel={t("gallery.refresh")} onAction={() => setReloadToken((value) => value + 1)} />
          </div>
        )}
        {!loading && !error && images.length === 0 && (
          <div className="gallery-center">
            <EmptyState title={t("gallery.empty")} description={t("gallery.emptyHint")} />
          </div>
        )}
        {!loading && !error && images.length > 0 && (
          <GalleryGrid
            images={images}
            rawUrl={rawUrl}
            annotationsByImage={byImage}
            selectedPaths={selectedPaths}
            onOpen={openImage}
            onToggleSelect={toggleSelect}
            t={t}
          />
        )}
        {listing?.truncated && images.length > 0 && (
          <p className="gallery-status">{t("gallery.truncated", { count: images.length })}</p>
        )}
      </div>

      <div className="gallery-send">
        <div className="gallery-send-row">
          <Textarea
            className="gallery-instruction"
            value={instruction}
            placeholder={t("gallery.instructionPlaceholder")}
            aria-label={t("gallery.instruction")}
            autoGrow
            minRows={2}
            maxRows={6}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setInstruction(event.target.value)}
          />
          <div className="gallery-model">
            <span>{t("gallery.model")}</span>
            <ModelPicker
              models={imageModels}
              {...(effectiveModel
                ? { value: { providerID: effectiveModel.providerID, modelID: effectiveModel.modelID, ...(effectiveModel.harnessId ? { harnessId: effectiveModel.harnessId } : {}) } }
                : {})}
              {...(imageModels[0]
                ? { recommended: { providerID: imageModels[0].providerID, modelID: imageModels[0].modelID } }
                : {})}
              direction="up"
              onPick={(picked) => {
                if (picked) updateConfig({ ...config, modelKey: modelKeyOf(picked) });
              }}
            />
          </div>
        </div>
        <div className="gallery-send-actions">
          <Button size="sm" variant="quiet" iconStart={icons.select} disabled={images.length === 0} onClick={selectAllVisible}>{t("gallery.select")}</Button>
          {selectedPaths.size > 0 && <IconButton icon={icons.close} label={t("gallery.clearSelection")} size="sm" variant="quiet" onClick={clearSelection} />}
          <span className="gallery-attach-count">
            {t("gallery.selected", { count: selectedPaths.size })} · {t("gallery.attachCount", { count: attached.length })}
          </span>
          <Button
            size="sm"
            variant="primary"
            iconStart={icons.send}
            busy={sending}
            onClick={() => void send()}
            disabled={sending || attached.length === 0 || imageModels.length === 0}
            {...(!sessionId ? { title: t("gallery.noSession") } : {})}
          >
            {sending ? t("gallery.sending") : t("gallery.send")}
          </Button>
        </div>
        {overflow && <p className="gallery-status">{t("gallery.attachOverflow", { count: GALLERY_MAX_ATTACHMENTS })}</p>}
        {catalog.length > 0 && imageModels.length === 0 && <p className="gallery-status">{t("gallery.modelOtherHarness")}</p>}
        {!sessionId && <p className="gallery-status">{t("gallery.noSession")}</p>}
        {notice && <p className="gallery-status is-ok" role="status">{notice}</p>}
        {sendError && <p className="gallery-status is-error" role="alert">{sendError}</p>}
      </div>

      {activeIndex >= 0 && activeImage && (
        <GalleryLightbox
          images={images}
          index={activeIndex}
          onIndex={navigate}
          rawUrl={rawUrl}
          annotations={activeAnnotations}
          activeAnnotationId={activeAnnotationId}
          onSelectAnnotation={setActiveAnnotationId}
          tool={tool}
          onTool={setTool}
          selected={selectedPaths.has(activeImage.path)}
          onToggleSelected={toggleSelect}
          onAddAnnotation={addAnnotation}
          onUpdateComment={updateComment}
          onDeleteAnnotation={deleteAnnotation}
          onClose={closeLightbox}
          host={host}
          t={t}
        />
      )}
    </div>
  );
}
