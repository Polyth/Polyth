import type { ComponentType } from "react";

const TestWidget = (props: Record<string, unknown>) => (
  <section data-plugin-widget="test-ui-widget">
    {typeof props.title === "string" ? props.title : "Test UI plugin"}
  </section>
);

export const modules = {
  "test-ui-widget": TestWidget,
} satisfies Record<string, ComponentType<Record<string, unknown>>>;
