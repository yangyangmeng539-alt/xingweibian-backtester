import sqlite3
import json
import re
from pathlib import Path

db_path = Path("./data/cache/ashare-cache.sqlite")

if not db_path.exists():
    raise SystemExit(f"SQLite 不存在: {db_path.resolve()}")

conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
cur = conn.cursor()

tables = [r["name"] for r in cur.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).fetchall()]

print("\n=== TABLES ===")
for t in tables:
    print("-", t)

def q(sql, args=()):
    try:
        return [dict(r) for r in cur.execute(sql, args).fetchall()]
    except Exception as e:
        return [{"error": str(e)}]

print("\n=== SCHEMA / SAMPLE ===")
for table in tables:
    print(f"\n\n### TABLE: {table}")
    cols = q(f"PRAGMA table_info({table})")
    print("columns:")
    for c in cols:
        print(f"  - {c.get('name')} | {c.get('type')}")

    sample = q(f"SELECT * FROM {table} LIMIT 3")
    print("sample:")
    print(json.dumps(sample, ensure_ascii=False, indent=2)[:3000])

print("\n=== A股 / 港股 字段覆盖检查 ===")

candidate_tables = []
for table in tables:
    cols = q(f"PRAGMA table_info({table})")
    names = [c.get("name") for c in cols]
    low = [str(x).lower() for x in names]

    has_symbol = any(x in low for x in ["symbol", "code", "stock_code", "ts_code"])
    has_date = any(x in low for x in ["date", "trade_date", "day"])
    has_close = any(x in low for x in ["close", "close_price"])

    if has_symbol or has_date or has_close:
        candidate_tables.append((table, names))

def find_col(names, candidates):
    lower_map = {str(n).lower(): n for n in names}
    for c in candidates:
        if c.lower() in lower_map:
            return lower_map[c.lower()]
    return None

for table, names in candidate_tables:
    symbol_col = find_col(names, ["symbol", "code", "stock_code", "ts_code"])
    date_col = find_col(names, ["date", "trade_date", "day"])
    volume_col = find_col(names, ["volume", "vol", "成交量"])
    amount_col = find_col(names, ["amount", "turnover_amount", "成交额"])
    turnover_col = find_col(names, ["turnover", "turnover_rate", "turnoverRate", "换手率"])

    if not symbol_col:
        continue

    print(f"\n### CANDIDATE DAILY TABLE: {table}")
    print("symbol_col =", symbol_col)
    print("date_col   =", date_col)
    print("volume_col =", volume_col)
    print("amount_col =", amount_col)
    print("turnover_col =", turnover_col)

    # A股样本：6位数字
    a_rows = q(
        f"""
        SELECT * FROM {table}
        WHERE {symbol_col} GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'
        LIMIT 3
        """
    )

    # 港股样本：HK:xxxxx / HKxxxxx / xxxxx.HK / 5位数字，尽量都查
    hk_rows = q(
        f"""
        SELECT * FROM {table}
        WHERE {symbol_col} LIKE 'HK:%'
           OR {symbol_col} LIKE 'HK%'
           OR {symbol_col} LIKE '%.HK'
           OR {symbol_col} GLOB '[0-9][0-9][0-9][0-9][0-9]'
        LIMIT 3
        """
    )

    print("\nA股 sample:")
    print(json.dumps(a_rows, ensure_ascii=False, indent=2)[:2500])

    print("\n港股 sample:")
    print(json.dumps(hk_rows, ensure_ascii=False, indent=2)[:2500])

    # 指定重点样本
    for sym in ["600519", "300750", "HK:00700", "HK:09888", "00700", "09888"]:
        rows = q(f"SELECT * FROM {table} WHERE {symbol_col} = ? LIMIT 2", (sym,))
        if rows:
            print(f"\n指定样本 {sym}:")
            print(json.dumps(rows, ensure_ascii=False, indent=2)[:2500])

conn.close()
