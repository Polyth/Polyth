import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface ValidatedLocalPath {
  path: string;
  directory: boolean;
}

const accessError = (label: string, path: string, error: unknown): Error => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new Error(`${label} does not exist: ${path}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new Error(`${label} is not accessible: ${path}`);
  }
  return new Error(`${label} could not be checked: ${error instanceof Error ? error.message : String(error)}`);
};

export async function validateAbsoluteLocalPath(
  value: unknown,
  label = "Path",
): Promise<ValidatedLocalPath> {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute local path`);
  }
  const path = resolve(value);

  let details;
  try {
    details = await stat(path);
  } catch (error) {
    throw accessError(label, path, error);
  }

  try {
    await access(path, details.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK);
  } catch (error) {
    throw accessError(label, path, error);
  }

  return { path, directory: details.isDirectory() };
}
