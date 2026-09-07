import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RemoteUiAction, RemoteUiNode } from "@polyth/package-sdk";
import {
  Badge,
  Button,
  EmptyState,
  TextInput,
} from "../../components/ui/index.ts";
import { tr } from "../../i18n/index.ts";

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
      return <HostOwnedInput node={node} onAction={onAction} />;
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
      return <div className="polyth-remote-ui-list">{kids}</div>;
    case "listItem":
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

function HostOwnedInput({
  node,
  onAction,
}: {
  node: RemoteUiNode;
  onAction: (action: RemoteUiAction) => void;
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
    onKeyDown: (event: { key: string }) => {
      if (event.key === "Enter") emit(value, true);
    },
  };
  return (
    <TextInput
      uiSize="sm"
      aria-label={node.label ?? node.placeholder ?? tr("packages.plugins.input")}
      {...shared}
    />
  );
}
