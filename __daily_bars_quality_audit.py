import sqlite3
import json
import math
from pathlib import Path
from collections import defaultdict

db_path = Path("./data/cache/ashare-cache.sqlite")
out_dir = Path("./data/quality")
out_dir.mkdir(parents=True, exist_ok=True)
out_path = out_dir / "daily-bars-quality-report.json"

if not db_path.exists():
    raise SystemExit(f"SQLite 不存在: {db_path.resolve()}")

conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
cur = conn.cursor()

def market_of(symbol):
    return "HK" if str(symbol).startswith("HK:") else "A"

def safe_float(v):
    try:
        if v is None:
            return None
        x = float(v)
        if math.isfinite(x):
            return x
        return None
    except Exception:
        return None

def pct(a, b):
    if not b:
        return 0
    return round(a / b * 100, 4)

report = {
    "db": str(db_path),
    "tables": [],
    "schema": {},
    "marketCoverage": {},
    "badPriceSamples": {},
    "badOhlcSamples": {},
    "moneyCoverageSamples": {},
    "symbolDeepCheck": {},
    "conclusion": []
}

tables = [r["name"] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).fetchall()]
report["tables"] = tables

for table in tables:
    report["schema"][table] = [dict(r) for r in cur.execute(f"PRAGMA table_info({table})").fetchall()]

if "daily_bars" not in tables:
    raise SystemExit("没找到 daily_bars 表")

coverage_sql = """
SELECT
  CASE WHEN symbol LIKE 'HK:%' THEN 'HK' ELSE 'A' END AS market,
  COUNT(*) AS rows,
  COUNT(DISTINCT symbol) AS symbols,
  SUM(CASE WHEN volume IS NOT NULL THEN 1 ELSE 0 END) AS volume_rows,
  SUM(CASE WHEN amount IS NOT NULL THEN 1 ELSE 0 END) AS amount_rows,
  SUM(CASE WHEN turnover IS NOT NULL THEN 1 ELSE 0 END) AS turnover_rows,
  COUNT(DISTINCT CASE WHEN amount IS NOT NULL THEN symbol END) AS amount_symbols,
  COUNT(DISTINCT CASE WHEN turnover IS NOT NULL THEN symbol END) AS turnover_symbols,
  SUM(CASE WHEN open IS NULL OR close IS NULL OR high IS NULL OR low IS NULL THEN 1 ELSE 0 END) AS null_price_rows,
  SUM(CASE WHEN close <= 0 OR open <= 0 OR high <= 0 OR low <= 0 THEN 1 ELSE 0 END) AS bad_price_rows,
  SUM(CASE WHEN high < low OR high < open OR high < close OR low > open OR low > close THEN 1 ELSE 0 END) AS bad_ohlc_rows,
  SUM(CASE WHEN volume IS NULL OR volume <= 0 THEN 1 ELSE 0 END) AS bad_volume_rows
FROM daily_bars
GROUP BY market
ORDER BY market
"""

for r in cur.execute(coverage_sql).fetchall():
    d = dict(r)
    rows = d["rows"] or 1
    symbols = d["symbols"] or 1
    d["volume_rows_pct"] = pct(d["volume_rows"], rows)
    d["amount_rows_pct"] = pct(d["amount_rows"], rows)
    d["turnover_rows_pct"] = pct(d["turnover_rows"], rows)
    d["amount_symbols_pct"] = pct(d["amount_symbols"], symbols)
    d["turnover_symbols_pct"] = pct(d["turnover_symbols"], symbols)
    d["bad_price_rows_pct"] = pct(d["bad_price_rows"], rows)
    d["bad_ohlc_rows_pct"] = pct(d["bad_ohlc_rows"], rows)
    d["bad_volume_rows_pct"] = pct(d["bad_volume_rows"], rows)
    report["marketCoverage"][d["market"]] = d

for market, cond in [
    ("A", "symbol NOT LIKE 'HK:%'"),
    ("HK", "symbol LIKE 'HK:%'")
]:
    report["badPriceSamples"][market] = [
        dict(r) for r in cur.execute(f"""
        SELECT *
        FROM daily_bars
        WHERE {cond}
          AND (close <= 0 OR open <= 0 OR high <= 0 OR low <= 0)
        LIMIT 30
        """).fetchall()
    ]

    report["badOhlcSamples"][market] = [
        dict(r) for r in cur.execute(f"""
        SELECT *
        FROM daily_bars
        WHERE {cond}
          AND (high < low OR high < open OR high < close OR low > open OR low > close)
        LIMIT 30
        """).fetchall()
    ]

    report["moneyCoverageSamples"][market] = [
        dict(r) for r in cur.execute(f"""
        SELECT symbol,
               COUNT(*) AS rows,
               SUM(CASE WHEN amount IS NOT NULL THEN 1 ELSE 0 END) AS amount_rows,
               SUM(CASE WHEN turnover IS NOT NULL THEN 1 ELSE 0 END) AS turnover_rows,
               SUM(CASE WHEN close <= 0 OR open <= 0 OR high <= 0 OR low <= 0 THEN 1 ELSE 0 END) AS bad_price_rows
        FROM daily_bars
        WHERE {cond}
        GROUP BY symbol
        ORDER BY bad_price_rows DESC, amount_rows ASC, turnover_rows ASC
        LIMIT 50
        """).fetchall()
    ]

target_symbols = [
    "600519",
    "300750",
    "000001",
    "688981",
    "HK:00700",
    "HK:09888",
    "HK:03690",
    "HK:09988"
]

for symbol in target_symbols:
    rows = [dict(r) for r in cur.execute("""
        SELECT *
        FROM daily_bars
        WHERE symbol = ?
        ORDER BY trade_date
    """, (symbol,)).fetchall()]

    if not rows:
        report["symbolDeepCheck"][symbol] = {"exists": False}
        continue

    bad_price = []
    bad_ohlc = []
    pct_mismatch = []
    amount_ratio_samples = []

    prev_close = None
    for row in rows:
        o = safe_float(row.get("open"))
        c = safe_float(row.get("close"))
        h = safe_float(row.get("high"))
        l = safe_float(row.get("low"))
        v = safe_float(row.get("volume"))
        amount = safe_float(row.get("amount"))
        pct_change = safe_float(row.get("pct_change"))

        if o is None or c is None or h is None or l is None or o <= 0 or c <= 0 or h <= 0 or l <= 0:
            if len(bad_price) < 20:
                bad_price.append(row)

        if o is not None and c is not None and h is not None and l is not None:
            if h < l or h < o or h < c or l > o or l > c:
                if len(bad_ohlc) < 20:
                    bad_ohlc.append(row)

        if prev_close and prev_close > 0 and c and c > 0 and pct_change is not None:
            calc_pct = (c / prev_close - 1) * 100
            if abs(calc_pct - pct_change) > max(0.25, abs(pct_change) * 0.05):
                if len(pct_mismatch) < 20:
                    pct_mismatch.append({
                        "trade_date": row.get("trade_date"),
                        "prev_close": prev_close,
                        "close": c,
                        "pct_change": pct_change,
                        "calc_pct": round(calc_pct, 4),
                        "diff": round(calc_pct - pct_change, 4)
                    })

        if c and c > 0 and v and v > 0 and amount and amount > 0:
            market = market_of(symbol)
            proxy = c * v * (100 if market == "A" else 1)
            ratio = amount / proxy if proxy else None
            if ratio is not None and (ratio < 0.2 or ratio > 5):
                if len(amount_ratio_samples) < 20:
                    amount_ratio_samples.append({
                        "trade_date": row.get("trade_date"),
                        "close": c,
                        "volume": v,
                        "amount": amount,
                        "proxy": round(proxy, 2),
                        "ratio": round(ratio, 4)
                    })

        if c and c > 0:
            prev_close = c

    amount_rows = sum(1 for r in rows if r.get("amount") is not None)
    turnover_rows = sum(1 for r in rows if r.get("turnover") is not None)
    bad_price_rows = sum(
        1 for r in rows
        if safe_float(r.get("open")) is None
        or safe_float(r.get("close")) is None
        or safe_float(r.get("high")) is None
        or safe_float(r.get("low")) is None
        or safe_float(r.get("open")) <= 0
        or safe_float(r.get("close")) <= 0
        or safe_float(r.get("high")) <= 0
        or safe_float(r.get("low")) <= 0
    )

    report["symbolDeepCheck"][symbol] = {
        "exists": True,
        "market": market_of(symbol),
        "rows": len(rows),
        "dateStart": rows[0].get("trade_date"),
        "dateEnd": rows[-1].get("trade_date"),
        "amountRows": amount_rows,
        "turnoverRows": turnover_rows,
        "amountRowsPct": pct(amount_rows, len(rows)),
        "turnoverRowsPct": pct(turnover_rows, len(rows)),
        "badPriceRows": bad_price_rows,
        "badPriceRowsPct": pct(bad_price_rows, len(rows)),
        "badPriceSamples": bad_price,
        "badOhlcSamples": bad_ohlc,
        "pctMismatchSamples": pct_mismatch,
        "amountRatioSamples": amount_ratio_samples
    }

a = report["marketCoverage"].get("A", {})
hk = report["marketCoverage"].get("HK", {})

if a:
    if a.get("amount_rows_pct", 0) < 80:
        report["conclusion"].append("A股 amount 覆盖不足，不能直接作为全市场预测因子。")
    if a.get("turnover_rows_pct", 0) < 80:
        report["conclusion"].append("A股 turnover 覆盖不足，不能直接作为全市场预测因子。")
    if a.get("bad_price_rows_pct", 0) > 1:
        report["conclusion"].append("A股存在明显非正价格/复权异常，需要做数据质量过滤。")

if hk:
    if hk.get("amount_rows_pct", 0) < 80:
        report["conclusion"].append("港股 amount 基本缺失，应使用 close * volume 的 amountProxy。")
    if hk.get("turnover_rows_pct", 0) < 80:
        report["conclusion"].append("港股 turnover 基本缺失，第一版不要依赖换手率。")

report["conclusion"].append("预测因子第一版应优先使用 volumePulse；amount 有值用真实 amount，没有值用 amountProxy；turnover 仅作为可选增强。")
report["conclusion"].append("所有预测计算必须跳过 open/close/high/low <= 0 的异常行。")

out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

print("\n=== 数据质量报告已生成 ===")
print(out_path)

print("\n=== 市场覆盖摘要 ===")
print(json.dumps(report["marketCoverage"], ensure_ascii=False, indent=2))

print("\n=== 重点股票深检摘要 ===")
for sym, item in report["symbolDeepCheck"].items():
    print(sym, {
        "exists": item.get("exists"),
        "market": item.get("market"),
        "rows": item.get("rows"),
        "dateStart": item.get("dateStart"),
        "dateEnd": item.get("dateEnd"),
        "amountRowsPct": item.get("amountRowsPct"),
        "turnoverRowsPct": item.get("turnoverRowsPct"),
        "badPriceRowsPct": item.get("badPriceRowsPct"),
        "pctMismatchCountSample": len(item.get("pctMismatchSamples", [])),
        "amountRatioCountSample": len(item.get("amountRatioSamples", []))
    })

print("\n=== 结论 ===")
for line in report["conclusion"]:
    print("-", line)

conn.close()
