#!/usr/bin/env python3
"""
MAS Nakit Radar - deterministic QA crawler (Playwright for Python, no LLM/browser-use).

browser-use (github.com/browser-use/browser-use) drives a browser via an LLM that decides
each action from the page state - it needs an OPENAI_API_KEY/ANTHROPIC_API_KEY to run at all.
None was available in this environment, and this app's full route map is already known and
finite (unlike an arbitrary website browser-use is meant to explore blind), so an LLM isn't
buying anything here that a scripted, deterministic crawl doesn't already give more reliably.
This script is the fallback agreed on: same goal (walk every module/sub-module "like a real
user", catch anything broken), no LLM, no API key, fully repeatable.

SAFETY: only ever point this at a disposable database (see scripts/seed-demo.ts + a fresh
`createdb` - never mas_radar_dev). It logs in as a real admin and DOES submit a handful of
curated "create new record" forms with valid dummy data, and clicks non-destructive-looking
buttons it discovers (tabs/filters/expand) - never anything whose visible text matches the
DESTRUCTIVE_WORDS blocklist below (cancel/delete/deactivate/lock/archive/logout).

Usage:
    pip install playwright
    python -m playwright install chromium
    python scripts/qa/browser_crawl.py --base-url http://localhost:3400 \
        --username qacrawl --password "$(cat /tmp/.qapw)" --out qa_report.json

Output: a JSON report (qa_report.json by default) with one entry per visited page plus a
top-level "form_tests" list. A separate step turns this into the markdown QA report.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

from playwright.sync_api import sync_playwright, Page, ConsoleMessage, Response

# ── Known routes (from src/app/**/page.tsx) ──────────────────────────────────────────────
# Dynamic-segment placeholders are filled in from --seed-ids (real rows in the disposable DB).
STATIC_ROUTES = [
    "/", "/overview",
    "/payments", "/payments/new", "/payments/items", "/payments/calendar",
    "/payments/missing", "/payments/history", "/payments/archive",
    "/cashflow", "/cashflow/monthly", "/cashflow/concentration", "/cashflow/controls",
    "/finance", "/finance/checks", "/finance/checks/new", "/finance/loans",
    "/finance/loans/new", "/finance/maturities", "/finance/exposure", "/finance/archive",
    "/production", "/production/capacity", "/production/costs",
    "/production/profitability", "/production/roi",
    "/scenarios", "/scenarios/history", "/scenarios/compare", "/scenarios/optimization",
    "/insights", "/insights/ask", "/insights/reports", "/insights/reminders",
    "/insights/tasks",
    "/data", "/data/quality", "/data/imports", "/data/reviews",
    "/data/assumptions", "/data/sources", "/data/reconciliation",
    "/system", "/system/security", "/system/audit", "/system/backup",
    "/system/archive", "/system/features",
    # legacy top-level aliases - should 308-redirect to a canonical module route, not error
    "/radar", "/calendar", "/financing", "/imports", "/reports", "/reminders",
    "/assumptions", "/data-quality", "/admin", "/ask", "/phases",
]

DYNAMIC_TEMPLATES = [
    "/cashflow/{cashflow_month}",
    "/finance/loans/{loan_id}",
    "/financing/loans/{loan_id}",
    "/imports/{workbook_id}",
    "/imports/{workbook_id}/reviews",
    "/imports/{workbook_id}/sheets/{sheet_id}",
    "/insights/ask/{ai_response_id}",
    "/insights/reports/{report_id}",
    "/reports/{report_id}",
    "/payments/{payment_id}/edit",
    "/scenarios/{scenario_run_id}",
]

DESTRUCTIVE_WORDS = [
    "iptal", "sil", "delete", "pasifleştir", "pasiflestir", "deactivate", "kilit",
    "arşivle", "arsivle", "archive", "çıkış", "cikis", "logout", "kalıcı", "kalici",
]

SAFE_CLICK_WORDS = [
    "tümü", "tumu", "aç", "ac", "kapat", "göster", "goster", "detay", "incele",
    "filtrele", "sınıflandır", "siniflandir", "gör", "gor", "yenile", "genişlet",
    "genislet",
]

CRASH_PATTERNS = re.compile(
    r"application error|internal server error|unhandled runtime error|"
    r"this page could not be found|http error 500|digest.*error",
    re.IGNORECASE,
)


@dataclass
class PageResult:
    url: str
    status: int | None = None
    ok: bool = True
    console_errors: list[str] = field(default_factory=list)
    page_errors: list[str] = field(default_factory=list)
    failed_subrequests: list[str] = field(default_factory=list)
    crashed: bool = False
    has_h1: bool = False
    h1_text: list[str] = field(default_factory=list)
    content_chars: int = 0
    svg_count: int = 0
    empty_svg_count: int = 0
    horizontal_overflow: bool = False
    details_opened: int = 0
    notes: list[str] = field(default_factory=list)


def norm(base: str, href: str) -> str | None:
    """Resolve an href against base; return None for anything not worth crawling
    (external, mailto, javascript:, hash-only, static assets)."""
    if not href or href.startswith(("javascript:", "mailto:", "#")):
        return None
    full = urljoin(base, href)
    parsed = urlparse(full)
    base_parsed = urlparse(base)
    if parsed.netloc != base_parsed.netloc:
        return None
    if re.search(r"\.(png|jpg|jpeg|svg|ico|css|js|map)$", parsed.path):
        return None
    return parsed.path + (("?" + parsed.query) if parsed.query else "")


def visit(page: Page, base_url: str, path: str, visited_links: set[str]) -> PageResult:
    url = base_url + path
    result = PageResult(url=path)
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_subrequests: list[str] = []

    def on_console(msg: ConsoleMessage) -> None:
        if msg.type == "error":
            console_errors.append(msg.text[:300])

    def on_pageerror(exc: Exception) -> None:
        page_errors.append(str(exc)[:300])

    def on_response(resp: Response) -> None:
        if resp.status >= 400 and resp.url.startswith(base_url):
            failed_subrequests.append(f"{resp.status} {resp.url.replace(base_url, '')}")

    page.on("console", on_console)
    page.on("pageerror", on_pageerror)
    page.on("response", on_response)
    # Dev-mode first-visit compiles are slow on a memory-constrained host (webpack pack-cache
    # writes can hit RangeError: Failed to allocate memory and retry internally) - generous
    # timeout plus one retry, rather than mistaking "slow to compile" for "broken".
    resp = None
    last_err: Exception | None = None
    for attempt in range(2):
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=25000)
            page.wait_for_timeout(1500)
            last_err = None
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(2)
    if last_err is not None:
        result.ok = False
        result.notes.append(f"goto başarısız (2 deneme sonrası): {str(last_err)[:200]}")
        page.remove_listener("console", on_console)
        page.remove_listener("pageerror", on_pageerror)
        page.remove_listener("response", on_response)
        return result
    result.status = resp.status if resp else None

    # Open every collapsed <details> so its content counts toward the empty-page check.
    try:
        closed = page.locator("details:not([open])")
        n = closed.count()
        for el in closed.all():
            try:
                el.evaluate("(e) => e.setAttribute('open', '')")
            except Exception:  # noqa: BLE001
                pass
        result.details_opened = n
    except Exception:  # noqa: BLE001
        pass

    body_text = ""
    try:
        body_text = page.locator("body").inner_text(timeout=3000)
    except Exception:  # noqa: BLE001
        pass
    result.crashed = bool(CRASH_PATTERNS.search(body_text[:4000]))
    result.content_chars = len(body_text.strip())

    try:
        h1s = page.locator("h1").all_inner_texts()
        result.has_h1 = len(h1s) > 0
        result.h1_text = h1s[:3]
    except Exception:  # noqa: BLE001
        pass

    try:
        svgs = page.locator("svg").all()
        result.svg_count = len(svgs)
        empty = 0
        for s in svgs:
            try:
                child_count = s.evaluate("(e) => e.querySelectorAll('path,rect,circle,line,polyline,polygon,text').length")
                if child_count == 0:
                    empty += 1
            except Exception:  # noqa: BLE001
                pass
        result.empty_svg_count = empty
    except Exception:  # noqa: BLE001
        pass

    try:
        result.horizontal_overflow = page.evaluate(
            "() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 4"
        )
    except Exception:  # noqa: BLE001
        pass

    # Discover same-origin links for the crawl queue (also proves nav actually resolves).
    try:
        hrefs = page.locator("a").evaluate_all("(els) => els.map((e) => e.getAttribute('href'))")
        for h in hrefs:
            p = norm(base_url, h or "")
            if p and p not in visited_links:
                visited_links.add(p)
    except Exception:  # noqa: BLE001
        pass

    # Try a bounded number of "safe" buttons (tabs/filters/expand) - never destructive words.
    try:
        buttons = page.locator("button").all()
        clicked = 0
        for b in buttons:
            if clicked >= 3:
                break
            try:
                text = (b.inner_text(timeout=500) or "").strip().lower()
            except Exception:  # noqa: BLE001
                continue
            if not text or any(w in text for w in DESTRUCTIVE_WORDS):
                continue
            if not any(w in text for w in SAFE_CLICK_WORDS):
                continue
            try:
                b.click(timeout=2000)
                page.wait_for_timeout(300)
                clicked += 1
            except Exception:  # noqa: BLE001
                pass
        if clicked:
            result.notes.append(f"{clicked} güvenli buton denendi (sekme/filtre/genişlet türü)")
    except Exception:  # noqa: BLE001
        pass

    page.remove_listener("console", on_console)
    page.remove_listener("pageerror", on_pageerror)
    page.remove_listener("response", on_response)

    result.console_errors = console_errors
    result.page_errors = page_errors
    result.failed_subrequests = failed_subrequests
    return result


FORM_TESTS = [
    {
        "name": "Yeni ödeme kalemi ekle",
        "path": "/payments/new",
        "fields": {"name": "QA Crawl Test Ödemesi", "default_amount": "1500"},
        "select": {"recurrence_type": "monthly"},
        "submit_text": "kaydet",
    },
    {
        "name": "Yeni dış varsayım ekle",
        "path": "/data/assumptions",
        "fields": {"description": "QA crawl test varsayımı", "url": "https://example.com/qa-crawl"},
        "submit_text": "ekle",
    },
]


def run_form_tests(page: Page, base_url: str) -> list[dict]:
    results = []
    for spec in FORM_TESTS:
        entry = {"name": spec["name"], "path": spec["path"], "ok": False, "detail": ""}
        try:
            page.goto(base_url + spec["path"], wait_until="domcontentloaded", timeout=25000)
            page.wait_for_timeout(1000)
            filled_any = False
            for field_name, value in spec.get("fields", {}).items():
                loc = page.locator(f'input[name="{field_name}"], textarea[name="{field_name}"]').first
                if loc.count() > 0:
                    loc.fill(value)
                    filled_any = True
            for field_name, value in spec.get("select", {}).items():
                loc = page.locator(f'select[name="{field_name}"]').first
                if loc.count() > 0:
                    loc.select_option(value)
            if not filled_any:
                entry["detail"] = "form alanları sayfada bulunamadı (yol/alan adı değişmiş olabilir)"
                results.append(entry)
                continue
            btn = page.locator(f'button:has-text("{spec["submit_text"]}")').first
            if btn.count() == 0:
                entry["detail"] = f'"{spec["submit_text"]}" butonu bulunamadı'
                results.append(entry)
                continue
            btn.click(timeout=5000)
            page.wait_for_timeout(2000)
            body = page.locator("body").inner_text(timeout=3000)
            crashed = bool(CRASH_PATTERNS.search(body[:4000]))
            entry["ok"] = not crashed
            entry["detail"] = f"url_sonrası={page.url.replace(base_url, '')} çöktü={crashed}"
        except Exception as e:  # noqa: BLE001
            entry["detail"] = f"istisna: {str(e)[:200]}"
        results.append(entry)
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--username", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--out", default="qa_report.json")
    ap.add_argument("--max-pages", type=int, default=150)
    ap.add_argument("--cashflow-month", default="")
    ap.add_argument("--loan-id", default="")
    ap.add_argument("--workbook-id", default="")
    ap.add_argument("--sheet-id", default="")
    ap.add_argument("--ai-response-id", default="")
    ap.add_argument("--report-id", default="")
    ap.add_argument("--payment-id", default="")
    ap.add_argument("--scenario-run-id", default="")
    args = ap.parse_args()

    seed_ids = {
        "cashflow_month": args.cashflow_month, "loan_id": args.loan_id,
        "workbook_id": args.workbook_id, "sheet_id": args.sheet_id,
        "ai_response_id": args.ai_response_id, "report_id": args.report_id,
        "payment_id": args.payment_id, "scenario_run_id": args.scenario_run_id,
    }
    dynamic_routes = []
    for tmpl in DYNAMIC_TEMPLATES:
        try:
            dynamic_routes.append(tmpl.format(**seed_ids))
        except KeyError:
            pass

    queue: list[str] = list(dict.fromkeys(STATIC_ROUTES + dynamic_routes))
    visited_links: set[str] = set(queue)
    results: dict[str, PageResult] = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        # 0) unauthenticated request must redirect (default-deny middleware).
        page.goto(args.base_url + "/overview", wait_until="domcontentloaded", timeout=25000)
        unauth_ok = "/login" in page.url
        print(f"[0] middleware default-deny: {'PASS' if unauth_ok else 'FAIL'} ({page.url})")

        # 1) real login.
        page.goto(args.base_url + "/login", wait_until="domcontentloaded", timeout=25000)
        page.fill('input[name="username"]', args.username)
        page.fill('input[name="password"]', args.password)
        page.click('button[type="submit"]')
        # Fixed sleeps are unreliable on this memory-constrained host: the redirect target
        # (e.g. /overview) may be compiling for the first time and take well over 10s. Wait
        # for the actual URL change instead, with a generous ceiling.
        try:
            page.wait_for_url(lambda u: "/login" not in u, timeout=20000)
        except Exception:  # noqa: BLE001 - fall through; the URL check below reports it
            pass
        login_ok = "/login" not in page.url
        print(f"[1] giriş: {'PASS' if login_ok else 'FAIL'} ({page.url})")
        if not login_ok:
            print("Giriş başarısız, crawl durduruluyor.")
            return 2

        # 2) crawl.
        i = 0
        while queue and i < args.max_pages:
            path = queue.pop(0)
            if path in results:
                continue
            i += 1
            print(f"[{i}] {path}")
            r = visit(page, args.base_url, path, visited_links)
            results[path] = r
            for newlink in visited_links:
                if newlink not in results and newlink not in queue and newlink.startswith("/"):
                    if not newlink.startswith(("/login", "/health", "/version", "/_next")):
                        queue.append(newlink)
            visited_links = set()  # avoid re-adding same links from every page forever

        # 3) curated create-form tests.
        print("--- form testleri ---")
        form_results = run_form_tests(page, args.base_url)
        for fr in form_results:
            print(f"  {'PASS' if fr['ok'] else 'FAIL'}  {fr['name']}  {fr['detail']}")

        browser.close()

    out = {
        "base_url": args.base_url,
        "unauthenticated_redirect_ok": unauth_ok,
        "login_ok": login_ok,
        "pages_visited": len(results),
        "pages": {k: vars(v) for k, v in results.items()},
        "form_tests": form_results,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n{len(results)} sayfa ziyaret edildi. Rapor: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
