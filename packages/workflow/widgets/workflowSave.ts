/** Guards asynchronous workflow persistence from crossing project/editor scope. */
export function shouldApplyWorkflowSave(
  responseScope: string,
  currentScope: string
): boolean {
  return responseScope === currentScope;
}

/** A response may replace the draft only when no newer local edit exists. */
export function shouldAdoptWorkflowSnapshot(
  responseScope: string,
  currentScope: string,
  responseEditVersion: number,
  currentEditVersion: number
): boolean {
  return (
    shouldApplyWorkflowSave(responseScope, currentScope) &&
    responseEditVersion === currentEditVersion
  );
}
