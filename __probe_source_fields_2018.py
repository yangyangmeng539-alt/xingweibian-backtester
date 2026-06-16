import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT_DIR = Path("./data/quality")
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_PATH = OUT_DIR / "source-field-probe-2018.json"

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
        code = s.split(":", 1)[1]
        return "HK:" + code.zfill(5)
    if s.startswith("HK") and len(s) >= 7:
        return "HK:" + s[2:].zfill(5)
    if s.endswith(".HK"):
        return "HK:" + s[:-3].zfill(5)
    if s.isdigit() and len(s) == 5:
        return "HK:" + s.zfill(5)
    if s.isdigit() and len(s) == 6:
        return s
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

    # 深市 / 创业板 / 北交先按 0 测
    return "0." + code

def to_float(value):
    try:
        if value is None or value == "":
            return None
        x = float(value)
        return x
    except Exception:
        return None

def fetch_json(url, timeout=20):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://quote.eastmoney.com/"
        }
    )

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="ignore")
        return json.loads(raw)

def fetch_eastmoney_kline(symbol, beg=START, end=END):
    secid = eastmoney_secid(symbol)

    query = {
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101",
        "fqt": "1",
        "beg": beg,
        "end": end,
        "lmt": "1000000",
        "_": str(int(time.time() * 1000))
    }

    url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?" + urllib.parse.urlencode(query)

    data = fetch_json(url)
    payload = data.get("data") or {}
    klines = payload.get("klines") or []

    rows = []

    for line in klines:
        parts = str(line).split(",")

        while len(parts) < 11:
            parts.append("")

        row = {
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
        }

        rows.append(row)

    return {
        "source": "eastmoney_push2his",
        "url": url,
        "secid": secid,
        "rows": rows,
        "rawDataName": payload.get("name"),
        "rawCode": payload.get("code"),
        "rawMarket": payload.get("market")
    }

def summarize_rows(symbol, source_result):
    rows = source_result.get("rows") or []
    total = len(rows)

    def count_not_null(field):
        return sum(1 for r in rows if r.get(field) is not None)

    def count_positive(field):
        return sum(1 for r in rows if r.get(field) is not None and r.get(field) > 0)

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

    amount_rows = count_not_null("amount")
    amount_positive_rows = count_positive("amount")
    turnover_rows = count_not_null("turnover")
    turnover_positive_rows = count_positive("turnover")

    return {
        "symbol": symbol,
        "market": market_of(symbol),
        "source": source_result.get("source"),
        "secid": source_result.get("secid"),
        "rawDataName": source_result.get("rawDataName"),
        "rawCode": source_result.get("rawCode"),
        "rawMarket": source_result.get("rawMarket"),
        "rows": total,
        "dateStart": rows[0]["trade_date"] if rows else None,
        "dateEnd": rows[-1]["trade_date"] if rows else None,
        "badPriceRows": bad_price,
        "badVolumeRows": bad_volume,
        "amountRows": amount_rows,
        "amountPositiveRows": amount_positive_rows,
        "turnoverRows": turnover_rows,
        "turnoverPositiveRows": turnover_positive_rows,
        "amountRowsPct": round(amount_rows / total * 100, 4) if total else 0,
        "amountPositivePct": round(amount_positive_rows / total * 100, 4) if total else 0,
        "turnoverRowsPct": round(turnover_rows / total * 100, 4) if total else 0,
        "turnoverPositivePct": round(turnover_positive_rows / total * 100, 4) if total else 0,
        "badPricePct": round(bad_price / total * 100, 4) if total else 0,
        "badVolumePct": round(bad_volume / total * 100, 4) if total else 0,
        "firstRows": rows[:3],
        "lastRows": rows[-3:] if rows else []
    }

report = {
    "start": START,
    "end": END,
    "symbols": [],
    "summary": {
        "A": {
            "tested": 0,
            "amountUsable": 0,
            "turnoverUsable": 0
        },
        "HK": {
            "tested": 0,
            "amountUsable": 0,
            "turnoverUsable": 0
        }
    },
    "conclusion": []
}

for raw_symbol in TEST_SYMBOLS:
    symbol = normalize_symbol(raw_symbol)

    print(f"\n=== TEST {symbol} ===")

    try:
        result = fetch_eastmoney_kline(symbol)
        item = summarize_rows(symbol, result)
        report["symbols"].append(item)

        market = item["market"]
        report["summary"][market]["tested"] += 1

        if item["rows"] > 0 and item["amountPositivePct"] >= 80:
            report["summary"][market]["amountUsable"] += 1

        if item["rows"] > 0 and item["turnoverPositivePct"] >= 80:
            report["summary"][market]["turnoverUsable"] += 1

        print(json.dumps({
            "symbol": item["symbol"],
            "market": item["market"],
            "source": item["source"],
            "secid": item["secid"],
            "rows": item["rows"],
            "dateStart": item["dateStart"],
            "dateEnd": item["dateEnd"],
            "amountPositivePct": item["amountPositivePct"],
            "turnoverPositivePct": item["turnoverPositivePct"],
            "badPricePct": item["badPricePct"],
            "badVolumePct": item["badVolumePct"],
            "lastRows": item["lastRows"]
        }, ensure_ascii=False, indent=2))

    except Exception as error:
        item = {
            "symbol": symbol,
            "market": market_of(symbol),
            "error": str(error)
        }
        report["symbols"].append(item)
        print(json.dumps(item, ensure_ascii=False, indent=2))

    time.sleep(0.25)

a = report["summary"]["A"]
hk = report["summary"]["HK"]

if a["tested"]:
    if a["amountUsable"] >= max(1, int(a["tested"] * 0.6)):
        report["conclusion"].append("A股：东方财富 push2his 可用于补 amount。")
    else:
        report["conclusion"].append("A股：amount 源覆盖测试不足，不能直接全量补。")

    if a["turnoverUsable"] >= max(1, int(a["tested"] * 0.6)):
        report["conclusion"].append("A股：东方财富 push2his 可用于补 turnover。")
    else:
        report["conclusion"].append("A股：turnover 源覆盖测试不足，不能直接全量补。")

if hk["tested"]:
    if hk["amountUsable"] >= max(1, int(hk["tested"] * 0.6)):
        report["conclusion"].append("港股：东方财富 push2his 可用于补 amount。")
    else:
        report["conclusion"].append("港股：amount 源覆盖测试不足，第一版仍需 amountProxy。")

    if hk["turnoverUsable"] >= max(1, int(hk["tested"] * 0.6)):
        report["conclusion"].append("港股：东方财富 push2his 可用于补 turnover。")
    else:
        report["conclusion"].append("港股：turnover 源覆盖测试不足，第一版不要依赖港股换手率。")

OUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

print("\n=== 源字段探针报告已生成 ===")
print(OUT_PATH)

print("\n=== 总结 ===")
print(json.dumps(report["summary"], ensure_ascii=False, indent=2))

print("\n=== 结论 ===")
for line in report["conclusion"]:
    print("-", line)
