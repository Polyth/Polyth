import type { GitlabMessageKey } from "./en.ts";
export const uk: Partial<Record<GitlabMessageKey, string>> = {
  remoteChanged: "Remote репозиторію змінився. Відкрийте Git, щоб налаштувати обліковий запис.",
  skipIdentity: "Лише Git transport",
  configureAfterOpen: "Налаштувати GitLab після відкриття",
  continue: "Продовжити",
  title: "GitLab", connected: "Облікові записи: {count}", notConnected: "Не підключено", description: "Задачі, merge request і конвеєри", check: "Перевірити", remove: "Видалити", instance: "Інстанс GitLab", username: "Ім’я користувача", authentication: "Автентифікація", glabLogin: "Наявний вхід glab", personalToken: "Персональний токен доступу", accessToken: "Токен доступу", signIn: "Увійдіть через glab auth login --hostname {host} --web або --device, якщо підтримується. Облікові дані залишаються у glab.", addAccount: "Додати обліковий запис", repositoryRemote: "Віддалений репозиторій", connect: "Підключити", manage: "Керувати обліковими записами…", anotherInstance: " (інший інстанс)", hostingIdentity: "Ідентифікатор Hosting API. Автор комітів і Git транспорт налаштовуються окремо.", identityTitle: "Обліковий запис Hosting API; автор комітів і Git транспорт налаштовуються окремо.", connectedStatus: "Підключено", cloneIdentity: "Налаштувати GitLab для цього клонування", selectAccount: "Виберіть обліковий запис GitLab для цього репозиторію",
};
