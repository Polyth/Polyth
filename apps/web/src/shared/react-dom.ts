// ReactDOM is CommonJS, so its browser shim needs explicit ESM exports.
import * as ReactDOM from "react-dom";

const runtime = ReactDOM as typeof ReactDOM & Record<string, unknown>;

export const {
  __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
  createPortal,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  requestFormReset,
  unstable_batchedUpdates,
  useFormState,
  useFormStatus,
  version,
} = runtime;

export default ReactDOM;
