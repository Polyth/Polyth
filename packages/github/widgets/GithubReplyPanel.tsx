import { useEffect, useRef, useState } from "react";
import type { SessionEvent } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { MarkdownDoc } from "../../../apps/web/src/markdown.tsx";
import { buildModel } from "../../../apps/web/src/reduce.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { AssistIcon, Button, SendIcon, Textarea } from "../../../apps/web/src/components/ui/index.ts";

export interface GithubReplyContext {
  kind: "issue" | "pr";
  number: number;
  title: string;
  body: string;
  url: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
}

type AgentState = "idle" | "working" | "ready" | "publishing" | "published" | "error";

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function agentPrompt(context: GithubReplyContext, request: string): string {
  const label = context.kind === "pr" ? "pull request" : "issue";
  const conversation = context.comments.length === 0
    ? "(No comments yet.)"
    : context.comments.map((comment) =>
      `### ${comment.author}${comment.createdAt ? ` — ${comment.createdAt}` : ""}\n${comment.body}`,
    ).join("\n\n");
  return [
    `Draft a helpful GitHub comment for the following ${label}.`,
    "Return only the publishable comment in Markdown. Do not include analysis, preambles, or quotation fences.",
    "",
    `## ${label} #${context.number}: ${context.title}`,
    `URL: ${context.url}`,
    "",
    "### Description",
    context.body || "(No description provided.)",
    "",
    "### Conversation",
    conversation,
    "",
    "### User request",
    request,
  ].join("\n");
}

function latestAssistant(events: readonly SessionEvent[]): { text: string; finalized: boolean } | null {
  const assistants = buildModel(events).messages.filter((message) => message.kind === "assistant");
  return assistants.at(-1) ?? null;
}

export default function GithubReplyPanel({
  projectId,
  context,
  onPublished,
}: {
  projectId: string;
  context: GithubReplyContext;
  onPublished: () => void | Promise<void>;
}) {
  const alive = useRef(true);
  const run = useRef(0);
  const [draft, setDraft] = useState("");
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [agentText, setAgentText] = useState("");
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [publishingDraft, setPublishingDraft] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      run.current += 1;
    };
  }, []);

  const publish = async (text: string, sessionId?: string) => {
    const result = await api.githubAddComment(context.kind, context.number, {
      projectId,
      body: text,
      ...(sessionId ? { sessionId } : {}),
    });
    if (!result.ok) throw new Error(result.reason);
    // Publishing succeeded even if the best-effort conversation refresh does
    // not; never encourage a duplicate GitHub comment by reporting otherwise.
    void Promise.resolve(onPublished()).catch(() => {});
  };

  const publishDraft = async () => {
    const text = draft.trim();
    if (!text || publishingDraft) return;
    setPublishingDraft(true);
    setNotice("");
    setNoticeError(false);
    try {
      await publish(text);
      setDraft("");
      setNotice(tr("githubreply.commentPublished"));
    } catch (cause) {
      setNoticeError(true);
      setNotice(friendlyError(tr("githubreply.publishFailed"), cause));
    } finally {
      setPublishingDraft(false);
    }
  };

  const askAgent = async () => {
    const request = draft.trim();
    if (!request || agentState === "working") return;
    const thisRun = ++run.current;
    setAgentState("working");
    setAgentText("");
    setAgentSessionId(null);
    setNotice("");
    setNoticeError(false);
    try {
      const session = await api.createSession({
        projectId,
        title: `GitHub ${context.kind === "pr" ? "PR" : "issue"} #${context.number} reply`,
      });
      if (!alive.current || thisRun !== run.current) return;
      setAgentSessionId(session.id);
      await api.sendMessage(session.id, { text: agentPrompt(context, request) });
      let afterSeq = 0;
      const events: SessionEvent[] = [];
      for (let attempt = 0; attempt < 180; attempt += 1) {
        if (!alive.current || thisRun !== run.current) return;
        const next = await api.getEvents(session.id, afterSeq);
        if (next.length > 0) {
          events.push(...next);
          afterSeq = next.at(-1)?.seq ?? afterSeq;
          const assistant = latestAssistant(events);
          if (assistant?.text) setAgentText(assistant.text);
          if (assistant?.finalized && assistant.text.trim()) {
            setAgentState("ready");
            return;
          }
          const failed = next.find((event) => event.type === "turn/failed");
          if (failed) throw new Error(String(failed.data.error ?? tr("githubreply.agentFailed")));
        }
        await pause(1_000);
      }
      throw new Error(tr("githubreply.agentTimedOut"));
    } catch (cause) {
      if (!alive.current || thisRun !== run.current) return;
      setAgentState("error");
      setNoticeError(true);
      setNotice(friendlyError(tr("githubreply.agentFailed"), cause));
    }
  };

  const publishAgentReply = async () => {
    const text = agentText.trim();
    if (!text || agentState !== "ready") return;
    setAgentState("publishing");
    setNotice("");
    setNoticeError(false);
    try {
      await publish(text, agentSessionId ?? undefined);
      setAgentState("published");
      setNotice(tr("githubreply.agentReplyPublished"));
    } catch (cause) {
      setAgentState("ready");
      setNoticeError(true);
      setNotice(friendlyError(tr("githubreply.publishFailed"), cause));
    }
  };

  const agentVisible = agentState !== "idle";
  return (
    <section className={`gh-reply-panel${agentVisible ? " agent-open" : ""}`}>
      <div className="gh-reply-heading">
        <div>
          <strong>{tr("githubreply.replyOnGithub")}</strong>
          <span className="muted">{tr("githubreply.chooseHowToContinue")}</span>
        </div>
        <span className="tag">#{context.number}</span>
      </div>
      <Textarea
        rows={4}
        value={draft}
        placeholder={tr("githubreply.writeReplyOrInstructions")}
        aria-label={tr("githubreply.replyDraft")}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="gh-reply-actions">
        <Button
          size="sm"
          iconStart={AssistIcon}
          busy={agentState === "working"}
          disabled={!draft.trim() || publishingDraft || agentState === "working"}
          onClick={() => void askAgent()}
        >
          {agentState === "working" ? tr("githubreply.agentWorking") : tr("githubreply.sendToAgent")}
        </Button>
        <span className="header-spacer" />
        <Button size="sm" variant="primary" iconStart={SendIcon} busy={publishingDraft} disabled={!draft.trim()} onClick={() => void publishDraft()}>
          {publishingDraft ? tr("githubreply.publishing") : tr("githubreply.publish")}
        </Button>
      </div>

      <div className="gh-agent-drawer" aria-hidden={!agentVisible}>
        <div className="gh-agent-drawer-inner">
          <header>
            <span className={`gh-agent-orb ${agentState === "working" ? "working" : ""}`} aria-hidden="true" />
            <div>
              <strong>{tr("githubreply.agentReply")}</strong>
              <span className="muted">
                {agentState === "working" ? tr("githubreply.agentHasFullContext") : tr("githubreply.reviewBeforePublishing")}
              </span>
            </div>
          </header>
          {agentState === "working" && !agentText && (
            <div className="gh-agent-thinking" role="status">
              <i /><i /><i /><span>{tr("githubreply.draftingResponse")}</span>
            </div>
          )}
          {agentText && (
            <div className="gh-agent-response markdown-body" aria-live="polite">
              <MarkdownDoc text={agentText} keyBase={`github-agent-${context.kind}-${context.number}`} />
            </div>
          )}
          {(agentState === "ready" || agentState === "publishing") && (
            <div className="gh-agent-send">
              <span className="muted">{tr("githubreply.publishesAgentResponse")}</span>
              <Button size="sm" variant="primary" iconStart={SendIcon} busy={agentState === "publishing"} onClick={() => void publishAgentReply()}>
                {agentState === "publishing" ? tr("githubreply.publishing") : tr("githubreply.send")}
              </Button>
            </div>
          )}
        </div>
      </div>
      {notice && <div className={noticeError ? "form-error" : "knowledge-notice"} role="status">{notice}</div>}
    </section>
  );
}
