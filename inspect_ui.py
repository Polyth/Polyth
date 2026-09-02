from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path="/snap/bin/chromium", args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1800, "height": 900})
    page.goto("http://127.0.0.1:4400/p/e17e998c-4a55-4e62-ba49-6ff0ff824d97/s/8f7652d4-c3a5-49ad-9500-002e7dc8bc58", wait_until="networkidle")
    page.wait_for_timeout(1000)
    if page.locator(".project-setup-close").count():
        page.locator(".project-setup-close").click()
        page.wait_for_timeout(500)
    print("session rows", page.locator(".session-row").count())
    if page.locator(".session-row").filter(has_text="Прибрати заголовок сесії з панелі віджетів").count():
        page.locator(".session-row").filter(has_text="Прибрати заголовок сесії з панелі віджетів").get_by_role("button").first.click()
        page.wait_for_timeout(1000)
    print("title:", page.title())
    print("url:", page.url)
    print("app:", page.locator(".app").get_attribute("class"))
    print("storage:", page.evaluate("Object.fromEntries(Object.entries(localStorage))"))
    for el in page.locator("header button, header [class*=session], header [class*=title]").all():
        try:
            print("ELEMENT", el.evaluate("e => e.outerHTML"))
        except Exception:
            pass
    print("session status count", page.locator(".desktop-session-status").count())
    print("header text", page.locator("header.header").inner_text())
    page.screenshot(path="/tmp/polyth-header.png")
    browser.close()
