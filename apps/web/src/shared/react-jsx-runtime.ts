// Explicit re-export of React JSX runtime for ESM import map
import * as jsxRuntime from "react/jsx-runtime";

export const { jsx, jsxs, Fragment } = jsxRuntime;
export default jsxRuntime;
