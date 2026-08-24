let pending = "";

export function seedMultiRunPrompt(text: string): void {
  pending = text;
}

export function consumeMultiRunPrompt(): string {
  const value = pending;
  pending = "";
  return value;
}
