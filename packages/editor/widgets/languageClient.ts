import type {
  EditorLanguageCapability,
  EditorLanguageRequest,
  EditorLanguageResponse,
  EditorRenameApplyRequest,
  EditorRenameApplyResponse,
  EditorRenamePreview,
  EditorPosition,
} from "../src/languageTypes.ts";

/** Browser-only transport for the editor package's scoped language routes. */
export async function requestEditorLanguage(
  input: Omit<EditorLanguageRequest, "position"> & { position: EditorPosition; capability: EditorLanguageCapability },
  signal?: AbortSignal,
): Promise<EditorLanguageResponse> {
  const response = await fetch("/api/editor/language", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) throw new Error(`language service request failed (${response.status})`);
  return await response.json() as EditorLanguageResponse;
}

export async function requestEditorRenamePreview(
  input: EditorLanguageRequest & { newName: string },
): Promise<EditorRenamePreview | null> {
  const response = await fetch("/api/editor/language/rename-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`rename preview failed (${response.status})`);
  const payload = await response.json() as { rename?: EditorRenamePreview };
  return payload.rename ?? null;
}

export async function applyEditorRename(input: EditorRenameApplyRequest): Promise<EditorRenameApplyResponse> {
  const response = await fetch("/api/editor/language/rename-apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json() as EditorRenameApplyResponse;
  if (!response.ok && response.status !== 207) throw new Error(`rename failed (${response.status})`);
  return payload;
}
