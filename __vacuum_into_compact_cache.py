import sqlite3
from pathlib import Path

src = Path("./data/cache/ashare-cache.sqlite")
dst = Path("./data/cache/ashare-cache.compact.sqlite")

if dst.exists():
    dst.unlink()

def size_gb(path):
    return Path(path).stat().st_size / 1024 / 1024 / 1024

def summary(path):
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    row = cur.execute("""
    SELECT
      COUNT(*) AS rows,
      COUNT(DISTINCT symbol) AS symbols,
      MIN(trade_date) AS start_date,
      MAX(trade_date) AS end_date,
      SUM(CASE WHEN symbol NOT LIKE 'HK:%' THEN 1 ELSE 0 END) AS a_rows,
      SUM(CASE WHEN symbol LIKE 'HK:%' THEN 1 ELSE 0 END) AS hk_rows,
      SUM(CASE WHEN symbol NOT LIKE 'HK:%' AND amount IS NOT NULL AND amount > 0 THEN 1 ELSE 0 END) AS a_amount_rows,
      SUM(CASE WHEN symbol NOT LIKE 'HK:%' AND turnover IS NOT NULL AND turnover > 0 THEN 1 ELSE 0 END) AS a_turnover_rows,
      SUM(CASE WHEN open <= 0 OR close <= 0 OR high <= 0 OR low <= 0 THEN 1 ELSE 0 END) AS bad_price_rows
    FROM daily_bars
    """).fetchone()

    indexes = []
    for idx in cur.execute("PRAGMA index_list('daily_bars')").fetchall():
        indexes.append(dict(idx))

    page_size = cur.execute("PRAGMA page_size").fetchone()[0]
    page_count = cur.execute("PRAGMA page_count").fetchone()[0]
    freelist_count = cur.execute("PRAGMA freelist_count").fetchone()[0]

    conn.close()

    return {
        "size_gb": round(size_gb(path), 3),
        "page_size": page_size,
        "page_count": page_count,
        "freelist_count": freelist_count,
        "summary": dict(row),
        "indexes": indexes
    }

src_summary = summary(src)
print("原库：")
print(src_summary)

conn = sqlite3.connect(str(src))
conn.execute(f"VACUUM INTO '{str(dst).replace(chr(39), chr(39)+chr(39))}'")
conn.close()

dst_summary = summary(dst)
print("\n压缩副本：")
print(dst_summary)

print("\n内容摘要一致：", src_summary["summary"] == dst_summary["summary"])
print("原库大小GB：", src_summary["size_gb"])
print("副本大小GB：", dst_summary["size_gb"])
print("节省GB：", round(src_summary["size_gb"] - dst_summary["size_gb"], 3))
