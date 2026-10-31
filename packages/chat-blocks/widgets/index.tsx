import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type MarkdownFenceRendererProps } from "@polyth/web-sdk";
import ChatBlock from "./ChatBlock.tsx";
import PageBlock from "./PageBlock.tsx";

/** Fence languages this package renders: `ui` blocks and `page` HTML pages. */
export const CHAT_BLOCK_FENCES = ["ui", "page"] as const;

export default defineWebPackage((host) => () => {
  if (!host.markdown) return () => {};
  const Renderer = (props: MarkdownFenceRendererProps) =>
    createElement(props.lang === "page" ? PageBlock : ChatBlock, { ...props, host });
  return host.markdown.registerFence({ languages: CHAT_BLOCK_FENCES, component: Renderer });
});
