import sqlite3
import shutil
from pathlib import Path
from datetime import datetime
import baostock as bs

DB = Path("./data/cache/ashare-cache.sqlite")
SYMBOLS = ["600519", "300750", "000001", "688981", "601919"]
START = "2018-01-01"
END = "2026-06-10"

if not DB.exists():
    raise SystemExit(f"数据库不存在: {DB}")

backup = DB.with_name(f"ashare-cache.backup-before-baostock-small-reload-{datetime.now().strftime('%Y%m%d-%H%M%S')}.sqlite")
shutil.copy2(DB, backup)
print("已备份:", backup)

def bs_code(symbol):
    return ("sh." if symbol.startswith(("6", "9")) else "sz.") + symbol

def f(v):
    try:
        if v is None or v == "":
            return None
        return float(v)
    except Exception:
        return None

def fetch_rows(symbol):
    rs = bs.query_history_k_data_plus(
        bs_code(symbol),
        "date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,isST",
        start_date=START,
        end_date=END,
        frequency="d",
        adjustflag="2"
    )

    rows = []

    while rs.error_code == "0" and rs.next():
        item = dict(zip(rs.fields, rs.get_row_data()))

        if item.get("tradestatus") != "1":
            continue

        open_v = f(item.get("open"))
        high_v = f(item.get("high"))
        low_v = f(item.get("low"))
        close_v = f(item.get("close"))
        preclose_v = f(item.get("preclose"))
        volume_shares = f(item.get("volume"))
        amount_v = f(item.get("amount"))
        turn_v = f(item.get("turn"))
        pct_v = f(item.get("pctChg"))

        if not open_v or not high_v or not low_v or not close_v:
            continue

        if open_v <= 0 or high_v <= 0 or low_v <= 0 or close_v <= 0:
            continue

        change_amount = None
        if preclose_v is not None:
            change_amount = close_v - preclose_v

        rows.append({
            "symbol": symbol,
            "trade_date": item.get("date"),
            "open": open_v,
            "close": close_v,
            "high": high_v,
            "low": low_v,
            "volume": (volume_shares / 100) if volume_shares is not None else None,
            "amount": amount_v,
            "amplitude": None,
            "pct_change": pct_v,
            "change_amount": change_amount,
            "turnover": turn_v
        })

    if rs.error_code != "0":
        raise RuntimeError(f"{symbol} BaoStock error {rs.error_code}: {rs.error_msg}")

    return rows

conn = sqlite3.connect(str(DB))
cur = conn.cursor()

lg = bs.login()
print("login:", lg.error_code, lg.error_msg)

for symbol in SYMBOLS:
    print("\n=== RELOAD", symbol, "===")

    rows = fetch_rows(symbol)
    print("fetched:", len(rows), rows[0]["trade_date"] if rows else None, "→", rows[-1]["trade_date"] if rows else None)

    cur.execute(
        "DELETE FROM daily_bars WHERE symbol = ? AND trade_date >= ?",
        (symbol, START)
    )

    cur.executemany("""
    INSERT INTO daily_bars (
      symbol,
      trade_date,
      open,
      close,
      high,
      low,
      volume,
      amount,
      amplitude,
      pct_change,
      change_amount,
      turnover
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, [
        (
            r["symbol"],
            r["trade_date"],
            r["open"],
            r["close"],
            r["high"],
            r["low"],
            r["volume"],
            r["amount"],
            r["amplitude"],
            r["pct_change"],
            r["change_amount"],
            r["turnover"]
        )
        for r in rows
    ])

    conn.commit()

    check = cur.execute("""
    SELECT
      COUNT(*) AS rows,
      SUM(CASE WHEN amount IS NOT NULL AND amount > 0 THEN 1 ELSE 0 END) AS amount_rows,
      SUM(CASE WHEN turnover IS NOT NULL AND turnover > 0 THEN 1 ELSE 0 END) AS turnover_rows,
      MIN(trade_date) AS start_date,
      MAX(trade_date) AS end_date
    FROM daily_bars
    WHERE symbol = ?
      AND trade_date >= ?
    """, (symbol, START)).fetchone()

    print({
        "symbol": symbol,
        "rows": check[0],
        "amount_rows": check[1],
        "turnover_rows": check[2],
        "start_date": check[3],
        "end_date": check[4]
    })

bs.logout()
conn.close()

print("\n小批量 BaoStock 写库验证完成。")
print("备份库:", backup)
