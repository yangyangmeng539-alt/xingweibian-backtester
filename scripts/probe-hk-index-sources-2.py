# -*- coding: utf-8 -*-
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

def print_json(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))

def fetch_url(url, timeout=20):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "*/*",
            "Referer": "https://gu.qq.com/",
        }
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")

def try_tencent_fqkline():
    print("===== Tencent fqkline 探测 =====")

    symbols = [
        ("恒生指数", "hkHSI"),
        ("恒生指数_r", "r_hkHSI"),
        ("恒生科技", "hkHSTECH"),
        ("恒生科技_r", "r_hkHSTECH"),
        ("恒生国企", "hkHSCEI"),
        ("恒生国企_r", "r_hkHSCEI"),
        ("恒生综合", "hkHSCI"),
        ("恒生综合_r", "r_hkHSCI"),
        ("恒生综合_备选", "hkHSCCI"),
        ("恒生综合_备选_r", "r_hkHSCCI"),
    ]

    for name, symbol in symbols:
        url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=%s,day,,,320,qfq" % urllib.parse.quote(symbol)
        try:
            text = fetch_url(url)
            data = json.loads(text)
            item = ((data.get("data") or {}).get(symbol) or {})
            day = item.get("qfqday") or item.get("day") or []
            print_json({
                "ok": bool(day),
                "source": "tencent_fqkline",
                "name": name,
                "symbol": symbol,
                "rows": len(day),
                "first": day[0] if day else None,
                "last": day[-1] if day else None,
                "keys": list(item.keys())[:20],
                "error": item.get("qt", {}).get(symbol, "")
            })
        except Exception as e:
            print_json({
                "ok": False,
                "source": "tencent_fqkline",
                "name": name,
                "symbol": symbol,
                "error": str(e)
            })
        time.sleep(0.4)

def try_tencent_quote():
    print("===== Tencent quote 探测 =====")

    symbols = [
        "hkHSI", "r_hkHSI",
        "hkHSTECH", "r_hkHSTECH",
        "hkHSCEI", "r_hkHSCEI",
        "hkHSCI", "r_hkHSCI",
        "hkHSCCI", "r_hkHSCCI",
    ]

    for symbol in symbols:
        url = "https://qt.gtimg.cn/q=%s" % urllib.parse.quote(symbol)
        try:
            text = fetch_url(url)
            print_json({
                "ok": bool(text and "v_" in text and "~" in text),
                "source": "tencent_quote",
                "symbol": symbol,
                "preview": text[:260]
            })
        except Exception as e:
            print_json({
                "ok": False,
                "source": "tencent_quote",
                "symbol": symbol,
                "error": str(e)
            })
        time.sleep(0.3)

def try_stooq_daily():
    print("===== Stooq CSV 探测 =====")

    candidates = [
        ("恒生指数", "^hsi"),
        ("恒生指数_备选", "hsi"),
        ("恒生科技", "hstech"),
        ("恒生科技_hk", "hstech.hk"),
        ("恒生科技_指数", "^hstech"),
        ("恒生国企", "hscei"),
        ("恒生国企_hk", "hscei.hk"),
        ("恒生国企_指数", "^hscei"),
        ("恒生综合", "hsci"),
        ("恒生综合_hk", "hsci.hk"),
        ("恒生综合_指数", "^hsci"),
        ("恒生综合_备选", "hscci"),
        ("恒生综合_备选_hk", "hscci.hk"),
    ]

    for name, symbol in candidates:
        url = "https://stooq.com/q/d/l/?s=%s&i=d&d1=20180101&d2=20260612" % urllib.parse.quote(symbol)
        try:
            text = fetch_url(url)
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            ok = len(lines) > 2 and "Date" in lines[0] and "Close" in lines[0]
            print_json({
                "ok": ok,
                "source": "stooq_csv",
                "name": name,
                "symbol": symbol,
                "rows": max(0, len(lines) - 1),
                "header": lines[0] if lines else "",
                "first": lines[1] if len(lines) > 1 else "",
                "last": lines[-1] if len(lines) > 1 else "",
                "preview": text[:220]
            })
        except Exception as e:
            print_json({
                "ok": False,
                "source": "stooq_csv",
                "name": name,
                "symbol": symbol,
                "error": str(e)
            })
        time.sleep(0.4)

if __name__ == "__main__":
    try_tencent_quote()
    try_tencent_fqkline()
    try_stooq_daily()
