import sqlite3
import json
from pathlib import Path
import baostock as bs

DB = Path("./data/cache/ashare-cache.sqlite")
OUT = Path("./data/quality/baostock-a-reload-dryrun-2018.json")
OUT.parent.mkdir(parents=True, exist_ok=True)

SYMBOLS = ["600519", "300750", "000001", "688981", "601919"]
START = "2018-01-01"
END = "2026-06-10"

def bs_code(symbol):
    return ("sh." if symbol.startswith(("6", "9")) else "sz.") + symbol

def f(v):
    try:
        if v is None or v == "":
            return None
        return float(v)
    except Exception:
        return None

def get_cache_last(symbol):
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    row = cur.execute("""
    SELECT *
    FROM daily_bars
    WHERE symbol = ?
    ORDER BY trade_date DESC
    LIMIT 1
    """, (symbol,)).fetchone()
    conn.close()
    return dict(row) if row else None

def get_baostock_rows(symbol):
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
        volume_shares = f(item.get("volume"))
        rows.append({
            "symbol": symbol,
            "trade_date": item.get("date"),
            "open": f(item.get("open")),
            "high": f(item.get("high")),
            "low": f(item.get("low")),
            "close": f(item.get("close")),
            "volume_baostock_shares": volume_shares,
            "volume_to_store_hands": (volume_shares / 100) if volume_shares is not None else None,
            "amount": f(item.get("amount")),
            "turnover": f(item.get("turn")),
            "pct_change": f(item.get("pctChg")),
            "tradestatus": item.get("tradestatus"),
            "isST": item.get("isST")
        })

    if rs.error_code != "0":
        raise RuntimeError(f"{rs.error_code}: {rs.error_msg}")

    return rows

report = {
    "note": "A股 BaoStock 2018+ 重拉预演；不写库；检查 volume 股→手、amount、turnover。",
    "start": START,
    "end": END,
    "symbols": []
}

lg = bs.login()
print("login:", lg.error_code, lg.error_msg)

for symbol in SYMBOLS:
    print("\n=== DRYRUN", symbol, "===")
    cache_last = get_cache_last(symbol)
    rows = get_baostock_rows(symbol)

    first = rows[0] if rows else None
    last = rows[-1] if rows else None

    bad_price = sum(
        1 for r in rows
        if not r["open"] or not r["close"] or not r["high"] or not r["low"]
        or r["open"] <= 0 or r["close"] <= 0 or r["high"] <= 0 or r["low"] <= 0
    )

    amount_rows = sum(1 for r in rows if r["amount"] and r["amount"] > 0)
    turnover_rows = sum(1 for r in rows if r["turnover"] and r["turnover"] > 0)
    volume_rows = sum(1 for r in rows if r["volume_to_store_hands"] and r["volume_to_store_hands"] > 0)

    item = {
        "symbol": symbol,
        "rows": len(rows),
        "dateStart": first["trade_date"] if first else None,
        "dateEnd": last["trade_date"] if last else None,
        "badPriceRows": bad_price,
        "volumeRowsPct": round(volume_rows / len(rows) * 100, 4) if rows else 0,
        "amountRowsPct": round(amount_rows / len(rows) * 100, 4) if rows else 0,
        "turnoverRowsPct": round(turnover_rows / len(rows) * 100, 4) if rows else 0,
        "cacheLast": cache_last,
        "baostockFirst": first,
        "baostockLast": last
    }

    report["symbols"].append(item)

    print(json.dumps({
        "symbol": item["symbol"],
        "rows": item["rows"],
        "dateStart": item["dateStart"],
        "dateEnd": item["dateEnd"],
        "badPriceRows": item["badPriceRows"],
        "volumeRowsPct": item["volumeRowsPct"],
        "amountRowsPct": item["amountRowsPct"],
        "turnoverRowsPct": item["turnoverRowsPct"],
        "cacheLast": item["cacheLast"],
        "baostockLast": item["baostockLast"]
    }, ensure_ascii=False, indent=2))

bs.logout()

OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print("\n报告:", OUT)
