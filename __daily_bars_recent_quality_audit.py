import sqlite3
import json
from pathlib import Path

db_path = Path("./data/cache/ashare-cache.sqlite")
conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
cur = conn.cursor()

ranges = [
    ("ALL", "1=1"),
    ("FROM_2018", "trade_date >= '2018-01-01'"),
    ("FROM_2020", "trade_date >= '2020-01-01'"),
    ("FROM_2023", "trade_date >= '2023-01-01'")
]

print("\n=== 按时间段复检 A股 / 港股质量 ===")

for label, date_cond in ranges:
    print(f"\n\n### RANGE: {label}")

    sql = f"""
    SELECT
      CASE WHEN symbol LIKE 'HK:%' THEN 'HK' ELSE 'A' END AS market,
      COUNT(*) AS rows,
      COUNT(DISTINCT symbol) AS symbols,
      SUM(CASE WHEN volume IS NOT NULL THEN 1 ELSE 0 END) AS volume_rows,
      SUM(CASE WHEN volume IS NULL OR volume <= 0 THEN 1 ELSE 0 END) AS bad_volume_rows,
      SUM(CASE WHEN amount IS NOT NULL THEN 1 ELSE 0 END) AS amount_rows,
      SUM(CASE WHEN turnover IS NOT NULL THEN 1 ELSE 0 END) AS turnover_rows,
      COUNT(DISTINCT CASE WHEN amount IS NOT NULL THEN symbol END) AS amount_symbols,
      COUNT(DISTINCT CASE WHEN turnover IS NOT NULL THEN symbol END) AS turnover_symbols,
      SUM(CASE WHEN open <= 0 OR close <= 0 OR high <= 0 OR low <= 0 THEN 1 ELSE 0 END) AS bad_price_rows,
      SUM(CASE WHEN high < low OR high < open OR high < close OR low > open OR low > close THEN 1 ELSE 0 END) AS bad_ohlc_rows
    FROM daily_bars
    WHERE {date_cond}
    GROUP BY market
    ORDER BY market
    """

    for r in cur.execute(sql).fetchall():
        d = dict(r)
        rows = d["rows"] or 1
        symbols = d["symbols"] or 1

        d["bad_volume_pct"] = round(d["bad_volume_rows"] / rows * 100, 4)
        d["amount_rows_pct"] = round(d["amount_rows"] / rows * 100, 4)
        d["turnover_rows_pct"] = round(d["turnover_rows"] / rows * 100, 4)
        d["amount_symbols_pct"] = round(d["amount_symbols"] / symbols * 100, 4)
        d["turnover_symbols_pct"] = round(d["turnover_symbols"] / symbols * 100, 4)
        d["bad_price_pct"] = round(d["bad_price_rows"] / rows * 100, 4)
        d["bad_ohlc_pct"] = round(d["bad_ohlc_rows"] / rows * 100, 4)

        print(json.dumps(d, ensure_ascii=False, indent=2))

print("\n\n=== 最近数据异常股票 Top 50 ===")

for market, cond in [
    ("A", "symbol NOT LIKE 'HK:%'"),
    ("HK", "symbol LIKE 'HK:%'")
]:
    print(f"\n### {market}")

    sql = f"""
    SELECT
      symbol,
      COUNT(*) AS rows,
      MIN(trade_date) AS start_date,
      MAX(trade_date) AS end_date,
      SUM(CASE WHEN open <= 0 OR close <= 0 OR high <= 0 OR low <= 0 THEN 1 ELSE 0 END) AS bad_price_rows,
      SUM(CASE WHEN volume IS NULL OR volume <= 0 THEN 1 ELSE 0 END) AS bad_volume_rows,
      SUM(CASE WHEN amount IS NOT NULL THEN 1 ELSE 0 END) AS amount_rows,
      SUM(CASE WHEN turnover IS NOT NULL THEN 1 ELSE 0 END) AS turnover_rows
    FROM daily_bars
    WHERE {cond}
      AND trade_date >= '2018-01-01'
    GROUP BY symbol
    HAVING bad_price_rows > 0 OR bad_volume_rows > 0
    ORDER BY bad_price_rows DESC, bad_volume_rows DESC
    LIMIT 50
    """

    for r in cur.execute(sql).fetchall():
      print(dict(r))

conn.close()
