// ReactDOM client is CommonJS, so its browser shim needs explicit ESM exports.
import * as ReactDOMClient from "react-dom/client";

const runtime = ReactDOMClient as typeof ReactDOMClient & Record<string, unknown>;

export const {
  createRoot,
  hydrateRoot,
  version,
} = runtime;

export default ReactDOMClient;
