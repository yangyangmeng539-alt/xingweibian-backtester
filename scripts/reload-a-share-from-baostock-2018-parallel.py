import os
import json
import time
import sqlite3
import multiprocessing
from pathlib import Path
from datetime import datetime
from concurrent.futures import ProcessPoolExecutor, as_completed

for key in [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy"
]:
    os.environ.pop(key, None)

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

DB = Path("./data/cache/ashare-cache.sqlite")
PROGRESS_PATH = Path("./data/sync/baostock-a-reload-progress-2018.json")
PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)

START_DATE = "2018-01-01"
END_DATE = "2026-06-10"

FIELDS = "date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,isST"

MAX_WORKERS = int(os.environ.get("BAOSTOCK_WORKERS", "3"))
MAX_RETRY_PER_SYMBOL = 3


def now_text():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def clear_proxy_env():
    for key in [
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
        "http_proxy", "https_proxy", "all_proxy"
    ]:
        os.environ.pop(key, None)

    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"


def to_float(v):
    try:
        if v is None or v == "":
            return None
        return float(v)
    except Exception:
        return None


def round_optional(v, digits=4):
    if v is None:
        return None
    try:
        return round(float(v), digits)
    except Exception:
        return None


def load_progress():
    if not PROGRESS_PATH.exists():
        return {
            "startDate": START_DATE,
            "endDate": END_DATE,
            "createdAt": now_text(),
            "updatedAt": now_text(),
            "done": {},
            "failed": {},
            "skipped": {},
            "current": None
        }

    return json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))


def save_progress(progress):
    progress["updatedAt"] = now_text()
    PROGRESS_PATH.write_text(
        json.dumps(progress, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


def main_login():
    import baostock as bs

    try:
        bs.logout()
    except Exception:
        pass

    lg = bs.login()

    if str(lg.error_code) != "0":
        raise RuntimeError(f"BaoStock 登录失败: {lg.error_code} {lg.error_msg}")

    return bs


def query_universe():
    bs = main_login()

    try:
        rs = bs.query_stock_basic()

        if str(rs.error_code) != "0":
            raise RuntimeError(f"query_stock_basic failed: {rs.error_code} {rs.error_msg}")

        items = []

        while rs.error_code == "0" and rs.next():
            row = dict(zip(rs.fields, rs.get_row_data()))
            code = str(row.get("code") or "").strip()
            name = str(row.get("code_name") or "").strip()
            stock_type = str(row.get("type") or "").strip()
            status = str(row.get("status") or "").strip()

            if not (
                code.startswith("sh.6")
                or code.startswith("sz.0")
                or code.startswith("sz.3")
            ):
                continue

            if stock_type and stock_type != "1":
                continue

            if status and status != "1":
                continue

            symbol = code.split(".", 1)[1]

            if not symbol.isdigit() or len(symbol) != 6:
                continue

            items.append({
                "code": code,
                "symbol": symbol,
                "name": name,
                "ipoDate": row.get("ipoDate"),
                "outDate": row.get("outDate"),
                "type": stock_type,
                "status": status
            })

        items.sort(key=lambda x: x["symbol"])
        return items

    finally:
        try:
            bs.logout()
        except Exception:
            pass


_WORKER_BS = None


def worker_login():
    global _WORKER_BS

    clear_proxy_env()

    import baostock as bs

    try:
        bs.logout()
    except Exception:
        pass

    time.sleep(0.2)

    lg = bs.login()

    if str(lg.error_code) != "0":
        raise RuntimeError(f"worker BaoStock 登录失败: {lg.error_code} {lg.error_msg}")

    _WORKER_BS = bs


def worker_relogin():
    global _WORKER_BS

    try:
        if _WORKER_BS:
            _WORKER_BS.logout()
    except Exception:
        pass

    time.sleep(0.8)

    import baostock as bs
    lg = bs.login()

    if str(lg.error_code) != "0":
        raise RuntimeError(f"worker BaoStock 重登失败: {lg.error_code} {lg.error_msg}")

    _WORKER_BS = bs


def build_bar(symbol, raw):
    trade_status = str(raw.get("tradestatus") or "").strip()

    if trade_status and trade_status != "1":
        return None

    date = str(raw.get("date") or "").strip()
    open_v = to_float(raw.get("open"))
    high_v = to_float(raw.get("high"))
    low_v = to_float(raw.get("low"))
    close_v = to_float(raw.get("close"))
    preclose_v = to_float(raw.get("preclose"))
    volume_shares = to_float(raw.get("volume"))
    amount_v = to_float(raw.get("amount"))
    turn_v = to_float(raw.get("turn"))
    pct_v = to_float(raw.get("pctChg"))

    if not date:
        return None

    if (
        open_v is None
        or high_v is None
        or low_v is None
        or close_v is None
        or open_v <= 0
        or high_v <= 0
        or low_v <= 0
        or close_v <= 0
    ):
        return None

    change_amount = None
    if preclose_v is not None:
        change_amount = round_optional(close_v - preclose_v, 4)

    amplitude = None
    if preclose_v is not None and preclose_v > 0:
        amplitude = round_optional((high_v - low_v) / preclose_v * 100, 4)

    return (
        symbol,
        date,
        open_v,
        close_v,
        high_v,
        low_v,
        round_optional(volume_shares / 100, 4) if volume_shares is not None else None,
        amount_v,
        amplitude,
        pct_v,
        change_amount,
        turn_v
    )


def fetch_symbol_once(item):
    global _WORKER_BS

    if _WORKER_BS is None:
        worker_login()

    rs = _WORKER_BS.query_history_k_data_plus(
        item["code"],
        FIELDS,
        start_date=START_DATE,
        end_date=END_DATE,
        frequency="d",
        adjustflag="2"
    )

    if str(rs.error_code) != "0":
        raise RuntimeError(f"{rs.error_code}: {rs.error_msg}")

    rows = []

    while rs.error_code == "0" and rs.next():
        raw = dict(zip(rs.fields, rs.get_row_data()))
        bar = build_bar(item["symbol"], raw)

        if bar:
            rows.append(bar)

    if str(rs.error_code) != "0":
        raise RuntimeError(f"{rs.error_code}: {rs.error_msg}")

    rows.sort(key=lambda x: x[1])
    return rows


def fetch_symbol_worker(item):
    last_error = None

    for attempt in range(1, MAX_RETRY_PER_SYMBOL + 1):
        try:
            rows = fetch_symbol_once(item)

            return {
                "ok": True,
                "symbol": item["symbol"],
                "name": item.get("name") or "",
                "rows": rows,
                "error": None
            }

        except Exception as error:
            last_error = str(error)

            try:
                worker_relogin()
            except Exception as relogin_error:
                last_error = f"{last_error}; relogin={relogin_error}"

            time.sleep(1.5 * attempt)

    return {
        "ok": False,
        "symbol": item["symbol"],
        "name": item.get("name") or "",
        "rows": [],
        "error": last_error
    }


def write_rows(conn, rows):
    cur = conn.cursor()

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
    ON CONFLICT(symbol, trade_date) DO UPDATE SET
      open = excluded.open,
      close = excluded.close,
      high = excluded.high,
      low = excluded.low,
      volume = excluded.volume,
      amount = excluded.amount,
      amplitude = excluded.amplitude,
      pct_change = excluded.pct_change,
      change_amount = excluded.change_amount,
      turnover = excluded.turnover
    """, rows)

    conn.commit()


def check_symbol(conn, symbol):
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    row = cur.execute("""
    SELECT
      COUNT(*) AS rows,
      SUM(CASE WHEN amount IS NOT NULL AND amount > 0 THEN 1 ELSE 0 END) AS amount_rows,
      SUM(CASE WHEN turnover IS NOT NULL AND turnover > 0 THEN 1 ELSE 0 END) AS turnover_rows,
      MIN(trade_date) AS start_date,
      MAX(trade_date) AS end_date
    FROM daily_bars
    WHERE symbol = ?
    """, (symbol,)).fetchone()

    return dict(row) if row else {
        "rows": 0,
        "amount_rows": 0,
        "turnover_rows": 0,
        "start_date": None,
        "end_date": None
    }


def main():
    if not DB.exists():
        raise SystemExit(f"数据库不存在: {DB}")

    progress = load_progress()

    print("读取 BaoStock universe...")
    universe = query_universe()

    progress["universeCount"] = len(universe)
    save_progress(progress)

    done = progress.get("done") or {}
    failed = progress.get("failed") or {}
    skipped = progress.get("skipped") or {}

    todo = [
        item for item in universe
        if item["symbol"] not in done
        and item["symbol"] not in skipped
    ]

    total = len(universe)

    print({
        "total": total,
        "done": len(done),
        "failed_before": len(failed),
        "skipped": len(skipped),
        "todo": len(todo),
        "workers": MAX_WORKERS
    })

    conn = sqlite3.connect(str(DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    completed_this_run = 0

    with ProcessPoolExecutor(
        max_workers=MAX_WORKERS,
        initializer=worker_login
    ) as executor:
        future_map = {
            executor.submit(fetch_symbol_worker, item): item
            for item in todo
        }

        for future in as_completed(future_map):
            item = future_map[future]
            symbol = item["symbol"]
            name = item.get("name") or ""

            progress["current"] = {
                "symbol": symbol,
                "name": name,
                "time": now_text()
            }

            try:
                result = future.result()

                if not result.get("ok"):
                    failed[symbol] = {
                        "name": name,
                        "error": result.get("error") or "UNKNOWN_ERROR",
                        "time": now_text()
                    }

                    progress["failed"] = failed
                    save_progress(progress)

                    print(f"FAIL {symbol} {name} {failed[symbol]['error']}")
                    continue

                rows = result.get("rows") or []

                if not rows:
                    skipped[symbol] = {
                        "name": name,
                        "reason": "NO_ROWS",
                        "time": now_text()
                    }

                    failed.pop(symbol, None)

                    progress["skipped"] = skipped
                    progress["failed"] = failed
                    save_progress(progress)

                    print(f"SKIP {symbol} {name} NO_ROWS")
                    continue

                write_rows(conn, rows)
                check = check_symbol(conn, symbol)

                done[symbol] = {
                    "name": name,
                    "rows": check["rows"],
                    "amountRows": check["amount_rows"] or 0,
                    "turnoverRows": check["turnover_rows"] or 0,
                    "startDate": check["start_date"],
                    "endDate": check["end_date"],
                    "time": now_text()
                }

                failed.pop(symbol, None)

                progress["done"] = done
                progress["failed"] = failed
                progress["skipped"] = skipped
                save_progress(progress)

                completed_this_run += 1
                finished = len(done) + len(failed) + len(skipped)

                print(
                    f"DONE {symbol} {name} "
                    f"rows={check['rows']} amount={check['amount_rows']} turnover={check['turnover_rows']} "
                    f"{check['start_date']}→{check['end_date']} "
                    f"progress={finished}/{total}"
                )

            except KeyboardInterrupt:
                print("收到中断，已保存进度。")
                save_progress(progress)
                raise

            except Exception as error:
                failed[symbol] = {
                    "name": name,
                    "error": str(error),
                    "time": now_text()
                }

                progress["failed"] = failed
                save_progress(progress)

                print(f"FAIL {symbol} {name} {error}")

    conn.close()

    progress["current"] = None
    progress["finishedAt"] = now_text()
    save_progress(progress)

    print("\n=== BaoStock A股并发续拉完成 ===")
    print({
        "total": total,
        "done": len(progress.get("done") or {}),
        "failed": len(progress.get("failed") or {}),
        "skipped": len(progress.get("skipped") or {}),
        "workers": MAX_WORKERS,
        "completed_this_run": completed_this_run
    })


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
