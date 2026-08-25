#!/usr/bin/env python3
"""Build complete Polyth locale catalogs from the canonical English catalog.

Existing polyth translations seed shared product terminology. Remaining
Polyth-specific copy is translated with locally installed Argos models, with
placeholder preservation and a small locale glossary for UI terminology.
"""

from __future__ import annotations

import html
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import ctranslate2
import requests
from argostranslate import settings
from argostranslate import translate


ROOT = Path(__file__).resolve().parent.parent
LOCALES = ROOT / "apps" / "web" / "src" / "i18n" / "locales"
polyth = Path("/home/ubuntu/.local/lib/node_modules/@polyth/web/dist/assets")
ENTRY = re.compile(r'^\s*"([^"]+)":\s*("(?:[^"\\]|\\.)*"),?$', re.MULTILINE)
BUNDLE_ENTRY = re.compile(r'"((?:[^"\\]|\\.)+)":("(?:[^"\\]|\\.)*")')
PLACEHOLDER = re.compile(r"\{(\w+)\}")
TECHNICAL_TERM = re.compile(
    r"\b(?:Polyth|OpenCode|GitHub|Git|MCP|API|CLI|SSH|LLM|JSON|Markdown|"
    r"worktrees?|stashes?|commits?|branches?|diffs?|pull requests?|prompts?|"
    r"tokens?|starters?|widgets?|plugins?|stage|unstage|fork|drop|cron)\b",
    re.IGNORECASE,
)

TARGETS = {
    "uk": ("uk", "uk", "uk"),
    "de": ("de", "de", "de"),
    "fr": ("fr", "fr", "fr"),
    "pl": ("pl", "pl", "pl"),
    "pt-BR": ("pt", "ptBR", "pt-BR"),
    "it": ("it", "it", "it"),
    "es": ("es", "es", "es"),
    "zh-CN": ("zh", "zhCN", "zh-CN"),
    "bg": ("bg", "bg", "bg"),
    "ar": ("ar", "ar", "ar"),
    "pt": ("pt", "pt", "pt-PT"),
}

polyth_CODES = {
    "uk": "uk",
    "de": "de",
    "fr": "fr",
    "pl": "pl",
    "pt-BR": "pt-BR",
    "es": "es",
    "zh-CN": "zh-CN",
}

EXACT_TRANSLATIONS = {
    "uk": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("Активний|Додати|Застосувати|Архівувати|Назад|Скасувати|Закрити|Продовжити|Копіювати|Створити|Видалити|Готово|Редагувати|Помилка|Завантаження…|Керувати|Більше|Новий|Далі|Ні|Немає|Відкрити|Призупинити|Оновити|Перезавантажити|Вилучити|Перейменувати|Скинути|Відновити|Продовжити|Повторити|Запустити|Зберегти|Збережено|Збереження…|Пошук|Вибрати|Налаштування|Пропустити|Почати|Зупинити|Надіслати|Недоступно|Оновити|Так").split("|"),
        strict=True,
    )),
    "de": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("Aktiv|Hinzufügen|Anwenden|Archivieren|Zurück|Abbrechen|Schließen|Fortfahren|Kopieren|Erstellen|Löschen|Fertig|Bearbeiten|Fehler|Wird geladen…|Verwalten|Mehr|Neu|Weiter|Nein|Keine|Öffnen|Pausieren|Aktualisieren|Neu laden|Entfernen|Umbenennen|Zurücksetzen|Wiederherstellen|Fortsetzen|Erneut versuchen|Ausführen|Speichern|Gespeichert|Wird gespeichert…|Suchen|Auswählen|Einstellungen|Überspringen|Starten|Stoppen|Senden|Nicht verfügbar|Aktualisieren|Ja").split("|"),
        strict=True,
    )),
    "fr": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("Actif|Ajouter|Appliquer|Archiver|Retour|Annuler|Fermer|Continuer|Copier|Créer|Supprimer|Terminé|Modifier|Erreur|Chargement…|Gérer|Plus|Nouveau|Suivant|Non|Aucun|Ouvrir|Mettre en pause|Actualiser|Recharger|Retirer|Renommer|Réinitialiser|Restaurer|Reprendre|Réessayer|Exécuter|Enregistrer|Enregistré|Enregistrement…|Rechercher|Sélectionner|Paramètres|Ignorer|Démarrer|Arrêter|Envoyer|Indisponible|Mettre à jour|Oui").split("|"),
        strict=True,
    )),
    "pl": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("Aktywne|Dodaj|Zastosuj|Archiwizuj|Wstecz|Anuluj|Zamknij|Kontynuuj|Kopiuj|Utwórz|Usuń|Gotowe|Edytuj|Błąd|Wczytywanie…|Zarządzaj|Więcej|Nowy|Dalej|Nie|Brak|Otwórz|Wstrzymaj|Odśwież|Wczytaj ponownie|Usuń|Zmień nazwę|Resetuj|Przywróć|Wznów|Spróbuj ponownie|Uruchom|Zapisz|Zapisano|Zapisywanie…|Szukaj|Wybierz|Ustawienia|Pomiń|Rozpocznij|Zatrzymaj|Wyślij|Niedostępne|Aktualizuj|Tak").split("|"),
        strict=True,
    )),
    "pt-BR": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("Ativo|Adicionar|Aplicar|Arquivar|Voltar|Cancelar|Fechar|Continuar|Copiar|Criar|Excluir|Concluído|Editar|Erro|Carregando…|Gerenciar|Mais|Novo|Avançar|Não|Nenhum|Abrir|Pausar|Atualizar|Recarregar|Remover|Renomear|Redefinir|Restaurar|Retomar|Tentar novamente|Executar|Salvar|Salvo|Salvando…|Pesquisar|Selecionar|Configurações|Pular|Iniciar|Parar|Enviar|Indisponível|Atualizar|Sim").split("|"),
        strict=True,
    )),
    "it": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("Attivo|Aggiungi|Applica|Archivia|Indietro|Annulla|Chiudi|Continua|Copia|Crea|Elimina|Fatto|Modifica|Errore|Caricamento…|Gestisci|Altro|Nuovo|Avanti|No|Nessuno|Apri|Metti in pausa|Aggiorna|Ricarica|Rimuovi|Rinomina|Reimposta|Ripristina|Riprendi|Riprova|Esegui|Salva|Salvato|Salvataggio…|Cerca|Seleziona|Impostazioni|Salta|Avvia|Arresta|Invia|Non disponibile|Aggiorna|Sì").split("|"),
        strict=True,
    )),
    "es": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("Activo|Añadir|Aplicar|Archivar|Atrás|Cancelar|Cerrar|Continuar|Copiar|Crear|Eliminar|Listo|Editar|Error|Cargando…|Gestionar|Más|Nuevo|Siguiente|No|Ninguno|Abrir|Pausar|Actualizar|Recargar|Quitar|Renombrar|Restablecer|Restaurar|Reanudar|Reintentar|Ejecutar|Guardar|Guardado|Guardando…|Buscar|Seleccionar|Configuración|Omitir|Iniciar|Detener|Enviar|No disponible|Actualizar|Sí").split("|"),
        strict=True,
    )),
    "zh-CN": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("活跃|添加|应用|归档|返回|取消|关闭|继续|复制|创建|删除|完成|编辑|错误|正在加载…|管理|更多|新建|下一步|否|无|打开|暂停|刷新|重新加载|移除|重命名|重置|恢复|继续|重试|运行|保存|已保存|正在保存…|搜索|选择|设置|跳过|开始|停止|提交|不可用|更新|是").split("|"),
        strict=True,
    )),
    "bg": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("Активно|Добавяне|Прилагане|Архивиране|Назад|Отказ|Затваряне|Продължаване|Копиране|Създаване|Изтриване|Готово|Редактиране|Грешка|Зареждане…|Управление|Още|Ново|Напред|Не|Няма|Отваряне|Пауза|Опресняване|Презареждане|Премахване|Преименуване|Нулиране|Възстановяване|Продължаване|Повторен опит|Изпълнение|Запазване|Запазено|Запазване…|Търсене|Избиране|Настройки|Пропускане|Стартиране|Спиране|Изпращане|Недостъпно|Актуализиране|Да").split("|"),
        strict=True,
    )),
    "ar": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("نشط|إضافة|تطبيق|أرشفة|رجوع|إلغاء|إغلاق|متابعة|نسخ|إنشاء|حذف|تم|تعديل|خطأ|جارٍ التحميل…|إدارة|المزيد|جديد|التالي|لا|لا شيء|فتح|إيقاف مؤقت|تحديث|إعادة تحميل|إزالة|إعادة تسمية|إعادة تعيين|استعادة|استئناف|إعادة المحاولة|تشغيل|حفظ|تم الحفظ|جارٍ الحفظ…|بحث|تحديد|الإعدادات|تخطي|بدء|إيقاف|إرسال|غير متاح|تحديث|نعم").split("|"),
        strict=True,
    )),
    "pt": dict(zip(
        ("Active|Add|Apply|Archive|Back|Cancel|Close|Continue|Copy|Create|Delete|Done|Edit|Error|Loading…|Manage|More|New|Next|No|None|Open|Pause|Refresh|Reload|Remove|Rename|Reset|Restore|Resume|Retry|Run|Save|Saved|Saving…|Search|Select|Settings|Skip|Start|Stop|Submit|Unavailable|Update|Yes").split("|"),
        ("Ativo|Adicionar|Aplicar|Arquivar|Voltar|Cancelar|Fechar|Continuar|Copiar|Criar|Eliminar|Concluído|Editar|Erro|A carregar…|Gerir|Mais|Novo|Seguinte|Não|Nenhum|Abrir|Pausar|Atualizar|Recarregar|Remover|Mudar o nome|Repor|Restaurar|Retomar|Tentar novamente|Executar|Guardar|Guardado|A guardar…|Pesquisar|Selecionar|Definições|Ignorar|Iniciar|Parar|Enviar|Indisponível|Atualizar|Sim").split("|"),
        strict=True,
    )),
}

GLOSSARY = {
    "uk": {
        "Worktree": "Робоче дерево",
        "worktree": "робоче дерево",
        "Pull request": "Запит на злиття",
        "pull request": "запит на злиття",
        "Settings": "Налаштування",
    },
    "de": {"Worktree": "Arbeitsbaum", "worktree": "Arbeitsbaum"},
    "fr": {"Worktree": "Arbre de travail", "worktree": "arbre de travail"},
    "pl": {"Worktree": "Drzewo robocze", "worktree": "drzewo robocze"},
    "pt-BR": {
        "Worktree": "Árvore de trabalho",
        "worktree": "árvore de trabalho",
        "Delete": "Excluir",
        "File": "Arquivo",
    },
    "it": {"Worktree": "Albero di lavoro", "worktree": "albero di lavoro"},
    "es": {"Worktree": "Árbol de trabajo", "worktree": "árbol de trabajo"},
    "zh-CN": {"Worktree": "工作树", "worktree": "工作树"},
    "bg": {"Worktree": "Работно дърво", "worktree": "работно дърво"},
    "ar": {"Worktree": "شجرة العمل", "worktree": "شجرة العمل"},
    "pt": {
        "Worktree": "Árvore de trabalho",
        "worktree": "árvore de trabalho",
        "Delete": "Eliminar",
        "File": "Ficheiro",
    },
}

PT_PT_REPLACEMENTS = (
    ("arquivo", "ficheiro"),
    ("Arquivo", "Ficheiro"),
    ("arquivos", "ficheiros"),
    ("Arquivos", "Ficheiros"),
    ("excluir", "eliminar"),
    ("Excluir", "Eliminar"),
    ("salvar", "guardar"),
    ("Salvar", "Guardar"),
    ("usuário", "utilizador"),
    ("Usuário", "Utilizador"),
    ("usuários", "utilizadores"),
    ("Usuários", "Utilizadores"),
    ("tela", "ecrã"),
    ("Tela", "Ecrã"),
    ("diretório", "diretório"),
    ("projeto", "projeto"),
    ("equipe", "equipa"),
    ("Equipe", "Equipa"),
    ("gerenciar", "gerir"),
    ("Gerenciar", "Gerir"),
    ("carregando", "a carregar"),
    ("Carregando", "A carregar"),
)


def parse_catalog_text(source: str) -> dict[str, str]:
    return {key: json.loads(value) for key, value in ENTRY.findall(source)}


def parse_catalog(path: Path) -> dict[str, str]:
    return parse_catalog_text(path.read_text(encoding="utf-8"))


def parse_bundle(path: Path) -> dict[str, str]:
    source = path.read_text(encoding="utf-8")
    output: dict[str, str] = {}
    for raw_key, raw_value in BUNDLE_ENTRY.findall(source):
        try:
            key = json.loads(f'"{raw_key}"')
            value = json.loads(raw_value)
        except json.JSONDecodeError:
            continue
        if "." in key and isinstance(value, str):
            output[key] = value
    return output


def polyth_seed(locale: str) -> dict[str, str]:
    code = polyth_CODES.get(locale)
    if not code or not polyth.exists():
        return {}
    main_candidates = list(polyth.glob("useAppFontEffects-*.js"))
    locale_candidates = list(polyth.glob(f"{code}-*.js"))
    if not main_candidates or not locale_candidates:
        return {}
    english = parse_bundle(main_candidates[0])
    localized = parse_bundle(locale_candidates[0])
    by_phrase: dict[str, str] = {}
    for key, translated in localized.items():
        source = english.get(key)
        if source and translated and source != translated:
            by_phrase[source] = translated
    return by_phrase


def protect_placeholders(message: str) -> tuple[str, dict[str, str]]:
    replacements: dict[str, str] = {}

    def replace(match: re.Match[str]) -> str:
        token = f"ZXQPH{len(replacements)}QXZ"
        replacements[token] = match.group(0)
        return token

    return PLACEHOLDER.sub(replace, message), replacements


def restore_placeholders(message: str, replacements: dict[str, str]) -> str:
    output = message
    for token, placeholder in replacements.items():
        flexible = r"\s*".join(map(re.escape, token))
        output, count = re.subn(flexible, placeholder, output, flags=re.IGNORECASE)
        if count == 0:
            output = f"{output} {placeholder}"
    return output


def same_placeholders(source: str, localized: str) -> bool:
    return sorted(PLACEHOLDER.findall(source)) == sorted(PLACEHOLDER.findall(localized))


def translate_messages(messages: list[str], target: str) -> dict[str, str]:
    """Translate independent UI messages in one CTranslate2 batch."""
    if not messages:
        return {}
    direct = translate.get_translation_from_codes("en", target)
    if direct is None:
        raise RuntimeError(f"No English → {target} translation model is installed")
    package_translation = getattr(direct, "underlying", direct)
    package = package_translation.pkg
    model = ctranslate2.Translator(
        str(package.package_path / "model"),
        device=settings.device,
        inter_threads=settings.inter_threads,
        intra_threads=settings.intra_threads,
        compute_type=settings.compute_type,
    )
    protected_messages: list[str] = []
    placeholder_sets: list[dict[str, str]] = []
    for message in messages:
        protected, placeholders = protect_placeholders(message)
        protected_messages.append(protected)
        placeholder_sets.append(placeholders)
    tokenized = [package.tokenizer.encode(message) for message in protected_messages]
    target_prefix = [[package.target_prefix]] * len(tokenized) if package.target_prefix else None
    batches = model.translate_batch(
        tokenized,
        target_prefix=target_prefix,
        replace_unknowns=True,
        max_batch_size=settings.batch_size,
        batch_type="tokens",
        beam_size=1,
        num_hypotheses=1,
    )
    output: dict[str, str] = {}
    for source, result, placeholders in zip(messages, batches, placeholder_sets, strict=True):
        localized = package.tokenizer.decode(result.hypotheses[0])
        if package.target_prefix and localized.startswith(package.target_prefix):
            localized = localized[len(package.target_prefix):]
        output[source] = restore_placeholders(localized.strip(), placeholders)
    return output


def google_translate_messages(messages: list[str], target: str, api_key: str) -> dict[str, str]:
    """Translate HTML-safe batches through Chrome's translation API."""
    output: dict[str, str] = {}

    def protect(message: str) -> str:
        escaped = html.escape(message)
        escaped = PLACEHOLDER.sub(lambda match: f'<span translate="no">{match.group(0)}</span>', escaped)
        return TECHNICAL_TERM.sub(lambda match: f'<span translate="no">{match.group(0)}</span>', escaped)

    def restore(message: str) -> str:
        without_spans = re.sub(r'<span translate="no">(.*?)</span>', r"\1", message)
        normalized = re.sub(r"\s+([.,!?;:…])", r"\1", without_spans)
        return html.unescape(normalized).strip()

    endpoint = "https://translate-pa.googleapis.com/v1/translateHtml"
    headers = {
        "Content-Type": "application/json+protobuf",
        "X-Goog-Api-Key": api_key,
        "User-Agent": "Mozilla/5.0",
    }
    for start in range(0, len(messages), 100):
        chunk = messages[start:start + 100]
        response = requests.post(
            endpoint,
            headers=headers,
            data=json.dumps([[[protect(message) for message in chunk], "en", target], "te_lib"]),
            timeout=60,
        )
        response.raise_for_status()
        translated = response.json()[0]
        if len(translated) != len(chunk):
            raise RuntimeError(f"Google returned {len(translated)} translations for {len(chunk)} messages")
        output.update((source, restore(value)) for source, value in zip(chunk, translated, strict=True))
        print(f"Google {target}: {min(start + 100, len(messages))}/{len(messages)}", flush=True)
    return output


def mymemory_translate_messages(messages: list[str], target: str) -> dict[str, str]:
    """Translate small catalog deltas through MyMemory's public API."""
    output: dict[str, str] = {}
    session = requests.Session()
    for index, message in enumerate(messages, 1):
        protected, replacements = protect_placeholders(message)
        response = session.get(
            "https://api.mymemory.translated.net/get",
            params={
                "q": protected,
                "langpair": f"en|{target}",
                "de": "translation@polyth.local",
            },
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        translated = payload.get("responseData", {}).get("translatedText")
        if not isinstance(translated, str) or not translated.strip():
            translated = protected
        normalized = re.sub(r"\{\s*(\w+)\s*\}", r"{\1}", html.unescape(translated))
        output[message] = restore_placeholders(normalized.strip(), replacements)
        if index % 25 == 0 or index == len(messages):
            print(f"MyMemory {target}: {index}/{len(messages)}", flush=True)
    return output


def apply_glossary(value: str, locale: str) -> str:
    output = value
    for source, localized in GLOSSARY.get(locale, {}).items():
        if output == source:
            output = localized
    if locale == "pt":
        for brazilian, european in PT_PT_REPLACEMENTS:
            output = output.replace(brazilian, european)
    return output


def render(locale: str, variable: str, values: dict[str, str]) -> str:
    lines = [
        'import type { AppMessages } from "./en.ts";',
        "",
        f"export const {variable}: AppMessages = {{",
    ]
    lines.extend(f"  {json.dumps(key, ensure_ascii=False)}: {json.dumps(value, ensure_ascii=False)}," for key, value in values.items())
    lines.extend(["};", ""])
    return "\n".join(lines)


def main() -> None:
    only = set(sys.argv[1:])
    english = parse_catalog(LOCALES / "en.ts")
    phrase_cache: dict[str, dict[str, str]] = {}
    api_key = os.environ.get("GOOGLE_TRANSLATE_API_KEY", "")
    translator = os.environ.get("I18N_TRANSLATOR", "google" if api_key else "argos")
    refresh_new = os.environ.get("I18N_REFRESH_NEW") == "1"
    baseline_keys: set[str] = set()
    if refresh_new:
        committed = subprocess.run(
            ["git", "show", "HEAD:apps/web/src/i18n/locales/en.ts"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        baseline_keys = set(parse_catalog_text(committed))
    for locale, (target, variable, google_target) in TARGETS.items():
        if only and locale not in only:
            continue
        locale_path = LOCALES / f"{locale}.ts"
        existing = parse_catalog(locale_path) if locale_path.exists() else {}
        for key, localized in list(existing.items()):
            source = english.get(key)
            if source is None or not same_placeholders(source, localized):
                existing.pop(key)
        seed = {
            source: localized
            for source, localized in polyth_seed(locale).items()
            if same_placeholders(source, localized)
        }
        cache = phrase_cache.setdefault(google_target if api_key else target, {})
        values: dict[str, str] = {}
        exact = EXACT_TRANSLATIONS[locale]
        missing = list(dict.fromkeys(
            message for key, message in english.items()
            if (key not in existing or (refresh_new and key not in baseline_keys))
            and message not in exact
            and message not in seed
            and message not in cache
            and re.search(r"[A-Za-z]", message)
        ))
        print(f"{locale}: translating {len(missing)} Polyth-specific phrases", flush=True)
        if translator == "google":
            cache.update(google_translate_messages(missing, google_target, api_key))
        elif translator == "mymemory":
            cache.update(mymemory_translate_messages(missing, google_target))
        else:
            cache.update(translate_messages(missing, target))
        generated = len(missing)
        reused = 0
        preserved = 0
        print(f"{locale}: {len(seed)} curated polyth phrases", flush=True)
        for index, (key, message) in enumerate(english.items(), 1):
            if key in existing and not (refresh_new and key not in baseline_keys):
                localized = existing[key]
                preserved += 1
            elif message in exact:
                localized = exact[message]
            elif message in seed:
                localized = seed[message]
                reused += 1
            elif message in cache:
                localized = cache[message]
            else:
                localized = message
            if not same_placeholders(message, localized):
                localized = message
            values[key] = apply_glossary(localized, locale)
        locale_path.write_text(render(locale, variable, values), encoding="utf-8")
        print(
            f"{locale}: wrote {len(values)} keys "
            f"({preserved} preserved, {reused} curated, {generated} generated)",
            flush=True,
        )


if __name__ == "__main__":
    main()
