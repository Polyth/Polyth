// The feedback sheet, in three views. The form: what kind of remark it is, the
// person's words in one large field with the screenshot and diagnostics as
// attachments inside it, and two quiet extras (a way to reply, who they are).
// "What the team sees": every part in plain words, then the exact payload for
// anyone who wants it, and the reset of earlier feedback. Thanks: the outcome,
// without the intake's reference number. A part is on the wire exactly when it
// is shown as included;
// the desktop shell or the Polyth server adds the build and sends.
import {
  useEffect, useId, useMemo, useRef, useState,
  type ClipboardEvent, type KeyboardEvent, type ReactNode,
} from "react";
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
import {
  CheckGlyph, ChevronGlyph, ClockGlyph, CloseGlyph, EyeOffGlyph, ImageGlyph, KIND_GLYPHS, LockGlyph,
  PencilGlyph, PersonGlyph, PulseGlyph, ReplyGlyph, ShieldGlyph,
} from "./glyphs.tsx";

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
  /** Blur marks over the private content the captured screenshot shows (the
   *  conversation, the draft, chat and project names); empty when none was
   *  on screen or the image is not this window. */
  privateAreas: Mark[];
  onClose: () => void;
}

type Problem = "rate" | "invalid" | "unavailable" | null;
type View = "form" | "privacy" | "thanks";
/** How a sent feedback ended: with the team, or saved to go later. */
type Sent = "received" | "queued";

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

const PLATFORM_NAMES: Record<string, string> = {
  darwin: "macOS", macos: "macOS", win32: "Windows", windows: "Windows", linux: "Linux",
  ios: "iOS", ipados: "iPadOS", android: "Android", chromeos: "ChromeOS",
};
const platformName = (platform: string) => PLATFORM_NAMES[platform.toLowerCase()] ?? platform;

const isMac = () => typeof navigator !== "undefined"
  && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

/** The passage of the person's text the privacy view quotes. */
const excerpt = (text: string) => (text.length > 90 ? `${text.slice(0, 90).trimEnd()}…` : text);

interface ChoiceProps<T extends string> {
  label: string;
  value: T | null;
  options: readonly T[];
  onPick: (value: T) => void;
  className: string;
  optionClassName: string;
  render: (value: T) => ReactNode;
}

/** A row of mutually exclusive choices: one tab stop, arrows move and pick. */
function Choice<T extends string>({ label, value, options, onPick, className, optionClassName, render }: ChoiceProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabStop = value ?? options[0];
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const forward = event.key === "ArrowDown" || event.key === (rtl ? "ArrowLeft" : "ArrowRight");
    const back = event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft");
    if (!forward && !back) return;
    event.preventDefault();
    const next = (index + (forward ? 1 : -1) + options.length) % options.length;
    const target = options[next];
    refs.current[next]?.focus();
    if (target !== undefined && target !== value) onPick(target);
  };
  return (
    <div className={className} role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option}
          ref={(element) => { refs.current[index] = element; }}
          type="button"
          role="radio"
          aria-checked={value === option}
          tabIndex={option === tabStop ? 0 : -1}
          className={optionClassName}
          onClick={() => onPick(option)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {render(option)}
        </button>
      ))}
    </div>
  );
}

export function ReportSheet({ host, bridge, capture, page, privateAreas, onClose }: ReportSheetProps) {
  const t = (key: BugReportMessageKey, values?: Record<string, string | number>) => host.ui.locale.translate(key, values);
  const { Button, Notice, Textarea, TextInput } = host.ui.components;
  const Dialog = host.ui.components.Dialog;
  const ids = useId();
  const mac = useMemo(isMac, []);
  const [view, setView] = useState<View>("form");
  const [sent, setSent] = useState<Sent | null>(null);
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const [whoOpen, setWhoOpen] = useState(false);
  // The default of a part follows the kind (a bug wants the diagnostics and a
  // screenshot, an idea does not) until the person switches it.
  const [technicalChoice, setTechnicalChoice] = useState<boolean | null>(null);
  const [screenshotChoice, setScreenshotChoice] = useState<boolean | null>(null);
  // "Who I am" is sent when a role is chosen; the profile saved on this
  // computer fills it in, so a returning person sees it already set.
  const saved = capture.base.savedProfile;
  const [role, setRole] = useState<FeedbackRole | null>(saved?.role ?? null);
  const [experience, setExperience] = useState<FeedbackExperience | null>(saved?.experience ?? null);
  const [forgetting, setForgetting] = useState(false);
  const [shot, setShot] = useState(capture.screenshot);
  // Marks are drawn over the unmarked original, so reopening the editor moves
  // them instead of drawing over burnt-in ones; `shot` is what goes.
  const [original, setOriginal] = useState<MarkImage | null>(capture.screenshot);
  const [marks, setMarks] = useState<Mark[]>([]);
  // Private content on the captured screenshot is blurred unless the person
  // turns that off; an image of their own has no known private areas.
  // `hidden` is what `shot` really shows, so a blur still on its way, or
  // one that failed, keeps the screenshot from going sharp.
  const autoBlurs = original === capture.screenshot ? privateAreas : [];
  const [hidePrivate, setHidePrivate] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [blurFailed, setBlurFailed] = useState(false);
  const blurPending = autoBlurs.length > 0 && hidePrivate && !hidden;
  const technicalDefault = kind === "bug" || kind === "pain";
  const withTechnical = technicalChoice ?? technicalDefault;
  const screenshotWanted = shot !== null && (screenshotChoice ?? technicalDefault);
  const withScreenshot = screenshotWanted && !blurPending;
  const [attaching, setAttaching] = useState(false);
  const [attachFailed, setAttachFailed] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const canAttach = typeof bridge.attach === "function";
  const [editing, setEditing] = useState<Mark[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [markFailed, setMarkFailed] = useState(false);
  const canMark = typeof bridge.annotate === "function" && shot !== null && original !== null;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const privacyRef = useRef<HTMLButtonElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const lastView = useRef<View>("form");

  const reply = feedbackContact(contact);
  const contactInvalid = contact.trim() !== "" && reply === "";
  // A contact Send refuses stays in view with its reason.
  const replyShown = replyOpen || contactInvalid;
  const profile = role !== null && experience !== null ? { role, experience } : null;
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

  const canSend = !busy && !attaching && !applying && editing === null && text.trim() !== "" && !contactInvalid;

  // Focus follows the view: its main control when it opens, the way back to
  // the privacy view's link when the person returns to the form.
  useEffect(() => {
    const from = lastView.current;
    lastView.current = view;
    if (view === from) return;
    if (view === "privacy") backRef.current?.focus();
    else if (view === "thanks") doneRef.current?.focus();
    else if (from === "privacy") privacyRef.current?.focus();
  }, [view]);

  const pickRole = (value: FeedbackRole) => {
    if (value === role) {
      setRole(null);
      return;
    }
    setRole(value);
    // A role alone is not a profile; the middle answer is shown chosen, so
    // what goes is always what the person sees.
    if (experience === null) setExperience("sometimes");
  };

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
        setScreenshotChoice(true);
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

  // Burn the blurs and marks in and hand the image to the bridge, which
  // re-encodes it to the wire's limits; the thumbnail then shows exactly what
  // goes.
  const burn = async (nextMarks: Mark[], hide: boolean): Promise<boolean> => {
    if (!original || !bridge.annotate) return false;
    const blurs = hide ? autoBlurs : [];
    setApplying(true);
    try {
      const jpeg = await composeMarked(original, [...blurs, ...nextMarks]);
      const next = jpeg ? await bridge.annotate(capture.captureId, jpeg) : null;
      if (!next) return false;
      setShot(next);
      setMarks(nextMarks);
      setHidden(blurs.length > 0);
      return true;
    } catch {
      return false;
    } finally {
      setApplying(false);
    }
  };

  // Once, as the sheet opens: the private parts of the capture go blurred.
  useEffect(() => {
    if (autoBlurs.length === 0) return;
    void burn([], true).then((done) => setBlurFailed(!done));
  }, []);

  const togglePrivate = async () => {
    const hide = !hidePrivate;
    setHidePrivate(hide);
    setBlurFailed(!(await burn(marks, hide)));
  };

  const applyMarks = async () => {
    if (editing === null) return;
    if (editing === marks) {
      setEditing(null);
      return;
    }
    setMarkFailed(false);
    if (await burn(editing, hidePrivate)) {
      setScreenshotChoice(true);
      setEditing(null);
    } else {
      setMarkFailed(true);
    }
  };

  const finish = (outcome: ReportOutcome) => {
    if (outcome.result === "received" || outcome.result === "queued") {
      setSent(outcome.result);
      setView("thanks");
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
      if (outcome.result === "forgotten") onClose();
    } catch {
      host.notifications?.show({ kind: "error", title: t("bugreport.forgetFailed"), body: "" });
    } finally {
      setForgetting(false);
    }
  };

  // ⌘/Ctrl+Enter sends from anywhere in the form, like the composer.
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const roleLabel = (value: FeedbackRole) => t(`bugreport.role.${value}`);
  const whoLabel = profile
    ? t("bugreport.whoSummary", { role: roleLabel(profile.role), experience: t(`bugreport.experienceShort.${profile.experience}`) })
    : t("bugreport.whoOpen");
  const platform = platformName(capture.base.app.platform);

  // ---- The form ------------------------------------------------------------

  const tray = (
    <div className="bug-report-sheet__tray">
      {shot && screenshotWanted ? (
        <div className="bug-report-sheet__thumb" data-pending={blurPending ? "true" : undefined}>
          <img className="bug-report-sheet__image" src={shot.dataUrl} width={shot.width} height={shot.height} alt={t("bugreport.screenshotAlt")} />
          {canMark && (
            <button type="button" className="bug-report-sheet__thumb-open" title={t(marks.length > 0 ? "bugreport.markEdit" : "bugreport.markUp")} onClick={openEditor}>
              <PencilGlyph size={16} aria-hidden="true" />
              <span className="bug-report-sheet__sr">{t(marks.length > 0 ? "bugreport.markEdit" : "bugreport.markUp")}</span>
            </button>
          )}
          <button type="button" className="bug-report-sheet__thumb-remove" title={t("bugreport.screenshotRemove")} onClick={() => setScreenshotChoice(false)}>
            <CloseGlyph size={10} strokeWidth={2.5} />
            <span className="bug-report-sheet__sr">{t("bugreport.screenshotRemove")}</span>
          </button>
        </div>
      ) : shot || canAttach ? (
        <button
          type="button"
          className="bug-report-chip"
          aria-pressed={false}
          disabled={attaching}
          onClick={() => (shot ? setScreenshotChoice(true) : fileRef.current?.click())}
        >
          <ImageGlyph size={14} />
          <span>{t("bugreport.screenshotAdd")}</span>
        </button>
      ) : null}
      {screenshotWanted && autoBlurs.length > 0 && (
        <button
          type="button"
          className="bug-report-chip"
          aria-pressed={hidePrivate}
          disabled={applying}
          title={t("bugreport.hidePrivateHint")}
          onClick={() => void togglePrivate()}
        >
          {hidePrivate ? <CheckGlyph size={14} className="bug-report-chip__tick" /> : <EyeOffGlyph size={14} />}
          <span>{t("bugreport.hidePrivate")}</span>
        </button>
      )}
      <button
        type="button"
        className="bug-report-chip"
        aria-pressed={withTechnical}
        title={t("bugreport.diagnosticsHint", { errors: page.errors.length })}
        onClick={() => setTechnicalChoice(!withTechnical)}
      >
        {withTechnical ? <CheckGlyph size={14} className="bug-report-chip__tick" /> : <PulseGlyph size={14} />}
        <span>{t("bugreport.diagnostics")}</span>
      </button>
      {canAttach && (
        <button type="button" className="bug-report-sheet__own" disabled={attaching} onClick={() => fileRef.current?.click()}>
          <span className="bug-report-sheet__own-fine">{t("bugreport.pasteHint", { keys: mac ? "⌘V" : "Ctrl+V" })}</span>
          <span className="bug-report-sheet__own-coarse">{t("bugreport.attachOwn")}</span>
        </button>
      )}
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
  );

  const form = (
    <form className="bug-report-sheet" onSubmit={(event) => { event.preventDefault(); void submit(); }} onKeyDown={onKeyDown} onPaste={onPaste}>
      <p className="bug-report-sheet__lead">{t("bugreport.lead")}</p>
      <Choice
        label={t("bugreport.kindLabel")}
        value={kind}
        options={FEEDBACK_KINDS}
        onPick={setKind}
        className="bug-report-kinds"
        optionClassName="bug-report-kind"
        render={(value) => {
          const Glyph = KIND_GLYPHS[value];
          return <><Glyph size={18} /><span className="bug-report-kind__label">{t(`bugreport.kind.${value}`)}</span></>;
        }}
      />
      <div className="bug-report-sheet__compose">
        <div className="bug-report-sheet__well ui-field-well" data-busy={attaching ? "true" : undefined}>
          <Textarea
            className="bug-report-sheet__text"
            aria-label={t("bugreport.textLabel")}
            value={text}
            maxLength={FEEDBACK_LIMITS.textChars}
            minRows={5}
            maxRows={12}
            autoGrow
            placeholder={t(`bugreport.placeholder.${kind}`)}
            onChange={(event) => setText(event.target.value)}
          />
          {tray}
        </div>
        {attachFailed && <p className="bug-report-sheet__error" role="alert">{t("bugreport.attachFailed")}</p>}
        {blurFailed && screenshotWanted && blurPending && <p className="bug-report-sheet__error" role="alert">{t("bugreport.blurFailed")}</p>}
        <div className="bug-report-sheet__extras">
          <button
            type="button"
            className="bug-report-link"
            aria-expanded={replyShown}
            aria-controls={`${ids}-reply`}
            data-set={reply !== "" ? "true" : undefined}
            onClick={() => setReplyOpen(!replyShown)}
          >
            <ReplyGlyph size={14} />
            <span>{reply !== "" ? t("bugreport.replyTo", { contact: reply }) : t("bugreport.replyOpen")}</span>
          </button>
          <button
            type="button"
            className="bug-report-link"
            aria-expanded={whoOpen}
            aria-controls={`${ids}-who`}
            data-set={profile ? "true" : undefined}
            onClick={() => setWhoOpen(!whoOpen)}
          >
            <PersonGlyph size={14} />
            <span>{whoLabel}</span>
          </button>
        </div>
        <div className="bug-report-reveal" id={`${ids}-reply`} data-open={replyShown ? "true" : "false"} inert={!replyShown}>
          <div className="bug-report-reveal__inner">
            <TextInput
              type="text"
              aria-label={t("bugreport.contactLabel")}
              value={contact}
              maxLength={FEEDBACK_LIMITS.contactChars}
              autoComplete="off"
              spellCheck={false}
              invalid={contactInvalid}
              placeholder={t("bugreport.contactPlaceholder")}
              onChange={(event) => setContact(event.target.value)}
            />
            {contactInvalid && <p className="bug-report-sheet__error">{t("bugreport.contactInvalid")}</p>}
          </div>
        </div>
        <div className="bug-report-reveal" id={`${ids}-who`} data-open={whoOpen ? "true" : "false"} inert={!whoOpen}>
          <div className="bug-report-reveal__inner bug-report-sheet__who">
            <span className="bug-report-sheet__question" aria-hidden="true">{t("bugreport.roleLabel")}</span>
            <Choice
              label={t("bugreport.roleLabel")}
              value={role}
              options={FEEDBACK_ROLES}
              onPick={pickRole}
              className="bug-report-sheet__chips"
              optionClassName="bug-report-chip"
              render={(value) => roleLabel(value)}
            />
            <span className="bug-report-sheet__question" aria-hidden="true">{t("bugreport.experienceLabel")}</span>
            <Choice
              label={t("bugreport.experienceLabel")}
              value={experience}
              options={FEEDBACK_EXPERIENCE}
              onPick={setExperience}
              className="bug-report-sheet__chips"
              optionClassName="bug-report-chip"
              render={(value) => t(`bugreport.experience.${value}`)}
            />
          </div>
        </div>
      </div>
      {problem && Notice && (
        <Notice tone={problem === "rate" ? "warning" : "error"} role="alert">{t(`bugreport.${problem}`)}</Notice>
      )}
      {problem && !Notice && <p className="bug-report-sheet__error" role="alert">{t(`bugreport.${problem}`)}</p>}
    </form>
  );

  const formFooter = (
    <>
      <button ref={privacyRef} type="button" className="bug-report-sheet__privacy" onClick={() => setView("privacy")}>
        <LockGlyph size={14} />
        <span>
          {t(known ? "bugreport.known" : "bugreport.anonymous")}
          <span aria-hidden="true"> · </span>
          <span className="bug-report-sheet__privacy-link">{t("bugreport.privacyLink")}</span>
        </span>
      </button>
      {/* The sheet closes from its title bar and with Escape; one action here. */}
      <Button variant="primary" busy={busy} disabled={!canSend} onClick={() => void submit()}>
        {t("bugreport.send")}
        <kbd className="bug-report-sheet__kbd" aria-hidden="true">{mac ? "⌘↵" : "Ctrl ↵"}</kbd>
      </Button>
    </>
  );

  // ---- What the team sees ---------------------------------------------------

  const row = (term: string, value: ReactNode, more?: ReactNode, off = false) => (
    <div className="bug-report-privacy__row">
      <dt>{term}</dt>
      <dd data-off={off ? "true" : undefined}>
        {value}
        {more && <span className="bug-report-privacy__more">{more}</span>}
      </dd>
    </div>
  );

  const trimmed = text.trim();
  const privacy = (
    <div className="bug-report-sheet bug-report-privacy">
      <dl className="bug-report-privacy__rows">
        {row(t("bugreport.row.text"), trimmed ? excerpt(trimmed) : t("bugreport.value.empty"), undefined, !trimmed)}
        {withScreenshot && shot
          ? row(
            t("bugreport.row.screenshot"),
            t("bugreport.value.screenshot", { width: shot.width, height: shot.height }),
            [hidden && autoBlurs.length > 0 ? t("bugreport.value.privateHidden") : "", t(marks.length > 0 ? "bugreport.value.marked" : "bugreport.value.markHint")].filter(Boolean).join(" · "),
          )
          : row(t("bugreport.row.screenshot"), t(shot || canAttach ? "bugreport.value.none" : "bugreport.screenshotMissing"), undefined, true)}
        {withTechnical
          ? row(t("bugreport.row.diagnostics"), t("bugreport.value.diagnostics", { version: capture.base.app.version, platform }), t("bugreport.value.diagnosticsMore", { errors: page.errors.length }))
          : row(t("bugreport.row.diagnostics"), t("bugreport.value.basics", { version: capture.base.app.version }), undefined, true)}
        {row(
          t("bugreport.row.you"),
          profile ? `${roleLabel(profile.role)}, ${t(`bugreport.experienceShort.${profile.experience}`)}` : t("bugreport.anonymous"),
          t(known ? "bugreport.identityKnown" : "bugreport.identityDaily"),
          !profile,
        )}
        {row(t("bugreport.row.reply"), reply !== "" ? reply : t("bugreport.value.noReply"), undefined, reply === "")}
      </dl>
      <p className="bug-report-privacy__never">
        <ShieldGlyph size={16} />
        <span>{t("bugreport.never")}</span>
      </p>
      <details className="bug-report-privacy__details">
        <summary>
          <ChevronGlyph size={14} className="bug-report-privacy__chevron" />
          <span>{t("bugreport.details")}</span>
        </summary>
        <pre className="bug-report-sheet__json">{preview}</pre>
      </details>
      {bridge.forget && (
        <div className="bug-report-privacy__forget">
          <Button size="sm" variant="quiet" busy={forgetting} onClick={() => void forget()}>{t("bugreport.forget")}</Button>
          <span className="bug-report-sheet__hint">{t("bugreport.forgetHint")}</span>
        </div>
      )}
    </div>
  );

  const privacyFooter = (
    <Button ref={backRef} variant="primary" onClick={() => setView("form")}>{t("bugreport.back")}</Button>
  );

  // ---- Thanks ---------------------------------------------------------------

  const received = sent === "received";
  const thanks = (
    <div className="bug-report-thanks" role="status">
      <span className="bug-report-thanks__mark" data-tone={received ? "received" : "queued"}>
        {received ? <CheckGlyph size={24} strokeWidth={2} /> : <ClockGlyph size={24} strokeWidth={2} />}
      </span>
      <h2 className="bug-report-thanks__title">{t(received ? "bugreport.sentTitle" : "bugreport.queuedTitle")}</h2>
      <p className="bug-report-thanks__body">
        {received
          ? (reply !== "" ? t("bugreport.sentReply", { contact: reply }) : t("bugreport.sentBody"))
          : t("bugreport.queuedBody")}
      </p>
      <Button ref={doneRef} className="bug-report-thanks__done" variant="primary" onClick={onClose}>{t("bugreport.done")}</Button>
    </div>
  );

  // ---- Mark-up editor, then the sheet's dialog --------------------------------

  const editorFooter = (
    <>
      <Button variant="quiet" disabled={applying} onClick={closeEditor}>{t("bugreport.cancel")}</Button>
      <Button variant="primary" busy={applying} onClick={() => void applyMarks()}>{t("bugreport.markDone")}</Button>
    </>
  );

  if (editing !== null && original) {
    const editor = (
      <div className="bug-report-editor-body">
        <ScreenshotEditor host={host} t={t} image={original} marks={editing} fixed={hidePrivate ? autoBlurs : []} onMarksChange={setEditing} />
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

  const body = view === "privacy" ? privacy : view === "thanks" ? thanks : form;
  // The outcome is one centred card: no title bar and no footer, so the space
  // above its mark and below its button is the same.
  const footer = view === "privacy" ? privacyFooter : view === "thanks" ? null : formFooter;
  const title = view === "thanks"
    ? t(received ? "bugreport.sentTitle" : "bugreport.queuedTitle")
    : t(view === "privacy" ? "bugreport.privacyTitle" : "bugreport.sheetTitle");
  // Escape or the close button on the privacy view returns to the form, so
  // the words already written are never lost on the way.
  const close = view === "privacy" ? () => setView("form") : onClose;

  if (Dialog) {
    return (
      <Dialog
        title={title}
        onClose={close}
        size="md"
        className={`bug-report-dialog bug-report-dialog--${view}`}
        initialFocus="textarea.bug-report-sheet__text"
        hideHeader={view === "thanks"}
        footer={footer}
      >
        {body}
      </Dialog>
    );
  }
  const Legacy = host.ui.Dialog;
  return (
    <Legacy title={title} onClose={close} size="md" className={`bug-report-dialog bug-report-dialog--${view}`} initialFocus="textarea.bug-report-sheet__text">
      {body}
      {footer && <div className="bug-report-sheet__actions">{footer}</div>}
    </Legacy>
  );
}
