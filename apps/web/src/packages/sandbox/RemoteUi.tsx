import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RemoteUiAction, RemoteUiNode } from "@polyth/package-sdk";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Progress,
  Select,
  Separator,
  Spinner,
  Textarea,
  TextInput,
} from "../../components/ui/index.ts";
import { tr } from "../../i18n/index.ts";
import { renderMarkdown } from "../../markdown.tsx";

export function RemoteUiView(props: {
  tree: RemoteUiNode | null;
  onAction: (action: RemoteUiAction) => void;
}): ReactNode {
  if (!props.tree) {
    return (
      <EmptyState
        variant="panel"
        title={tr("packages.plugins.waitingForUi")}
        description={tr("packages.plugins.waitingForUiHint")}
      />
    );
  }
  return (
    <div className="polyth-remote-ui">
      <RemoteNode node={props.tree} onAction={props.onAction} />
    </div>
  );
}

function RemoteNode({ node, onAction }: { node: RemoteUiNode; onAction: (action: RemoteUiAction) => void }) {
  const kids = node.children?.map((child, index) => (
    <RemoteNode key={child.id ?? `${child.type}-${index}`} node={child} onAction={onAction} />
  ));
  const emit = (value?: string | boolean) => {
    if (node.action) onAction({ id: node.action, ...(value !== undefined ? { value } : {}) });
  };
  switch (node.type) {
    case "stack":
      return <div className={`polyth-remote-ui-stack polyth-remote-ui-gap-${node.gap ?? "md"}`}>{kids}</div>;
    case "inline":
      return <div className={`polyth-remote-ui-inline polyth-remote-ui-gap-${node.gap ?? "sm"}`}>{kids}</div>;
    case "text":
      return <p className={`polyth-remote-ui-text${node.tone ? ` is-${node.tone}` : ""}`}>{node.text}</p>;
    case "heading":
      if (node.level === 1) return <h2 className="polyth-remote-ui-heading">{node.text}</h2>;
      if (node.level === 3) return <h4 className="polyth-remote-ui-heading">{node.text}</h4>;
      return <h3 className="polyth-remote-ui-heading">{node.text}</h3>;
    case "button":
      return (
        <Button
          size="sm"
          variant={node.variant === "primary" ? "primary" : node.variant === "danger" ? "danger" : "quiet"}
          disabled={node.disabled}
          onClick={() => emit()}
        >
          {node.label ?? node.text}
        </Button>
      );
    case "input":
      return <HostOwnedTextField node={node} onAction={onAction} multiline={false} />;
    case "textarea":
      return <HostOwnedTextField node={node} onAction={onAction} multiline />;
    case "select":
      return (
        <Select
          label={node.label ?? node.title ?? tr("packages.plugins.input")}
          ariaLabel={node.label ?? node.title ?? tr("packages.plugins.input")}
          value={node.value}
          options={node.options ?? []}
          placeholder={node.placeholder}
          disabled={node.disabled}
          onChange={(value) => emit(value)}
        />
      );
    case "checkbox":
      return (
        <Checkbox
          checked={node.checked ?? false}
          disabled={node.disabled}
          label={node.label ?? node.text ?? ""}
          description={node.subtitle}
          onChange={(checked) => emit(checked)}
        />
      );
    case "radioGroup":
      return <HostOwnedRadioGroup node={node} onAction={onAction} />;
    case "badge":
      return (
        <Badge tone={node.tone === "danger" ? "danger" : node.tone === "success" ? "success" : node.tone === "warning" ? "warning" : node.tone === "info" ? "info" : "neutral"}>
          {node.text ?? node.label}
        </Badge>
      );
    case "card":
      return (
        <article className="polyth-remote-ui-card">
          {node.title && <strong>{node.title}</strong>}
          {node.subtitle && <span className="muted">{node.subtitle}</span>}
          {node.body && <p>{node.body}</p>}
          {kids}
          {node.trailing && <RemoteNode node={node.trailing} onAction={onAction} />}
        </article>
      );
    case "list":
      return <div className="polyth-remote-ui-list" role="list">{kids}</div>;
    case "listItem":
      if (!node.action) {
        return (
          <div className="polyth-remote-ui-item" role="listitem">
            <span>
              <strong>{node.title ?? node.label}</strong>
              {node.subtitle && <small>{node.subtitle}</small>}
            </span>
            {node.trailing && <RemoteNode node={node.trailing} onAction={onAction} />}
          </div>
        );
      }
      return (
        <button
          type="button"
          className="polyth-remote-ui-item"
          disabled={node.disabled}
          onClick={() => emit()}
        >
          <span>
            <strong>{node.title ?? node.label}</strong>
            {node.subtitle && <small>{node.subtitle}</small>}
          </span>
          {node.trailing && <RemoteNode node={node.trailing} onAction={onAction} />}
        </button>
      );
    case "table":
      return <RemoteTable node={node} />;
    case "markdown":
      return (
        <div className="polyth-remote-ui-markdown" dir="auto">
          {renderMarkdown(node.body ?? node.text ?? "", node.id ?? "remote-ui-markdown")}
        </div>
      );
    case "code":
      return (
        <pre className="polyth-remote-ui-code" aria-label={node.label ?? node.title}>
          <code data-language={node.language}>{node.text ?? node.body ?? ""}</code>
        </pre>
      );
    case "progress": {
      const max = node.max && node.max > 0 ? node.max : 1;
      return <Progress value={(node.progress ?? 0) / max} label={node.label ?? node.title ?? tr("common.loading")} />;
    }
    case "spinner":
      return <Spinner label={node.label ?? node.text} />;
    case "separator":
      return <Separator />;
    case "empty":
      return (
        <EmptyState
          variant="compact"
          title={node.title ?? tr("packages.plugins.nothingHere")}
          description={node.body ?? node.subtitle}
        />
      );
    default:
      return null;
  }
}

function HostOwnedTextField({
  node,
  onAction,
  multiline,
}: {
  node: RemoteUiNode;
  onAction: (action: RemoteUiAction) => void;
  multiline: boolean;
}) {
  const [value, setValue] = useState(node.value ?? "");
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionId = node.action;
  useEffect(() => {
    if (!focused.current) setValue(node.value ?? "");
  }, [node.value]);
  useEffect(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [actionId]);
  const emit = (next: string, immediate = false) => {
    if (!actionId) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (immediate) {
      onAction({ id: actionId, value: next });
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      onAction({ id: actionId, value: next });
    }, 150);
  };
  const shared = {
    value,
    placeholder: node.placeholder,
    disabled: node.disabled,
    "aria-label": node.label ?? node.placeholder ?? tr("packages.plugins.input"),
    onChange: (event: { target: { value: string } }) => {
      const next = event.target.value;
      setValue(next);
      emit(next);
    },
    onFocus: () => { focused.current = true; },
    onBlur: () => {
      focused.current = false;
      emit(value, true);
    },
  };
  if (multiline) {
    return (
      <Textarea
        {...shared}
        minRows={3}
        maxRows={10}
        autoGrow
      />
    );
  }
  return (
    <TextInput
      uiSize="sm"
      {...shared}
      onKeyDown={(event) => {
        if (event.key === "Enter") emit(value, true);
      }}
    />
  );
}

function HostOwnedRadioGroup({
  node,
  onAction,
}: {
  node: RemoteUiNode;
  onAction: (action: RemoteUiAction) => void;
}) {
  const name = `remote-ui-${node.id ?? node.action ?? "choice"}`;
  return (
    <fieldset className="polyth-remote-ui-radio" disabled={node.disabled}>
      {node.label && <legend>{node.label}</legend>}
      {(node.options ?? []).map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={node.value === option.value}
            onChange={() => {
              if (node.action) onAction({ id: node.action, value: option.value });
            }}
          />
          <span>{option.label}</span>
          {option.detail && <small>{option.detail}</small>}
        </label>
      ))}
    </fieldset>
  );
}

function RemoteTable({ node }: { node: RemoteUiNode }) {
  if (!node.columns?.length) return null;
  return (
    <div className="polyth-remote-ui-table-wrap">
      <table className="polyth-remote-ui-table">
        <thead>
          <tr>{node.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
        </thead>
        <tbody>
          {(node.rows ?? []).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, columnIndex) => <td key={`${rowIndex}-${columnIndex}`}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
