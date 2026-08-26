import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import PermissionBanner from "./PermissionBanner.tsx";

export default defineWebPackage((host) => () =>
  host.slots.register({
    slot: "session.timeline.after",
    id: "permissions.requests",
    order: 20,
    render: (context) => createElement(PermissionBanner, {
      permissions: Array.isArray(context.permissions) ? context.permissions : [],
    }),
  }));
