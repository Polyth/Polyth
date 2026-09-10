const en = {
  "hosting.askAgent": "Review with agent", "hosting.investigate": "Investigate with agent",
  "hosting.ready": "Mark ready", "hosting.unapprove": "Unapprove",
  "hosting.threads": "Discussions", "hosting.reply": "Reply", "hosting.resolve": "Resolve", "hosting.reopen": "Reopen",
  "hosting.replyPlaceholder": "Reply to this discussion…", "hosting.lineHeading": "Comment on a line",
  "hosting.file": "File path", "hosting.line": "Line", "hosting.right": "New version", "hosting.left": "Old version",
  "hosting.lineComment": "Line comment", "hosting.addLineComment": "Add line comment",
  "hosting.internal": "Internal", "hosting.access": "Repository access",
  "hosting.readRepository": "Read Git repository", "hosting.pushRepository": "Push Git repository",
  "hosting.readApi": "Read hosting API", "hosting.writeIssues": "Write issues",
  "hosting.writeChanges": "Write change requests", "hosting.review": "Review and approve",
  "hosting.available": "Verified", "hosting.unknown": "Checked when requested", "hosting.denied": "Unavailable",
  "hosting.git-transport": "Git transport credentials",
} as const;
const uk: Record<keyof typeof en, string> = {
  "hosting.askAgent": "Перевірити з агентом", "hosting.investigate": "Дослідити з агентом",
  "hosting.ready": "Позначити готовим", "hosting.unapprove": "Скасувати схвалення",
  "hosting.threads": "Обговорення", "hosting.reply": "Відповісти", "hosting.resolve": "Вирішено", "hosting.reopen": "Відкрити знову",
  "hosting.replyPlaceholder": "Відповідь в обговоренні…", "hosting.lineHeading": "Коментар до рядка",
  "hosting.file": "Шлях до файлу", "hosting.line": "Рядок", "hosting.right": "Нова версія", "hosting.left": "Попередня версія",
  "hosting.lineComment": "Коментар", "hosting.addLineComment": "Додати коментар",
  "hosting.internal": "Внутрішній", "hosting.access": "Доступ до репозиторію",
  "hosting.readRepository": "Читання Git", "hosting.pushRepository": "Push у Git",
  "hosting.readApi": "Читання API", "hosting.writeIssues": "Зміна задач",
  "hosting.writeChanges": "Зміна запитів", "hosting.review": "Перевірка та схвалення",
  "hosting.available": "Перевірено", "hosting.unknown": "Перевіряється під час дії", "hosting.denied": "Недоступно",
  "hosting.git-transport": "Облікові дані Git transport",
};
export function hostingMessage(locale: string, key: string): string | undefined {
  return (locale === "uk" ? uk : en)[key as keyof typeof en];
}
