// The report sheet: the screenshot taken when the key was pressed (in a
// browser: this tab, or an image the person pastes or attaches), an optional
// note, and every byte that will go, shown before anything is sent. The
// desktop shell or the Polyth server adds the build and sends; this sheet
// never sees the stored tester password, only what the person types once.
import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { BugReportError, BugReportPackage, BugReportSettingValue, BugReportWeb } from "@polyth/contracts/bug-report";
import { BUG_REPORT_LIMITS } from "@polyth/contracts/bug-report";
import type { BugReportMessageKey } from "../src/i18n/en.ts";
import { contactName } from "../src/snapshot.ts";
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

type Problem = "rate" | "version" | "invalid" | "unavailable" | null;

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function ReportSheet({ host, bridge, capture, page, onClose }: ReportSheetProps) {
  const t = (key: BugReportMessageKey, values?: Record<string, string | number>) => host.ui.locale.translate(key, values);
  const { Button, Checkbox, Notice, Textarea, TextInput } = host.ui.components;
  const EditIcon = host.ui.iconSet?.EditIcon;
  const Dialog = host.ui.components.Dialog;
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(capture.needsPassword);
  const [passwordWrong, setPasswordWrong] = useState(false);
  const [shot, setShot] = useState(capture.screenshot);
  const [withScreenshot, setWithScreenshot] = useState(capture.screenshot !== null);
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
  const [withErrors, setWithErrors] = useState(page.errors.length > 0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const draft = (): ReportDraft => ({
    captureId: withScreenshot && shot ? capture.captureId : null,
    text: text.trim(),
    contact: contactName(contact),
    web: page.web,
    settings: page.settings,
    packages: page.packages,
    errors: withErrors ? page.errors : [],
    ...(needsPassword && password.trim() ? { password: password.trim() } : {}),
  });

  // Exactly what goes, minus the image bytes and the password.
  const preview = useMemo(() => JSON.stringify({
    app: capture.base.app,
    install: capture.base.install,
    web: page.web,
    settings: { ...page.settings, ...capture.base.settings },
    packages: page.packages,
    errors: withErrors ? page.errors : [],
    text: text.trim(),
    contact: contactName(contact),
    screenshot: withScreenshot && shot
      ? `image/jpeg ${shot.width}×${shot.height}, ${kb(shot.bytes)}`
      : null,
  }, null, 2), [capture, page, shot, withErrors, withScreenshot, text, contact]);

  const canSend = !busy && !attaching && editing === null && (!needsPassword || password.trim() !== "");

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
    if (outcome.result === "created" || outcome.result === "added") {
      host.notifications?.show({
        kind: "success",
        title: t("bugreport.sentTitle"),
        body: t(outcome.result === "created" ? "bugreport.sentBody" : "bugreport.addedBody", { issue: outcome.issue }),
      });
      onClose();
      return;
    }
    if (outcome.result === "queued") {
      host.notifications?.show({ kind: "info", title: t("bugreport.queuedTitle"), body: t("bugreport.queuedBody") });
      onClose();
      return;
    }
    if (outcome.result === "password") {
      setPasswordWrong(needsPassword && password.trim() !== "");
      setNeedsPassword(true);
      setPassword("");
      queueMicrotask(() => passwordRef.current?.focus());
      return;
    }
    setProblem(outcome.result);
  };

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setProblem(null);
    setPasswordWrong(false);
    try {
      finish(await bridge.send(draft()));
    } catch {
      setProblem("invalid");
    } finally {
      setBusy(false);
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
      <label className="bug-report-sheet__field">
        <span className="bug-report-sheet__label">{t("bugreport.textLabel")}</span>
        <Textarea
          className="bug-report-sheet__text"
          value={text}
          maxLength={BUG_REPORT_LIMITS.textChars}
          minRows={3}
          maxRows={10}
          autoGrow
          placeholder={t("bugreport.textPlaceholder")}
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
          {page.errors.length > 0 && (
            <Checkbox checked={withErrors} onChange={setWithErrors} label={t("bugreport.errors", { count: page.errors.length })} />
          )}
        </div>
      </div>
      <div className="bug-report-sheet__row" data-columns={needsPassword ? "2" : "1"}>
        <label className="bug-report-sheet__field">
          <span className="bug-report-sheet__label">{t("bugreport.contactLabel")}</span>
          <TextInput
            value={contact}
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
            placeholder="octocat"
            onChange={(event) => setContact(event.target.value)}
          />
        </label>
        {needsPassword && (
          <label className="bug-report-sheet__field">
            <span className="bug-report-sheet__label">{t("bugreport.passwordLabel")}</span>
            <TextInput
              ref={passwordRef}
              type="password"
              value={password}
              maxLength={BUG_REPORT_LIMITS.passwordChars}
              autoComplete="off"
              invalid={passwordWrong}
              aria-describedby="bug-report-password-hint"
              onChange={(event) => { setPassword(event.target.value); setPasswordWrong(false); }}
            />
          </label>
        )}
      </div>
      {needsPassword && (
        <p id="bug-report-password-hint" className={passwordWrong ? "bug-report-sheet__error" : "bug-report-sheet__hint"} role={passwordWrong ? "alert" : undefined}>
          {t(passwordWrong ? "bugreport.passwordWrong"
            : capture.passwordStorage === "session" ? "bugreport.passwordHintSession"
              : capture.passwordStorage === "server" ? "bugreport.passwordHintServer" : "bugreport.passwordHint")}
        </p>
      )}
      <details className="bug-report-sheet__details">
        <summary>{t("bugreport.details")}</summary>
        <pre className="bug-report-sheet__json">{preview}</pre>
      </details>
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
