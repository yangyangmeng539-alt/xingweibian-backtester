import json
import os
import sys
import urllib.parse
import urllib.request


_REQUESTS_PROXY_DISABLED = False
EASTMONEY_CLIST_URL = "https://80.push2.eastmoney.com/api/qt/clist/get"
EASTMONEY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://quote.eastmoney.com/",
}


def get_network_mode():
    return str(os.environ.get("XWB_NETWORK_MODE") or "system_proxy").strip().lower()


def should_disable_proxy():
    return get_network_mode() in ("direct", "auto_direct")


def clear_proxy_env():
    proxy_keys = [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ]

    for key in proxy_keys:
        os.environ.pop(key, None)

    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"


def disable_requests_proxy():
    global _REQUESTS_PROXY_DISABLED

    if _REQUESTS_PROXY_DISABLED:
        return

    import requests

    original_request = requests.sessions.Session.request

    def no_proxy_request(self, method, url, **kwargs):
        self.trust_env = False
        kwargs["proxies"] = {"http": None, "https": None}
        return original_request(self, method, url, **kwargs)

    requests.sessions.Session.request = no_proxy_request
    _REQUESTS_PROXY_DISABLED = True


def compact_error(error, limit=240):
    text = str(error or "未知错误").replace("\n", " ").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


def infer_market(symbol):
    text = str(symbol or "").strip()

    if text.startswith("6"):
        return "SH"

    if text.startswith(("0", "3")):
        return "SZ"

    if text.startswith(("8", "4")) or text.startswith("920"):
        return "BJ"

    return "UNKNOWN"


def normalize_symbol(value):
    text = str(value or "").strip()

    if text.endswith(".0"):
        text = text[:-2]

    digits = "".join(ch for ch in text if ch.isdigit())

    if len(digits) != 6:
        return ""

    return digits


def normalize_name(value):
    text = str(value or "").strip()
    if text.lower() in ("nan", "none"):
        return ""
    return text


def normalize_date(value):
    text = str(value or "").strip()
    if text.endswith(".0"):
        text = text[:-2]

    digits = "".join(ch for ch in text if ch.isdigit())

    if len(digits) != 8:
        return ""

    return digits


def get_value(row, names):
    for name in names:
        if name in row:
            return row[name]
    return None


def build_stock(symbol, name, list_date=None):
    stock = {
        "symbol": symbol,
        "name": normalize_name(name),
        "market": infer_market(symbol),
        "status": "ACTIVE"
    }
    normalized_list_date = normalize_date(list_date)

    if normalized_list_date:
        stock["listDate"] = normalized_list_date

    return stock


def merge_listing_dates(stocks, date_stocks):
    date_by_symbol = {
        stock.get("symbol"): stock.get("listDate")
        for stock in date_stocks
        if stock.get("symbol") and stock.get("listDate")
    }

    if not date_by_symbol:
        return stocks

    merged = []

    for stock in stocks:
        next_stock = dict(stock)
        list_date = date_by_symbol.get(stock.get("symbol"))

        if list_date:
            next_stock["listDate"] = list_date

        merged.append(next_stock)

    return merged


def fetch_akshare_universe():
    if should_disable_proxy():
        clear_proxy_env()
        disable_requests_proxy()

    import akshare as ak
    import pandas as pd

    if should_disable_proxy():
        disable_requests_proxy()

    df = ak.stock_info_a_code_name()

    if df is None or df.empty:
        return []

    df = df.where(pd.notnull(df), None)
    stocks = []
    seen = set()

    for _, raw_row in df.iterrows():
        row = raw_row.to_dict()
        symbol = normalize_symbol(get_value(row, ["code", "代码", "股票代码", "证券代码", "symbol"]))

        if not symbol or symbol in seen:
            continue

        seen.add(symbol)
        stocks.append(build_stock(symbol, get_value(row, ["name", "名称", "股票简称", "证券简称"])))

    return stocks


def read_url(url, params):
    query = urllib.parse.urlencode(params)
    request_url = f"{url}?{query}"

    if should_disable_proxy():
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    else:
        opener = urllib.request.build_opener()

    request = urllib.request.Request(request_url, headers=EASTMONEY_HEADERS)

    with opener.open(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_eastmoney_page(page):
    params = {
        "pn": page,
        "pz": 500,
        "po": 1,
        "np": 1,
        "ut": "bd1d9ddb04089700cf9c27f6f7426281",
        "fltt": 2,
        "invt": 2,
        "fid": "f12",
        "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81,m:1+t:3,m:0+t:7,m:1+t:1",
        "fields": "f12,f14,f26",
    }
    payload = json.loads(read_url(EASTMONEY_CLIST_URL, params))
    data = payload.get("data") or {}

    return {
        "total": int(data.get("total") or 0),
        "items": data.get("diff") or []
    }


def fetch_eastmoney_universe():
    stocks = []
    seen = set()
    page = 1
    total = 0

    while page <= 40:
        page_data = fetch_eastmoney_page(page)
        items = page_data["items"]
        total = page_data["total"] or total

        if not items:
            break

        for item in items:
            symbol = normalize_symbol(item.get("f12"))

            if not symbol or symbol in seen:
                continue

            seen.add(symbol)
            stocks.append(build_stock(symbol, item.get("f14"), item.get("f26")))

        if total and len(stocks) >= total:
            break

        page += 1

    return stocks


def main():
    errors = []

    try:
        stocks = fetch_akshare_universe()
        source = "akshare_stock_info_a_code_name"

        try:
            eastmoney_stocks = fetch_eastmoney_universe()
            enriched_stocks = merge_listing_dates(stocks, eastmoney_stocks)

            if any(stock.get("listDate") for stock in enriched_stocks):
                stocks = enriched_stocks
                source = "akshare_stock_info_a_code_name+eastmoney_list_date"
        except Exception as error:
            errors.append(f"Eastmoney listDate: {compact_error(error, 120)}")

        print(json.dumps({
            "ok": True,
            "source": source,
            "stocks": stocks
        }, ensure_ascii=False))
        return
    except Exception as error:
        errors.append(f"AKShare: {compact_error(error, 120)}")

    try:
        stocks = fetch_eastmoney_universe()
        print(json.dumps({
            "ok": True,
            "source": "eastmoney_quote_clist",
            "stocks": stocks
        }, ensure_ascii=False))
        return
    except Exception as error:
        errors.append(f"Eastmoney: {compact_error(error, 120)}")

    raise RuntimeError("; ".join(errors))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "source": "akshare_stock_info_a_code_name",
            "error": compact_error(error)
        }, ensure_ascii=False))
        sys.exit(1)
