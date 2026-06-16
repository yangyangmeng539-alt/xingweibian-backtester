import sqlite3
from pathlib import Path

db_path = Path("./data/cache/ashare-cache.sqlite")
conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
cur = conn.cursor()

sql = """
SELECT
  CASE
    WHEN symbol LIKE 'HK:%' THEN 'HK'
    ELSE 'A'
  END AS market,
  COUNT(*) AS rows,
  COUNT(DISTINCT symbol) AS symbols,
  SUM(CASE WHEN volume IS NOT NULL THEN 1 ELSE 0 END) AS volume_rows,
  SUM(CASE WHEN amount IS NOT NULL THEN 1 ELSE 0 END) AS amount_rows,
  SUM(CASE WHEN turnover IS NOT NULL THEN 1 ELSE 0 END) AS turnover_rows,
  COUNT(DISTINCT CASE WHEN amount IS NOT NULL THEN symbol END) AS amount_symbols,
  COUNT(DISTINCT CASE WHEN turnover IS NOT NULL THEN symbol END) AS turnover_symbols,
  SUM(CASE WHEN close <= 0 OR open <= 0 OR high <= 0 OR low <= 0 THEN 1 ELSE 0 END) AS bad_price_rows
FROM daily_bars
GROUP BY market
ORDER BY market;
"""

print("\n=== A股 / 港股字段覆盖率 ===")
for r in cur.execute(sql).fetchall():
    d = dict(r)
    print(d)
    rows = d["rows"] or 1
    symbols = d["symbols"] or 1
    print("  amount_rows_pct   =", round(d["amount_rows"] / rows * 100, 2), "%")
    print("  turnover_rows_pct =", round(d["turnover_rows"] / rows * 100, 2), "%")
    print("  amount_symbols_pct   =", round(d["amount_symbols"] / symbols * 100, 2), "%")
    print("  turnover_symbols_pct =", round(d["turnover_symbols"] / symbols * 100, 2), "%")
    print("  bad_price_rows =", d["bad_price_rows"])

print("\n=== 缺 amount/turnover 的 A股样本 ===")
for r in cur.execute("""
SELECT symbol, COUNT(*) AS rows,
       SUM(CASE WHEN amount IS NOT NULL THEN 1 ELSE 0 END) AS amount_rows,
       SUM(CASE WHEN turnover IS NOT NULL THEN 1 ELSE 0 END) AS turnover_rows
FROM daily_bars
WHERE symbol NOT LIKE 'HK:%'
GROUP BY symbol
HAVING amount_rows = 0 OR turnover_rows = 0
LIMIT 20;
""").fetchall():
    print(dict(r))

print("\n=== 港股样本覆盖 ===")
for r in cur.execute("""
SELECT symbol, COUNT(*) AS rows,
       SUM(CASE WHEN volume IS NOT NULL THEN 1 ELSE 0 END) AS volume_rows,
       SUM(CASE WHEN amount IS NOT NULL THEN 1 ELSE 0 END) AS amount_rows,
       SUM(CASE WHEN turnover IS NOT NULL THEN 1 ELSE 0 END) AS turnover_rows
FROM daily_bars
WHERE symbol LIKE 'HK:%'
GROUP BY symbol
LIMIT 20;
""").fetchall():
    print(dict(r))

conn.close()
