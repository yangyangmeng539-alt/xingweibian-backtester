import os
import json
import time
import urllib.parse
from pathlib import Path

# 清掉代理，避免被系统代理/venv 环境干扰
for key in [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy"
]:
    os.environ.pop(key, None)

try:
    import requests
except Exception as e:
    raise SystemExit("当前 venv 没有 requests，先运行：pip install requests\n" + str(e))

OUT_DIR = Path("./data/quality")
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_PATH = OUT_DIR / "source-field-probe-2018-requests.json"

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

session = requests.Session()
session.trust_env = False
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Connection": "close",
    "Referer": "https://quote.eastmoney.com/",
    "Host": "push2his.eastmoney.com"
})

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

def eastmoney_secid(symbol):
    symbol = normalize_symbol(symbol)

    if symbol.startswith("HK:"):
        return "116." + symbol.split(":", 1)[1]

    code = symbol

    if code.startswith("6") or code.startswith("9"):
        return "1." + code

    return "0." + code

def to_float(value):
    try:
        if value is None or value == "":
            return None
        return float(value)
    except Exception:
        return None

def fetch_eastmoney(symbol, fqt):
    secid = eastmoney_secid(symbol)

    query = {
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101",
        "fqt": str(fqt),
        "beg": START,
        "end": END,
        "lmt": "1000000",
        "_": str(int(time.time() * 1000))
    }

    url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?" + urllib.parse.urlencode(query)

    last_error = None

    for attempt in range(1, 4):
        try:
            resp = session.get(url, timeout=25)
            text = resp.text

            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code}: {text[:200]}")

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

            return {
                "ok": True,
                "source": "eastmoney_push2his",
                "secid": secid,
                "fqt": fqt,
                "name": payload.get("name"),
                "code": payload.get("code"),
                "rows": rows
            }

        except Exception as e:
            last_error = str(e)
            time.sleep(0.8 * attempt)

    return {
        "ok": False,
        "source": "eastmoney_push2his",
        "secid": secid,
        "fqt": fqt,
        "error": last_error
    }

def summarize(symbol, result):
    rows = result.get("rows") or []
    total = len(rows)

    def positive(field):
        return sum(1 for r in rows if r.get(field) is not None and r.get(field) > 0)

    def non_null(field):
        return sum(1 for r in rows if r.get(field) is not None)

    bad_price = sum(
        1 for r in rows
        if not r.get("open")
        or not r.get("close")
        or not r.get("high")
        or not r.get("low")
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
        "ok": result.get("ok"),
        "source": result.get("source"),
        "secid": result.get("secid"),
        "fqt": result.get("fqt"),
        "name": result.get("name"),
        "code": result.get("code"),
        "error": result.get("error"),
        "rows": total,
        "dateStart": rows[0]["trade_date"] if rows else None,
        "dateEnd": rows[-1]["trade_date"] if rows else None,
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

report = {
    "start": START,
    "end": END,
    "note": "只测试源字段能力，不写 SQLite。",
    "symbols": [],
    "summary": {
        "A": {"tested": 0, "ok": 0, "amountUsable": 0, "turnoverUsable": 0},
        "HK": {"tested": 0, "ok": 0, "amountUsable": 0, "turnoverUsable": 0}
    }
}

for raw in TEST_SYMBOLS:
    symbol = normalize_symbol(raw)
    market = market_of(symbol)

    print(f"\n=== TEST {symbol} ===")

    report["summary"][market]["tested"] += 1

    # fqt=0 不复权，fqt=1 前复权，都测一下。字段应该一致，但价格质量能对比。
    results = []
    for fqt in [0, 1]:
        result = fetch_eastmoney(symbol, fqt)
        item = summarize(symbol, result)
        results.append(item)

        print(json.dumps({
            "symbol": item["symbol"],
            "market": item["market"],
            "fqt": item["fqt"],
            "ok": item["ok"],
            "secid": item["secid"],
            "rows": item["rows"],
            "dateStart": item["dateStart"],
            "dateEnd": item["dateEnd"],
            "amountPositivePct": item["amountPositivePct"],
            "turnoverPositivePct": item["turnoverPositivePct"],
            "volumePositivePct": item["volumePositivePct"],
            "badPricePct": item["badPricePct"],
            "error": item["error"],
            "lastRows": item["lastRows"]
        }, ensure_ascii=False, indent=2))

        time.sleep(0.35)

    # 优先按 fqt=0 判断字段能力
    best = results[0] if results else {"ok": False, "rows": 0}
    report["symbols"].extend(results)

    if best.get("ok") and best.get("rows", 0) > 0:
        report["summary"][market]["ok"] += 1

        if best.get("amountPositivePct", 0) >= 80:
            report["summary"][market]["amountUsable"] += 1

        if best.get("turnoverPositivePct", 0) >= 80:
            report["summary"][market]["turnoverUsable"] += 1

report["conclusion"] = []

for market in ["A", "HK"]:
    s = report["summary"][market]
    tested = s["tested"] or 1

    if s["ok"] == 0:
        report["conclusion"].append(f"{market}：本次探针仍未连通源，不能判断字段能力。")
        continue

    if s["amountUsable"] / tested >= 0.6:
        report["conclusion"].append(f"{market}：amount 可作为可补字段。")
    else:
        report["conclusion"].append(f"{market}：amount 覆盖测试不足，第一版仍需 amountProxy。")

    if s["turnoverUsable"] / tested >= 0.6:
        report["conclusion"].append(f"{market}：turnover 可作为可补字段。")
    else:
        report["conclusion"].append(f"{market}：turnover 覆盖测试不足，第一版不能依赖换手率。")

OUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

print("\n=== 源字段探针报告已生成 ===")
print(OUT_PATH)

print("\n=== 总结 ===")
print(json.dumps(report["summary"], ensure_ascii=False, indent=2))

print("\n=== 结论 ===")
for line in report["conclusion"]:
    print("-", line)
