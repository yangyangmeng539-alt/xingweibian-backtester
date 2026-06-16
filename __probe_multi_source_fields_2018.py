import os
import json
import time
import urllib.parse
from pathlib import Path

for key in [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy"
]:
    os.environ.pop(key, None)

OUT_DIR = Path("./data/quality")
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_PATH = OUT_DIR / "multi-source-field-probe-2018.json"

START = "20180101"
END = "20260610"

TEST_SYMBOLS = [
    "600519",
    "300750",
    "000001",
    "688981",
    "601919",
    "HK:00700",
    "HK:09888",
    "HK:03690",
    "HK:09988",
    "HK:01810"
]

def normalize_symbol(symbol):
    s = str(symbol or "").strip().upper()

    if s.startswith("HK:"):
        return "HK:" + s.split(":", 1)[1].zfill(5)

    if s.startswith("HK") and len(s) >= 7:
        return "HK:" + s[2:].zfill(5)

    if s.endswith(".HK"):
        return "HK:" + s[:-3].zfill(5)

    if s.isdigit() and len(s) == 5:
        return "HK:" + s.zfill(5)

    return s

def market_of(symbol):
    return "HK" if str(symbol).startswith("HK:") else "A"

def to_float(v):
    try:
        if v is None or v == "" or str(v).lower() == "nan":
            return None
        return float(v)
    except Exception:
        return None

def pick(row, names):
    for name in names:
        if name in row:
            return row.get(name)
    return None

def summarize_rows(symbol, source, rows, error=None):
    total = len(rows)

    def non_null(field):
        return sum(1 for r in rows if r.get(field) is not None)

    def positive(field):
        return sum(1 for r in rows if r.get(field) is not None and r.get(field) > 0)

    bad_price = sum(
        1 for r in rows
        if r.get("open") is None
        or r.get("close") is None
        or r.get("high") is None
        or r.get("low") is None
        or r.get("open") <= 0
        or r.get("close") <= 0
        or r.get("high") <= 0
        or r.get("low") <= 0
    )

    bad_volume = sum(
        1 for r in rows
        if r.get("volume") is None or r.get("volume") <= 0
    )

    return {
        "symbol": symbol,
        "market": market_of(symbol),
        "source": source,
        "ok": total > 0 and not error,
        "error": error,
        "rows": total,
        "dateStart": rows[0].get("trade_date") if rows else None,
        "dateEnd": rows[-1].get("trade_date") if rows else None,
        "amountRows": non_null("amount"),
        "amountPositiveRows": positive("amount"),
        "turnoverRows": non_null("turnover"),
        "turnoverPositiveRows": positive("turnover"),
        "volumePositiveRows": positive("volume"),
        "badPriceRows": bad_price,
        "badVolumeRows": bad_volume,
        "amountPositivePct": round(positive("amount") / total * 100, 4) if total else 0,
        "turnoverPositivePct": round(positive("turnover") / total * 100, 4) if total else 0,
        "volumePositivePct": round(positive("volume") / total * 100, 4) if total else 0,
        "badPricePct": round(bad_price / total * 100, 4) if total else 0,
        "badVolumePct": round(bad_volume / total * 100, 4) if total else 0,
        "firstRows": rows[:2],
        "lastRows": rows[-2:] if rows else []
    }

def fetch_akshare(symbol):
    try:
        import akshare as ak
    except Exception as e:
        return summarize_rows(symbol, "akshare", [], f"akshare unavailable: {e}")

    market = market_of(symbol)

    try:
        if market == "A":
            code = symbol
            df = ak.stock_zh_a_hist(
                symbol=code,
                period="daily",
                start_date=START,
                end_date=END,
                adjust=""
            )
        else:
            code = symbol.split(":", 1)[1]
            df = ak.stock_hk_hist(
                symbol=code,
                period="daily",
                start_date=START,
                end_date=END,
                adjust=""
            )

        rows = []

        for _, r in df.iterrows():
            row = r.to_dict()

            rows.append({
                "trade_date": str(pick(row, ["日期", "date", "Date", "trade_date"]))[:10],
                "open": to_float(pick(row, ["开盘", "open", "Open"])),
                "close": to_float(pick(row, ["收盘", "close", "Close"])),
                "high": to_float(pick(row, ["最高", "high", "High"])),
                "low": to_float(pick(row, ["最低", "low", "Low"])),
                "volume": to_float(pick(row, ["成交量", "volume", "Volume"])),
                "amount": to_float(pick(row, ["成交额", "amount", "Amount"])),
                "amplitude": to_float(pick(row, ["振幅", "amplitude"])),
                "pct_change": to_float(pick(row, ["涨跌幅", "pct_change"])),
                "change_amount": to_float(pick(row, ["涨跌额", "change_amount"])),
                "turnover": to_float(pick(row, ["换手率", "turnover", "turnover_rate"]))
            })

        rows = [
            r for r in rows
            if r.get("trade_date")
            and r.get("trade_date") != "None"
        ]

        rows.sort(key=lambda x: x.get("trade_date") or "")

        return summarize_rows(symbol, "akshare", rows)

    except Exception as e:
        return summarize_rows(symbol, "akshare", [], str(e))

def eastmoney_secid(symbol):
    if symbol.startswith("HK:"):
        return "116." + symbol.split(":", 1)[1]

    if symbol.startswith("6") or symbol.startswith("9"):
        return "1." + symbol

    return "0." + symbol

def fetch_eastmoney_direct(symbol):
    try:
        import requests
    except Exception as e:
        return summarize_rows(symbol, "eastmoney_push2his", [], f"requests unavailable: {e}")

    session = requests.Session()
    session.trust_env = False
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://quote.eastmoney.com/",
        "Connection": "close"
    })

    query = {
        "secid": eastmoney_secid(symbol),
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101",
        "fqt": "0",
        "beg": START,
        "end": END,
        "lmt": "1000000",
        "_": str(int(time.time() * 1000))
    }

    url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?" + urllib.parse.urlencode(query)

    try:
        resp = session.get(url, timeout=25)
        resp.raise_for_status()
        data = resp.json()
        payload = data.get("data") or {}
        klines = payload.get("klines") or []

        rows = []

        for line in klines:
            parts = str(line).split(",")

            while len(parts) < 11:
                parts.append("")

            rows.append({
                "trade_date": parts[0],
                "open": to_float(parts[1]),
                "close": to_float(parts[2]),
                "high": to_float(parts[3]),
                "low": to_float(parts[4]),
                "volume": to_float(parts[5]),
                "amount": to_float(parts[6]),
                "amplitude": to_float(parts[7]),
                "pct_change": to_float(parts[8]),
                "change_amount": to_float(parts[9]),
                "turnover": to_float(parts[10])
            })

        return summarize_rows(symbol, "eastmoney_push2his", rows)

    except Exception as e:
        return summarize_rows(symbol, "eastmoney_push2his", [], str(e))

def tencent_market_code(symbol):
    if symbol.startswith("HK:"):
        return "hk" + symbol.split(":", 1)[1]

    if symbol.startswith("6") or symbol.startswith("9"):
        return "sh" + symbol

    return "sz" + symbol

def fetch_tencent_direct(symbol):
    try:
        import requests
    except Exception as e:
        return summarize_rows(symbol, "tencent_kline", [], f"requests unavailable: {e}")

    session = requests.Session()
    session.trust_env = False
    session.headers.update({
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://gu.qq.com/",
        "Accept": "application/json,text/plain,*/*"
    })

    code = tencent_market_code(symbol)

    # 腾讯源通常只有 OHLCV，不稳定提供成交额/换手率。
    urls = [
        f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},day,2018-01-01,2026-06-10,10000,qfq",
        f"https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param={code},day,2018-01-01,2026-06-10,10000"
    ]

    last_error = None

    for url in urls:
        try:
            resp = session.get(url, timeout=25)
            text = resp.text

            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code}: {text[:120]}")

            data = resp.json()
            root = data.get("data") or {}
            item = root.get(code) or {}

            arr = (
                item.get("qfqday")
                or item.get("hfqday")
                or item.get("day")
                or []
            )

            rows = []

            for p in arr:
                # 常见格式：
                # [date, open, close, high, low, volume]
                # 有些情况下后面可能带 amount，但不能保证
                if not isinstance(p, list) or len(p) < 6:
                    continue

                rows.append({
                    "trade_date": str(p[0])[:10],
                    "open": to_float(p[1]),
                    "close": to_float(p[2]),
                    "high": to_float(p[3]),
                    "low": to_float(p[4]),
                    "volume": to_float(p[5]),
                    "amount": to_float(p[6]) if len(p) > 6 else None,
                    "turnover": to_float(p[7]) if len(p) > 7 else None
                })

            if rows:
                return summarize_rows(symbol, "tencent_kline", rows)

        except Exception as e:
            last_error = str(e)

    return summarize_rows(symbol, "tencent_kline", [], last_error)

report = {
    "start": START,
    "end": END,
    "note": "多源字段能力探针：不写 SQLite，只判断每个源能否提供 volume / amount / turnover。",
    "symbols": [],
    "summary": {}
}

sources = [
    fetch_akshare,
    fetch_eastmoney_direct,
    fetch_tencent_direct
]

for raw in TEST_SYMBOLS:
    symbol = normalize_symbol(raw)

    print(f"\n\n================ {symbol} ================")

    for fn in sources:
        item = fn(symbol)
        report["symbols"].append(item)

        key = f"{item['market']}::{item['source']}"
        if key not in report["summary"]:
            report["summary"][key] = {
                "tested": 0,
                "ok": 0,
                "amountUsable": 0,
                "turnoverUsable": 0,
                "volumeUsable": 0
            }

        s = report["summary"][key]
        s["tested"] += 1

        if item["ok"]:
            s["ok"] += 1

        if item["amountPositivePct"] >= 80:
            s["amountUsable"] += 1

        if item["turnoverPositivePct"] >= 80:
            s["turnoverUsable"] += 1

        if item["volumePositivePct"] >= 80:
            s["volumeUsable"] += 1

        print(json.dumps({
            "source": item["source"],
            "ok": item["ok"],
            "rows": item["rows"],
            "dateStart": item["dateStart"],
            "dateEnd": item["dateEnd"],
            "volumePositivePct": item["volumePositivePct"],
            "amountPositivePct": item["amountPositivePct"],
            "turnoverPositivePct": item["turnoverPositivePct"],
            "badPricePct": item["badPricePct"],
            "badVolumePct": item["badVolumePct"],
            "error": item["error"],
            "lastRows": item["lastRows"]
        }, ensure_ascii=False, indent=2))

        time.sleep(0.35)

report["conclusion"] = []

for key, s in report["summary"].items():
    tested = s["tested"] or 1
    market, source = key.split("::", 1)

    if s["ok"] == 0:
        report["conclusion"].append(f"{market} / {source}：未连通或无数据。")
        continue

    if s["volumeUsable"] / tested >= 0.6:
        report["conclusion"].append(f"{market} / {source}：volume 可用。")

    if s["amountUsable"] / tested >= 0.6:
        report["conclusion"].append(f"{market} / {source}：amount 可用，可考虑补字段。")
    else:
        report["conclusion"].append(f"{market} / {source}：amount 不稳定，不能作为基础字段。")

    if s["turnoverUsable"] / tested >= 0.6:
        report["conclusion"].append(f"{market} / {source}：turnover 可用，可考虑补换手率。")
    else:
        report["conclusion"].append(f"{market} / {source}：turnover 不稳定，第一版不能依赖换手率。")

OUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

print("\n\n=== 多源字段探针报告已生成 ===")
print(OUT_PATH)

print("\n=== 总结 ===")
print(json.dumps(report["summary"], ensure_ascii=False, indent=2))

print("\n=== 结论 ===")
for line in report["conclusion"]:
    print("-", line)
