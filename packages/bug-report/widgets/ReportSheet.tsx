// The feedback sheet: what kind of remark it is, the person's words, and one
// switch per optional part (technical details, screenshot, "About me", a way
// to reply) with every byte that will go shown before anything is sent. A
// part is on the wire exactly when its switch is on. The desktop shell or the
// Polyth server adds the build and sends.
import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { BugReportError, BugReportPackage, BugReportSettingValue, BugReportWeb } from "@polyth/contracts/bug-report";
import {
  FEEDBACK_EXPERIENCE, FEEDBACK_KINDS, FEEDBACK_LIMITS, FEEDBACK_ROLES,
  type FeedbackExperience, type FeedbackKind, type FeedbackRole,
} from "@polyth/contracts/feedback";
import type { BugReportMessageKey } from "../src/i18n/en.ts";
import { feedbackContact } from "../src/snapshot.ts";
import type { Mark } from "../src/annotate.ts";
import type { ReportBridge, ReportCapture, ReportDraft, ReportOutcome } from "./bridge.ts";
import { ScreenshotEditor, composeMarked, type MarkImage } from "./ScreenshotEditor.tsx";

export interface PageReport {
  web: BugReportWeb;
  settings: Record<string, BugReportSettingValue>;
  packages: BugReportPackage[];
  errors: BugReportError[];
}

export interface ReportSheetProps {
  host: WebPackageHost;
  bridge: ReportBridge;
  capture: ReportCapture;
  page: PageReport;
  onClose: () => void;
}

type Problem = "rate" | "invalid" | "unavailable" | null;

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function ReportSheet({ host, bridge, capture, page, onClose }: ReportSheetProps) {
  const t = (key: BugReportMessageKey, values?: Record<string, string | number>) => host.ui.locale.translate(key, values);
  const { Button, Checkbox, Notice, Select, Textarea, TextInput } = host.ui.components;
  const EditIcon = host.ui.iconSet?.EditIcon;
  const Dialog = host.ui.components.Dialog;
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  // The default of a part follows the kind (a bug wants the technical details
  // and a screenshot, an idea does not) until the person switches it.
  const [technicalChoice, setTechnicalChoice] = useState<boolean | null>(null);
  const [screenshotChoice, setScreenshotChoice] = useState<boolean | null>(null);
  const saved = capture.base.savedProfile;
  const [withProfile, setWithProfile] = useState(saved !== null);
  const [role, setRole] = useState<FeedbackRole>(saved?.role ?? "other");
  const [experience, setExperience] = useState<FeedbackExperience>(saved?.experience ?? "sometimes");
  const [forgetting, setForgetting] = useState(false);
  const [shot, setShot] = useState(capture.screenshot);
  const technicalDefault = kind === "bug" || kind === "pain";
  const withTechnical = technicalChoice ?? technicalDefault;
  const withScreenshot = shot !== null && (screenshotChoice ?? technicalDefault);
  const setWithScreenshot = (value: boolean) => setScreenshotChoice(value);
  const [attaching, setAttaching] = useState(false);
  const [attachFailed, setAttachFailed] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const canAttach = typeof bridge.attach === "function";
  // Marks are drawn over the unmarked original, so reopening the editor moves
  // them instead of drawing over burnt-in ones; `shot` is what goes.
  const [original, setOriginal] = useState<MarkImage | null>(capture.screenshot);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [editing, setEditing] = useState<Mark[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [markFailed, setMarkFailed] = useState(false);
  const canMark = typeof bridge.annotate === "function" && shot !== null && original !== null;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  
  const reply = feedbackContact(contact);
  const profile = withProfile ? { role, experience } : null;
  const technical = withTechnical
    ? { web: page.web, settings: page.settings, packages: page.packages, errors: page.errors }
    : null;

  const draft = (): ReportDraft => ({
    kind,
    text: text.trim(),
    contact: reply,
    captureId: withScreenshot && shot ? capture.captureId : null,
    technical,
    profile,
  });

  // Exactly what goes, minus the image bytes. The pseudonym is the stable one
  // only when the person chose to be known (a profile or a way to reply).
  const known = profile !== null || reply !== "";
  const preview = useMemo(() => JSON.stringify({
    kind,
    text: text.trim(),
    install: known ? capture.base.installPerson : capture.base.installDaily,
    contact: reply,
    basics: {
      version: capture.base.app.version,
      channel: capture.base.app.channel,
      edition: capture.base.app.edition,
      locale: capture.base.app.locale,
    },
    technical: technical
      ? { app: capture.base.app, web: technical.web, settings: { ...technical.settings, ...capture.base.settings }, packages: technical.packages, errors: technical.errors }
      : null,
    profile,
    screenshot: withScreenshot && shot
      ? `image/jpeg ${shot.width}×${shot.height}, ${kb(shot.bytes)}`
      : null,
  }, null, 2), [capture, kind, text, known, reply, technical, profile, shot, withScreenshot]);

  const canSend = !busy && !attaching && editing === null && text.trim() !== "" && (contact.trim() === "" || reply !== "");

  const attach = async (file: Blob) => {
    if (!bridge.attach) return;
    setAttaching(true);
    setAttachFailed(false);
    try {
      const next = await bridge.attach(capture.captureId, file);
      if (next) {
        setShot(next);
        setOriginal(next);
        setMarks([]);
        setWithScreenshot(true);
      } else {
        setAttachFailed(true);
      }
    } catch {
      setAttachFailed(true);
    } finally {
      setAttaching(false);
    }
  };

  // A pasted image becomes the screenshot; pasted text goes where it always does.
  const onPaste = (event: ClipboardEvent<HTMLFormElement>) => {
    if (!canAttach) return;
    const image = [...event.clipboardData.items].find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
    if (!image) return;
    event.preventDefault();
    void attach(image);
  };

  const openEditor = () => {
    if (!canMark) return;
    setMarkFailed(false);
    setEditing(marks);
  };

  const closeEditor = () => {
    if (applying) return;
    setEditing(null);
    setMarkFailed(false);
  };

  // Burn the marks in and hand the image to the bridge, which re-encodes it
  // to the wire's limits; the preview then shows exactly what goes.
  const applyMarks = async () => {
    if (editing === null || !original || !bridge.annotate) return;
    if (editing === marks) {
      setEditing(null);
      return;
    }
    setApplying(true);
    setMarkFailed(false);
    try {
      const jpeg = await composeMarked(original, editing);
      const next = jpeg ? await bridge.annotate(capture.captureId, jpeg) : null;
      if (!next) {
        setMarkFailed(true);
        return;
      }
      setShot(next);
      setMarks(editing);
      setWithScreenshot(true);
      setEditing(null);
    } catch {
      setMarkFailed(true);
    } finally {
      setApplying(false);
    }
  };

  const finish = (outcome: ReportOutcome) => {
    if (outcome.result === "received") {
      host.notifications?.show({ kind: "success", title: t("bugreport.sentTitle"), body: t("bugreport.sentBody", { ref: outcome.ref }) });
      onClose();
      return;
    }
    if (outcome.result === "queued") {
      host.notifications?.show({ kind: "info", title: t("bugreport.queuedTitle"), body: t("bugreport.queuedBody") });
      onClose();
      return;
    }
    setProblem(outcome.result);
  };

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setProblem(null);
    try {
      finish(await bridge.send(draft()));
    } catch {
      setProblem("invalid");
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!bridge.forget || forgetting) return;
    setForgetting(true);
    try {
      const outcome = await bridge.forget();
      host.notifications?.show(outcome.result === "forgotten"
        ? { kind: "success", title: t("bugreport.forgottenTitle"), body: t("bugreport.forgottenBody", { count: outcome.count }) }
        : { kind: "error", title: t("bugreport.forgetFailed"), body: "" });
      if (outcome.result === "forgotten") {
        setWithProfile(false);
        onClose();
      }
    } catch {
      host.notifications?.show({ kind: "error", title: t("bugreport.forgetFailed"), body: "" });
    } finally {
      setForgetting(false);
    }
  };

  // ⌘/Ctrl+Enter sends from anywhere in the sheet, like the composer.
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const footer = (
    <>
      <Button variant="quiet" onClick={onClose}>{t("bugreport.cancel")}</Button>
      <Button variant="primary" busy={busy} disabled={!canSend} onClick={() => void submit()}>{t("bugreport.send")}</Button>
    </>
  );

  const editorFooter = (
    <>
      <Button variant="quiet" disabled={applying} onClick={closeEditor}>{t("bugreport.cancel")}</Button>
      <Button variant="primary" busy={applying} onClick={() => void applyMarks()}>{t("bugreport.markDone")}</Button>
    </>
  );

  const body = (
    <form className="bug-report-sheet" onSubmit={(event) => { event.preventDefault(); void submit(); }} onKeyDown={onKeyDown} onPaste={onPaste}>
      <p className="bug-report-sheet__intro">{t("bugreport.intro")}</p>
      <div className="bug-report-sheet__kinds" role="group" aria-label={t("bugreport.kindLabel")}>
        {FEEDBACK_KINDS.map((value) => (
          <Button key={value} size="sm" variant={kind === value ? "primary" : "quiet"} aria-pressed={kind === value} onClick={() => setKind(value)}>
            {t(`bugreport.kind.${value}`)}
          </Button>
        ))}
      </div>
      <label className="bug-report-sheet__field">
        <span className="bug-report-sheet__label">{t("bugreport.textLabel")}</span>
        <Textarea
          className="bug-report-sheet__text"
          value={text}
          maxLength={FEEDBACK_LIMITS.textChars}
          minRows={3}
          maxRows={10}
          autoGrow
          placeholder={t(`bugreport.placeholder.${kind}`)}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className="bug-report-sheet__attachments">
        {shot ? (
          <div className="bug-report-sheet__shot">
            <img
              className="bug-report-sheet__image"
              data-included={withScreenshot ? "true" : "false"}
              src={shot.dataUrl}
              width={shot.width}
              height={shot.height}
              alt={t("bugreport.screenshotAlt")}
            />
            {/* The whole thumbnail opens the editor; the labelled button below is its keyboard twin. */}
            {canMark && <button type="button" className="bug-report-sheet__shot-open" tabIndex={-1} aria-hidden="true" onClick={openEditor} />}
          </div>
        ) : null}
        <div className="bug-report-sheet__toggles">
          {shot
            ? <Checkbox checked={withScreenshot} onChange={setWithScreenshot} label={t(canAttach ? "bugreport.screenshotBrowser" : "bugreport.screenshot")} />
            : <p className="bug-report-sheet__note">{t(canAttach ? "bugreport.attachHint" : "bugreport.screenshotMissing")}</p>}
          {(canAttach || canMark) && (
            <div className="bug-report-sheet__attach">
              {canMark && (
                <Button size="sm" {...(EditIcon ? { iconStart: EditIcon } : {})} onClick={openEditor}>
                  {t(marks.length > 0 ? "bugreport.markEdit" : "bugreport.markUp")}
                </Button>
              )}
              {canAttach && <Button size="sm" busy={attaching} onClick={() => fileRef.current?.click()}>
                {t(shot ? "bugreport.replace" : "bugreport.attach")}
              </Button>}
              <input
                ref={fileRef}
                className="bug-report-sheet__file"
                type="file"
                accept="image/*"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void attach(file);
                }}
              />
            </div>
          )}
          {attachFailed && <p className="bug-report-sheet__error" role="alert">{t("bugreport.attachFailed")}</p>}
          <Checkbox
            checked={withTechnical}
            onChange={setTechnicalChoice}
            label={t("bugreport.technical")}
            description={t("bugreport.technicalHint", { errors: page.errors.length })}
          />
        </div>
      </div>
      <div className="bug-report-sheet__about">
        <Checkbox checked={withProfile} onChange={setWithProfile} label={t("bugreport.profile")} description={t("bugreport.profileHint")} />
        {withProfile && (
          <div className="bug-report-sheet__row" data-columns="2">
            <div className="bug-report-sheet__field">
              <span className="bug-report-sheet__label">{t("bugreport.roleLabel")}</span>
              <Select
                label={t("bugreport.roleLabel")}
                value={role}
                options={FEEDBACK_ROLES.map((value) => ({ value, label: t(`bugreport.role.${value}`) }))}
                onChange={(value) => setRole(value as FeedbackRole)}
              />
            </div>
            <div className="bug-report-sheet__field">
              <span className="bug-report-sheet__label">{t("bugreport.experienceLabel")}</span>
              <Select
                label={t("bugreport.experienceLabel")}
                value={experience}
                options={FEEDBACK_EXPERIENCE.map((value) => ({ value, label: t(`bugreport.experience.${value}`) }))}
                onChange={(value) => setExperience(value as FeedbackExperience)}
              />
            </div>
          </div>
        )}
      </div>
      <label className="bug-report-sheet__field">
        <span className="bug-report-sheet__label">{t("bugreport.contactLabel")}</span>
        <TextInput
          type="text"
          value={contact}
          maxLength={FEEDBACK_LIMITS.contactChars}
          autoComplete="off"
          spellCheck={false}
          invalid={contact.trim() !== "" && reply === ""}
          placeholder="name@example.com"
          onChange={(event) => setContact(event.target.value)}
        />
      </label>
      <p className="bug-report-sheet__hint">{t(known ? "bugreport.identityKnown" : "bugreport.identityDaily")}</p>
      <details className="bug-report-sheet__details">
        <summary>{t("bugreport.details")}</summary>
        <pre className="bug-report-sheet__json">{preview}</pre>
      </details>
      {bridge.forget && (
        <div className="bug-report-sheet__forget">
          <Button size="sm" variant="quiet" busy={forgetting} onClick={() => void forget()}>{t("bugreport.forget")}</Button>
          <span className="bug-report-sheet__hint">{t("bugreport.forgetHint")}</span>
        </div>
      )}
      {problem && Notice && (
        <Notice tone={problem === "rate" ? "warning" : "error"} role="alert">{t(`bugreport.${problem}`)}</Notice>
      )}
      {problem && !Notice && <p className="bug-report-sheet__error" role="alert">{t(`bugreport.${problem}`)}</p>}
    </form>
  );

  if (editing !== null && original) {
    const editor = (
      <div className="bug-report-editor-body">
        <ScreenshotEditor host={host} t={t} image={original} marks={editing} onMarksChange={setEditing} />
        {markFailed && <p className="bug-report-sheet__error" role="alert">{t("bugreport.markFailed")}</p>}
      </div>
    );
    if (Dialog) {
      return (
        <Dialog title={t("bugreport.markTitle")} onClose={closeEditor} size="full" className="bug-report-dialog bug-report-dialog--editor" footer={editorFooter}>
          {editor}
        </Dialog>
      );
    }
    const Legacy = host.ui.Dialog;
    return (
      <Legacy title={t("bugreport.markTitle")} onClose={closeEditor} size="full" className="bug-report-dialog bug-report-dialog--editor">
        {editor}
        <div className="bug-report-sheet__actions">{editorFooter}</div>
      </Legacy>
    );
  }

  if (Dialog) {
    return (
      <Dialog title={t("bugreport.title")} onClose={onClose} size="md" className="bug-report-dialog" initialFocus="textarea.bug-report-sheet__text" footer={footer}>
        {body}
      </Dialog>
    );
  }
  const Legacy = host.ui.Dialog;
  return (
    <Legacy title={t("bugreport.title")} onClose={onClose} size="md" className="bug-report-dialog" initialFocus="textarea.bug-report-sheet__text">
      {body}
      <div className="bug-report-sheet__actions">{footer}</div>
    </Legacy>
  );
}
