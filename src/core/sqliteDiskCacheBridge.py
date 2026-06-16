import argparse
import json
import os
import sqlite3
import sys
import traceback


DAILY_BAR_COLUMNS = [
    "symbol",
    "trade_date",
    "open",
    "close",
    "high",
    "low",
    "volume",
    "amount",
    "amplitude",
    "pct_change",
    "change_amount",
    "turnover",
]
INDEX_DAILY_BAR_COLUMNS = [
    "index_code",
    "index_name",
    "market",
    "trade_date",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "amount",
    "amplitude",
    "pct_change",
    "change_amount",
    "turnover",
    "source",
    "updated_at",
]


def normalize_symbol(value):
    text = str(value or "").strip().upper()

    if text.isdigit():
        if len(text) == 6:
            return text
        raise ValueError(f"invalid A-share symbol: {value}")

    if text.startswith("HK:"):
        digits = text[3:]
        if len(digits) == 5 and digits.isdigit():
            return f"HK:{digits}"

    raise ValueError(f"invalid symbol: {value}")

def normalize_index_code(value):
    text = str(value or "").strip().upper()
    if not text:
        raise ValueError("empty index code")
    if ":" not in text:
        raise ValueError(f"invalid index code: {value}")
    left, right = text.split(":", 1)
    if not left or not right:
        raise ValueError(f"invalid index code: {value}")
    if not all(ch.isalnum() or ch == "_" for ch in left):
        raise ValueError(f"invalid index code: {value}")
    if not all(ch.isalnum() or ch in "._-" for ch in right):
        raise ValueError(f"invalid index code: {value}")
    return text

def normalize_date(value):
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) == 8 and text.isdigit():
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"
    return text[0:10]


def normalize_number(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def connect(db_path):
    db_dir = os.path.dirname(os.path.abspath(db_path))
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def ensure_daily_bars_table_exists(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS daily_bars (
          symbol TEXT NOT NULL,
          trade_date TEXT NOT NULL,
          open REAL,
          close REAL,
          high REAL,
          low REAL,
          volume REAL,
          amount REAL,
          amplitude REAL,
          pct_change REAL,
          change_amount REAL,
          turnover REAL,
          PRIMARY KEY (symbol, trade_date)
        )
        """
    )


def ensure_index_daily_bars_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS index_daily_bars (
          index_code TEXT NOT NULL,
          index_name TEXT NOT NULL,
          market TEXT NOT NULL,
          trade_date TEXT NOT NULL,
          open REAL,
          high REAL,
          low REAL,
          close REAL,
          volume REAL,
          amount REAL,
          amplitude REAL,
          pct_change REAL,
          change_amount REAL,
          turnover REAL,
          source TEXT,
          updated_at TEXT,
          PRIMARY KEY (index_code, trade_date)
        )
        """
    )

def symbol_summary(conn, symbol):
    clean_symbol = normalize_symbol(symbol)
    row = conn.execute(
        """
        SELECT
          COUNT(*) AS barCount,
          MIN(trade_date) AS startDate,
          MAX(trade_date) AS endDate
        FROM daily_bars
        WHERE symbol = ?
        """,
        (clean_symbol,),
    ).fetchone()
    return {
        "symbol": clean_symbol,
        "barCount": int(row["barCount"] or 0),
        "startDate": row["startDate"] or "",
        "endDate": row["endDate"] or "",
    }


def read_symbol_bars(conn, symbol, start_date="", end_date=""):
    clean_symbol = normalize_symbol(symbol)
    start_iso = normalize_date(start_date)
    end_iso = normalize_date(end_date)
    params = [clean_symbol]
    filters = ["symbol = ?"]

    if start_iso:
        filters.append("trade_date >= ?")
        params.append(start_iso)
    if end_iso:
        filters.append("trade_date <= ?")
        params.append(end_iso)

    rows = conn.execute(
        f"""
        SELECT
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
        FROM daily_bars
        WHERE {" AND ".join(filters)}
        ORDER BY trade_date ASC
        """,
        params,
    ).fetchall()

    return [
        {
            "symbol": row["symbol"],
            "date": row["trade_date"],
            "open": row["open"],
            "close": row["close"],
            "high": row["high"],
            "low": row["low"],
            "volume": row["volume"],
            "amount": row["amount"],
            "amplitude": row["amplitude"],
            "pctChange": row["pct_change"],
            "changeAmount": row["change_amount"],
            "turnover": row["turnover"],
        }
        for row in rows
    ]

def read_symbols_bars(conn, payload_path):
    if not payload_path:
        raise ValueError("payload is required for read-symbols-bars")

    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    raw_symbols = payload.get("symbols")
    if not isinstance(raw_symbols, list):
        raise ValueError("symbols must be a list")

    symbols = []
    seen = set()

    for item in raw_symbols:
        symbol = normalize_symbol(item)
        if symbol in seen:
            continue
        seen.add(symbol)
        symbols.append(symbol)

    start_iso = normalize_date(payload.get("startDate"))
    end_iso = normalize_date(payload.get("endDate"))

    bars_by_symbol = {symbol: [] for symbol in symbols}
    row_count = 0
    chunk_size = 700

    for offset in range(0, len(symbols), chunk_size):
        chunk = symbols[offset:offset + chunk_size]
        placeholders = ",".join(["?"] * len(chunk))
        params = list(chunk)
        filters = [f"symbol IN ({placeholders})"]

        if start_iso:
            filters.append("trade_date >= ?")
            params.append(start_iso)

        if end_iso:
            filters.append("trade_date <= ?")
            params.append(end_iso)

        rows = conn.execute(
            f"""
            SELECT
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
            FROM daily_bars
            WHERE {" AND ".join(filters)}
            ORDER BY symbol ASC, trade_date ASC
            """,
            params,
        ).fetchall()

        for row in rows:
            symbol = row["symbol"]
            bars_by_symbol.setdefault(symbol, []).append({
                "symbol": symbol,
                "date": row["trade_date"],
                "open": row["open"],
                "close": row["close"],
                "high": row["high"],
                "low": row["low"],
                "volume": row["volume"],
                "amount": row["amount"],
                "amplitude": row["amplitude"],
                "pctChange": row["pct_change"],
                "changeAmount": row["change_amount"],
                "turnover": row["turnover"],
            })
            row_count += 1

    return {
        "symbols": symbols,
        "symbolCount": len(symbols),
        "rowCount": row_count,
        "startDate": start_iso,
        "endDate": end_iso,
        "barsBySymbol": bars_by_symbol,
    }

def normalize_bar_tuple(symbol, bar):
    trade_date = normalize_date(bar.get("date") if isinstance(bar, dict) else "")
    if not trade_date:
        return None

    return (
        symbol,
        trade_date,
        normalize_number(bar.get("open")),
        normalize_number(bar.get("close")),
        normalize_number(bar.get("high")),
        normalize_number(bar.get("low")),
        normalize_number(bar.get("volume")),
        normalize_number(bar.get("amount")),
        normalize_number(bar.get("amplitude")),
        normalize_number(bar.get("pctChange")),
        normalize_number(bar.get("changeAmount")),
        normalize_number(bar.get("turnover")),
    )


def upsert_symbol_bars(conn, payload_path):
    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    clean_symbol = normalize_symbol(payload.get("symbol"))
    bars = payload.get("bars")
    if not isinstance(bars, list):
        raise ValueError("bars must be a list")

    rows = [
        item
        for item in (normalize_bar_tuple(clean_symbol, bar) for bar in bars)
        if item is not None
    ]

    inserted = 0
    try:
        conn.execute("BEGIN")
        conn.executemany(
            """
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
            ON CONFLICT(symbol, trade_date) DO UPDATE SET
              open = excluded.open,
              close = excluded.close,
              high = excluded.high,
              low = excluded.low,
              volume = excluded.volume,
              amount = COALESCE(excluded.amount, daily_bars.amount),
              amplitude = COALESCE(excluded.amplitude, daily_bars.amplitude),
              pct_change = COALESCE(excluded.pct_change, daily_bars.pct_change),
              change_amount = COALESCE(excluded.change_amount, daily_bars.change_amount),
              turnover = COALESCE(excluded.turnover, daily_bars.turnover)
            """,
            rows,
        )
        inserted = len(rows)
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise

    return {
        "inserted": inserted,
        "summary": symbol_summary(conn, clean_symbol),
    }

def normalize_index_bar_tuple(index_code, index_name, market, bar):
    trade_date = normalize_date(bar.get("date") if isinstance(bar, dict) else "")
    if not trade_date:
        return None

    return (
        index_code,
        str(index_name or bar.get("indexName") or index_code),
        str(market or bar.get("market") or "CN_INDEX"),
        trade_date,
        normalize_number(bar.get("open")),
        normalize_number(bar.get("high")),
        normalize_number(bar.get("low")),
        normalize_number(bar.get("close")),
        normalize_number(bar.get("volume")),
        normalize_number(bar.get("amount")),
        normalize_number(bar.get("amplitude")),
        normalize_number(bar.get("pctChange")),
        normalize_number(bar.get("changeAmount")),
        normalize_number(bar.get("turnover")),
        str(bar.get("source") or ""),
        str(bar.get("updatedAt") or ""),
    )


def index_summary(conn, index_code):
    clean_code = normalize_index_code(index_code)
    ensure_index_daily_bars_table(conn)
    row = conn.execute(
        """
        SELECT
          index_code,
          MAX(index_name) AS indexName,
          MAX(market) AS market,
          COUNT(*) AS barCount,
          MIN(trade_date) AS startDate,
          MAX(trade_date) AS endDate,
          MAX(source) AS source
        FROM index_daily_bars
        WHERE index_code = ?
        GROUP BY index_code
        """,
        (clean_code,),
    ).fetchone()

    if not row:
        return {
            "indexCode": clean_code,
            "indexName": "",
            "market": "",
            "barCount": 0,
            "startDate": "",
            "endDate": "",
            "source": "",
        }

    return {
        "indexCode": row["index_code"],
        "indexName": row["indexName"] or "",
        "market": row["market"] or "",
        "barCount": int(row["barCount"] or 0),
        "startDate": row["startDate"] or "",
        "endDate": row["endDate"] or "",
        "source": row["source"] or "",
    }


def read_index_bars(conn, index_code, start_date="", end_date=""):
    clean_code = normalize_index_code(index_code)
    ensure_index_daily_bars_table(conn)
    start_iso = normalize_date(start_date)
    end_iso = normalize_date(end_date)
    params = [clean_code]
    filters = ["index_code = ?"]

    if start_iso:
        filters.append("trade_date >= ?")
        params.append(start_iso)
    if end_iso:
        filters.append("trade_date <= ?")
        params.append(end_iso)

    rows = conn.execute(
        f"""
        SELECT
          index_code,
          index_name,
          market,
          trade_date,
          open,
          high,
          low,
          close,
          volume,
          amount,
          amplitude,
          pct_change,
          change_amount,
          turnover,
          source,
          updated_at
        FROM index_daily_bars
        WHERE {" AND ".join(filters)}
        ORDER BY trade_date ASC
        """,
        params,
    ).fetchall()

    return [
        {
            "indexCode": row["index_code"],
            "indexName": row["index_name"],
            "market": row["market"],
            "date": row["trade_date"],
            "open": row["open"],
            "high": row["high"],
            "low": row["low"],
            "close": row["close"],
            "volume": row["volume"],
            "amount": row["amount"],
            "amplitude": row["amplitude"],
            "pctChange": row["pct_change"],
            "changeAmount": row["change_amount"],
            "turnover": row["turnover"],
            "source": row["source"],
            "updatedAt": row["updated_at"],
        }
        for row in rows
    ]


def upsert_index_bars(conn, payload_path):
    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    clean_code = normalize_index_code(payload.get("indexCode"))
    index_name = str(payload.get("indexName") or clean_code)
    market = str(payload.get("market") or "CN_INDEX")
    bars = payload.get("bars")
    if not isinstance(bars, list):
        raise ValueError("bars must be a list")

    ensure_index_daily_bars_table(conn)
    rows = [
        item
        for item in (normalize_index_bar_tuple(clean_code, index_name, market, bar) for bar in bars)
        if item is not None
    ]

    inserted = 0
    try:
        conn.execute("BEGIN")
        conn.executemany(
            """
            INSERT INTO index_daily_bars (
              index_code,
              index_name,
              market,
              trade_date,
              open,
              high,
              low,
              close,
              volume,
              amount,
              amplitude,
              pct_change,
              change_amount,
              turnover,
              source,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(index_code, trade_date) DO UPDATE SET
              index_name = excluded.index_name,
              market = excluded.market,
              open = excluded.open,
              high = excluded.high,
              low = excluded.low,
              close = excluded.close,
              volume = COALESCE(excluded.volume, index_daily_bars.volume),
              amount = COALESCE(excluded.amount, index_daily_bars.amount),
              amplitude = COALESCE(excluded.amplitude, index_daily_bars.amplitude),
              pct_change = COALESCE(excluded.pct_change, index_daily_bars.pct_change),
              change_amount = COALESCE(excluded.change_amount, index_daily_bars.change_amount),
              turnover = COALESCE(excluded.turnover, index_daily_bars.turnover),
              source = COALESCE(NULLIF(excluded.source, ''), index_daily_bars.source),
              updated_at = COALESCE(NULLIF(excluded.updated_at, ''), index_daily_bars.updated_at)
            """,
            rows,
        )
        inserted = len(rows)
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise

    return {
        "inserted": inserted,
        "summary": index_summary(conn, clean_code),
    }


def build_index_daily_summary(conn):
    ensure_index_daily_bars_table(conn)
    rows = conn.execute(
        """
        SELECT
          index_code,
          MAX(index_name) AS indexName,
          MAX(market) AS market,
          COUNT(*) AS barCount,
          MIN(trade_date) AS startDate,
          MAX(trade_date) AS endDate,
          MAX(source) AS source
        FROM index_daily_bars
        GROUP BY index_code
        ORDER BY index_code ASC
        """
    ).fetchall()

    return {
        "items": {
            row["index_code"]: {
                "indexCode": row["index_code"],
                "indexName": row["indexName"] or "",
                "market": row["market"] or "",
                "barCount": int(row["barCount"] or 0),
                "startDate": row["startDate"] or "",
                "endDate": row["endDate"] or "",
                "source": row["source"] or "",
            }
            for row in rows
        },
        "indexedCount": len(rows),
        "totalBars": sum(int(row["barCount"] or 0) for row in rows),
    }

def build_index_summary(conn):
    rows = conn.execute(
        """
        SELECT
          symbol,
          COUNT(*) AS barCount,
          MIN(trade_date) AS startDate,
          MAX(trade_date) AS endDate
        FROM daily_bars
        GROUP BY symbol
        ORDER BY symbol ASC
        """
    ).fetchall()
    items = {}
    total_bars = 0

    for row in rows:
        symbol = normalize_symbol(row["symbol"])
        bar_count = int(row["barCount"] or 0)
        items[symbol] = {
            "symbol": symbol,
            "barCount": bar_count,
            "startDate": row["startDate"] or "",
            "endDate": row["endDate"] or "",
        }
        total_bars += bar_count

    return {
        "items": items,
        "indexedSymbols": len(items),
        "totalBars": total_bars,
    }


def run(args):
    conn = connect(args.db)
    try:
        if args.action in {
            "symbol-summary",
            "read-symbol-bars",
            "read-symbols-bars",
            "upsert-symbol-bars",
            "build-index-summary",
        }:
            ensure_daily_bars_table_exists(conn)

        if args.action == "symbol-summary":
            return symbol_summary(conn, args.symbol)

        if args.action == "read-symbol-bars":
            return {
                "symbol": normalize_symbol(args.symbol),
                "bars": read_symbol_bars(conn, args.symbol, args.start_date, args.end_date),
            }

        if args.action == "read-symbols-bars":
            return read_symbols_bars(conn, args.payload)

        if args.action == "upsert-symbol-bars":
            return upsert_symbol_bars(conn, args.payload)

        if args.action == "read-index-bars":
            return {
                "indexCode": normalize_index_code(args.index_code),
                "bars": read_index_bars(conn, args.index_code, args.start_date, args.end_date),
            }

        if args.action == "upsert-index-bars":
            return upsert_index_bars(conn, args.payload)

        if args.action == "index-summary":
            return index_summary(conn, args.index_code)

        if args.action == "build-index-daily-summary":
            return build_index_daily_summary(conn)

        if args.action == "build-index-summary":
            return build_index_summary(conn)

        raise ValueError(f"unknown action: {args.action}")
    finally:
        conn.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action")
    parser.add_argument("--db", required=True)
    parser.add_argument("--symbol", default="")
    parser.add_argument("--start-date", default="")
    parser.add_argument("--end-date", default="")
    parser.add_argument("--payload", default="")
    parser.add_argument("--index-code", default="")
    args = parser.parse_args()

    try:
        result = run(args)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except Exception as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(error),
                    "traceback": traceback.format_exc(),
                },
                ensure_ascii=False,
            )
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
