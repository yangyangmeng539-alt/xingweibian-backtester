import os
import sqlite3
from pathlib import Path

db = Path("./data/cache/ashare-cache.sqlite")

def fmt_size(path):
    p = Path(path)
    if not p.exists():
        return "不存在"
    size = p.stat().st_size
    return f"{size / 1024 / 1024 / 1024:.3f} GB / {size:,} bytes"

print("文件大小：")
for suffix in ["", "-wal", "-shm"]:
    p = Path(str(db) + suffix)
    print(str(p), fmt_size(p))

conn = sqlite3.connect(str(db))
conn.row_factory = sqlite3.Row
cur = conn.cursor()

print("\nSQLite 页面信息：")
for key in ["page_size", "page_count", "freelist_count", "journal_mode", "auto_vacuum"]:
    try:
        value = cur.execute(f"PRAGMA {key}").fetchone()[0]
        print(key, value)
    except Exception as e:
        print(key, "ERR", e)

page_size = cur.execute("PRAGMA page_size").fetchone()[0]
page_count = cur.execute("PRAGMA page_count").fetchone()[0]
freelist_count = cur.execute("PRAGMA freelist_count").fetchone()[0]

print("\n理论体积：")
print({
    "page_size": page_size,
    "page_count": page_count,
    "freelist_count": freelist_count,
    "db_pages_gb": round(page_size * page_count / 1024 / 1024 / 1024, 3),
    "free_pages_gb": round(page_size * freelist_count / 1024 / 1024 / 1024, 3),
    "free_pct": round(freelist_count / page_count * 100, 4) if page_count else 0
})

print("\n表统计：")
rows = cur.execute("""
SELECT
  COUNT(*) AS rows,
  COUNT(DISTINCT symbol) AS symbols,
  MIN(trade_date) AS start_date,
  MAX(trade_date) AS end_date,
  SUM(CASE WHEN symbol LIKE 'HK:%' THEN 1 ELSE 0 END) AS hk_rows,
  SUM(CASE WHEN symbol NOT LIKE 'HK:%' THEN 1 ELSE 0 END) AS a_rows
FROM daily_bars
""").fetchone()
print(dict(rows))

print("\n索引：")
for row in cur.execute("PRAGMA index_list('daily_bars')").fetchall():
    print(dict(row))

conn.close()
