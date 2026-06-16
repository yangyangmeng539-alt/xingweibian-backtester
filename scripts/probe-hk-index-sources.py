# -*- coding: utf-8 -*-
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

def print_ok(source, symbol, df):
    try:
        rows = len(df)
        cols = list(df.columns)
        first = df.iloc[0].to_dict() if rows else {}
        last = df.iloc[-1].to_dict() if rows else {}
        print(json.dumps({
            "ok": True,
            "source": source,
            "symbol": symbol,
            "rows": rows,
            "columns": cols,
            "first": first,
            "last": last
        }, ensure_ascii=False, default=str, indent=2))
    except Exception as e:
        print_fail(source, symbol, e)

def print_fail(source, symbol, err):
    print(json.dumps({
        "ok": False,
        "source": source,
        "symbol": symbol,
        "error": str(err)
    }, ensure_ascii=False, indent=2))

def try_akshare_sources():
    print("===== AKShare 探测 =====")
    try:
        import akshare as ak
    except Exception as e:
        print_fail("akshare_import", "-", e)
        return

    # 1) 先看全球指数现货里有没有恒生相关名称
    try:
        spot = ak.index_global_spot_em()
        cols = list(spot.columns)
        text_cols = [c for c in cols if c in ("名称", "name", "代码", "symbol")]
        hits = []

        for _, row in spot.iterrows():
            row_text = " ".join(str(row.get(c, "")) for c in cols)
            if "恒生" in row_text or "Hang Seng" in row_text or "HANG SENG" in row_text:
                hits.append({c: str(row.get(c, "")) for c in cols})

        print(json.dumps({
            "ok": True,
            "source": "ak.index_global_spot_em",
            "rows": len(spot),
            "columns": cols,
            "hang_seng_hits_count": len(hits),
            "hang_seng_hits_first_30": hits[:30]
        }, ensure_ascii=False, indent=2, default=str))
    except Exception as e:
        print_fail("ak.index_global_spot_em", "-", e)

    # 2) 全球指数历史：用中文名称直接试
    global_names = [
        "恒生指数",
        "恒生科技指数",
        "恒生中国企业指数",
        "恒生综合指数",
        "香港恒生指数",
        "香港恒生科技指数",
        "香港恒生中国企业指数",
        "香港恒生综合指数",
    ]

    for name in global_names:
        try:
            df = ak.index_global_hist_em(symbol=name)
            print_ok("ak.index_global_hist_em", name, df)
        except Exception as e:
            print_fail("ak.index_global_hist_em", name, e)
        time.sleep(0.6)

    # 3) 港股指数历史：直接试代码
    hk_index_symbols = [
        "HSI",
        "HSTECH",
        "HSCEI",
        "HSCI",
        "HSCCI",
        "HSCEILI",
    ]

    for symbol in hk_index_symbols:
        try:
            df = ak.stock_hk_index_daily_em(symbol=symbol)
            print_ok("ak.stock_hk_index_daily_em", symbol, df)
        except Exception as e:
            print_fail("ak.stock_hk_index_daily_em", symbol, e)
        time.sleep(0.6)

def yahoo_chart(symbol, start="20180101", end="20260612"):
    start_dt = datetime.strptime(start, "%Y%m%d").replace(tzinfo=timezone.utc)
    end_dt = datetime.strptime(end, "%Y%m%d").replace(tzinfo=timezone.utc)
    period1 = int(start_dt.timestamp())
    period2 = int(end_dt.timestamp())

    encoded = urllib.parse.quote(symbol, safe="")
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?period1={period1}&period2={period2}&interval=1d&events=history"

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json,text/plain,*/*",
        }
    )

    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8", errors="replace"))

    result = ((data.get("chart") or {}).get("result") or [None])[0]
    if not result:
        raise RuntimeError(json.dumps(data.get("chart", {}), ensure_ascii=False)[:500])

    ts = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    close = quote.get("close") or []
    open_ = quote.get("open") or []
    high = quote.get("high") or []
    low = quote.get("low") or []
    volume = quote.get("volume") or []

    rows = []
    for i, t in enumerate(ts):
        c = close[i] if i < len(close) else None
        if c is None:
            continue
        rows.append({
            "date": datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d"),
            "open": open_[i] if i < len(open_) else None,
            "high": high[i] if i < len(high) else None,
            "low": low[i] if i < len(low) else None,
            "close": c,
            "volume": volume[i] if i < len(volume) else None,
        })

    return rows

def try_yahoo_sources():
    print("===== Yahoo Chart 探测 =====")

    candidates = [
        ("恒生指数", "^HSI"),
        ("恒生科技", "^HSTECH"),
        ("恒生科技_备选", "HSTECH.HK"),
        ("恒生国企", "^HSCE"),
        ("恒生综合", "^HSCI.HK"),
        ("恒生综合_备选", "^HSCI"),
    ]

    for name, symbol in candidates:
        try:
            rows = yahoo_chart(symbol)
            print(json.dumps({
                "ok": True,
                "source": "yahoo_chart",
                "name": name,
                "symbol": symbol,
                "rows": len(rows),
                "first": rows[0] if rows else None,
                "last": rows[-1] if rows else None,
            }, ensure_ascii=False, indent=2))
        except Exception as e:
            print_fail("yahoo_chart", f"{name} {symbol}", e)
        time.sleep(0.6)

if __name__ == "__main__":
    try_akshare_sources()
    try_yahoo_sources()
