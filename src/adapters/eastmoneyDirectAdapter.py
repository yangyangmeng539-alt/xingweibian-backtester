import json
import os
import sys
import traceback


PROXY_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
]
_REQUESTS_PROXY_DISABLED = False


def get_network_mode():
    return str(os.environ.get("XWB_NETWORK_MODE") or "direct").strip().lower() or "direct"


def should_disable_proxy():
    return True


def clear_proxy_env():
    for key in PROXY_ENV_KEYS:
        os.environ.pop(key, None)

    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"


def disable_requests_proxy():
    global _REQUESTS_PROXY_DISABLED

    if _REQUESTS_PROXY_DISABLED:
        return

    try:
        import requests
    except Exception:
        return

    original_init = requests.sessions.Session.__init__
    original_request = requests.sessions.Session.request

    def no_proxy_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.trust_env = False

    def no_proxy_request(self, method, url, **kwargs):
        self.trust_env = False
        kwargs["proxies"] = {}
        return original_request(self, method, url, **kwargs)

    requests.sessions.Session.__init__ = no_proxy_init
    requests.sessions.Session.request = no_proxy_request
    _REQUESTS_PROXY_DISABLED = True


clear_proxy_env()
disable_requests_proxy()

from datetime import datetime
import urllib.parse
import urllib.request


EASTMONEY_HOSTS = (
    "push2his.eastmoney.com",
    "82.push2his.eastmoney.com",
    "91.push2his.eastmoney.com",
    "92.push2his.eastmoney.com",
)
EASTMONEY_KLINE_PATH = "/api/qt/stock/kline/get"
BASE_REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://quote.eastmoney.com/",
    "Origin": "https://quote.eastmoney.com",
    "Connection": "close",
}
TRANSPORT_ORDER = (
    "urllib_https",
    "urllib_http",
    "curl_cffi_https",
)
UNSUPPORTED_MARKET = "UNSUPPORTED_MARKET"


class UnsupportedMarketError(ValueError):
    def __init__(self, message):
        self.code = UNSUPPORTED_MARKET
        super().__init__(message)


class TransportFailure(RuntimeError):
    def __init__(self, host_errors, transport_errors, tried_hosts):
        self.host_errors = host_errors
        self.transport_errors = transport_errors
        self.tried_hosts = tried_hosts
        self.selected_host = ""
        self.selected_transport = ""
        super().__init__(format_transport_errors(transport_errors, host_errors, tried_hosts))


def build_request_headers(host):
    return {
        **BASE_REQUEST_HEADERS,
        "Host": host,
    }


def build_kline_url(host, scheme):
    return f"{scheme}://{host}{EASTMONEY_KLINE_PATH}"


def normalize_symbol(value):
    text = str(value or "").strip()
    if not text.isdigit() or len(text) != 6:
        raise ValueError(f"非法 A 股代码: {value}")
    return text


def normalize_date(value, fallback=""):
    text = str(value or fallback or "").strip().replace("-", "")
    if not text:
        return ""
    if not text.isdigit() or len(text) != 8:
        raise ValueError(f"非法日期: {value}")
    return text


def to_float(value):
    if value is None:
        return None

    text = str(value).strip()
    if text == "" or text == "-" or text.lower() == "nan":
        return None

    try:
        return float(text)
    except Exception:
        return None


def is_bj_market_symbol(symbol):
    text = str(symbol or "").strip()
    return text.startswith(("8", "4")) or text.startswith("920")


def infer_market(symbol):
    text = str(symbol or "").strip()

    if text.startswith("6"):
        return "SH"

    if text.startswith(("0", "3")):
        return "SZ"

    if is_bj_market_symbol(text):
        return "BJ"

    return "UNKNOWN"


def get_secid(symbol):
    market = infer_market(symbol)

    if market == "SH":
        return f"1.{symbol}"

    if market in ("SZ", "BJ"):
        return f"0.{symbol}"

    raise UnsupportedMarketError(f"{UNSUPPORTED_MARKET}: 东方财富直连暂不支持该市场代码: {symbol}")


def get_fqt(adjust):
    text = str(adjust or "qfq").strip().lower()

    if text == "hfq":
        return "2"

    if text in ("", "none", "bfq"):
        return "0"

    return "1"


def compact_error(error, limit=180):
    text = str(error or "未知错误").replace("\n", " ").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


def build_params(symbol, start_date, end_date, adjust):
    return {
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f116",
        "ut": "7eea3edcaed734bea9cbfc24409ed989",
        "klt": "101",
        "fqt": get_fqt(adjust),
        "secid": get_secid(symbol),
        "beg": start_date,
        "end": end_date,
    }


def read_urllib_url(url, params, host):
    clear_proxy_env()
    query = urllib.parse.urlencode(params)
    request_url = f"{url}?{query}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    headers = build_request_headers(host)

    opener.addheaders = list(headers.items())
    request = urllib.request.Request(request_url, headers=headers)

    with opener.open(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_response_body(body, symbol="", secid=""):
    text = str(body or "").strip()

    if not text:
        raise ValueError("空响应")

    payload = json.loads(text)
    data = payload.get("data")

    if data is None:
        raise UnsupportedMarketError(
            f"{UNSUPPORTED_MARKET}: 东方财富直连未返回 {symbol or '-'} secid={secid or '-'} 的日线数据"
        )

    if not isinstance(data, dict):
        raise ValueError("响应 data 格式异常")

    klines = data.get("klines")
    return klines if isinstance(klines, list) else []


def fetch_with_urllib(url, params, host):
    secid = params.get("secid", "")
    symbol = str(secid).split(".")[-1]
    return parse_response_body(read_urllib_url(url, params, host), symbol, secid)


def fetch_with_curl_cffi(url, params, host):
    clear_proxy_env()
    try:
        from curl_cffi import requests as curl_requests
    except Exception as error:
        raise RuntimeError(f"curl_cffi 不可用: {compact_error(error, 140)}")

    request_options = {
        "params": params,
        "headers": build_request_headers(host),
        "timeout": 30,
        "impersonate": "chrome",
        "proxies": {},
    }

    response = curl_requests.get(url, **request_options)

    if getattr(response, "status_code", 200) >= 400:
        raise RuntimeError(f"HTTP {response.status_code}")

    secid = params.get("secid", "")
    symbol = str(secid).split(".")[-1]
    return parse_response_body(response.text, symbol, secid)


def build_transport_error(error, host, transport, url):
    return {
        "host": host,
        "transport": transport,
        "url": url,
        "error": str(error),
        "traceback": traceback.format_exc(),
    }


def get_transport_error_text(value):
    if isinstance(value, dict):
        return value.get("error") or "未知错误"

    return str(value or "未知错误")


def format_host_transport_errors(errors):
    parts = [
        f"{name}={compact_error(get_transport_error_text(errors.get(name)), 140) if errors.get(name) else '未尝试'}"
        for name in TRANSPORT_ORDER
    ]
    return "; ".join(parts)


def format_transport_errors(transport_errors, host_errors=None, tried_hosts=None):
    hosts = tried_hosts or list(transport_errors.keys())
    parts = []

    for host in hosts:
        errors = transport_errors.get(host) or {}
        host_error = host_errors.get(host) if isinstance(host_errors, dict) else ""
        parts.append(f"{host}[{host_error or format_host_transport_errors(errors)}]")

    return f"东方财富直连失败：{' | '.join(parts)}"


def fetch_klines(symbol, start_date, end_date, adjust):
    clear_proxy_env()
    disable_requests_proxy()

    params = build_params(symbol, start_date, end_date, adjust)
    host_errors = {}
    transport_errors = {}
    tried_hosts = []

    attempts = (
        ("urllib_https", "https", fetch_with_urllib),
        ("urllib_http", "http", fetch_with_urllib),
        ("curl_cffi_https", "https", fetch_with_curl_cffi),
    )

    for host in EASTMONEY_HOSTS:
        tried_hosts.append(host)
        transport_errors[host] = {}

        for name, scheme, fetcher in attempts:
            url = build_kline_url(host, scheme)

            try:
                klines = fetcher(url, params, host)
                return (
                    klines,
                    f"eastmoney_direct:{name}",
                    host_errors,
                    transport_errors,
                    tried_hosts,
                    host,
                    name,
                )
            except UnsupportedMarketError:
                raise
            except Exception as error:
                transport_errors[host][name] = build_transport_error(error, host, name, url)
                host_errors[host] = format_host_transport_errors(transport_errors[host])

    raise TransportFailure(host_errors, transport_errors, tried_hosts)


def parse_klines(klines):
    bars = []

    for line in klines:
        parts = str(line or "").split(",")

        if len(parts) < 11:
            continue

        bars.append({
            "date": parts[0],
            "open": to_float(parts[1]),
            "close": to_float(parts[2]),
            "high": to_float(parts[3]),
            "low": to_float(parts[4]),
            "volume": to_float(parts[5]),
            "amount": to_float(parts[6]),
            "amplitude": to_float(parts[7]),
            "pctChange": to_float(parts[8]),
            "changeAmount": to_float(parts[9]),
            "turnover": to_float(parts[10]),
        })

    return bars


def main():
    clear_proxy_env()
    disable_requests_proxy()

    symbol = normalize_symbol(sys.argv[1] if len(sys.argv) > 1 else "")
    start_date = normalize_date(sys.argv[2] if len(sys.argv) > 2 else "20180101", "20180101")
    end_date = normalize_date(sys.argv[3] if len(sys.argv) > 3 else "", "")
    adjust = str(sys.argv[4] if len(sys.argv) > 4 else "qfq")
    market = infer_market(symbol)
    secid = get_secid(symbol)

    if not end_date:
        end_date = datetime.now().strftime("%Y%m%d")

    (
        klines,
        source,
        host_errors,
        transport_errors,
        tried_hosts,
        selected_host,
        selected_transport,
    ) = fetch_klines(symbol, start_date, end_date, adjust)
    bars = parse_klines(klines)

    print(json.dumps({
        "ok": True,
        "source": source,
        "symbol": symbol,
        "market": market,
        "secid": secid,
        "networkMode": get_network_mode(),
        "proxyDisabled": True,
        "hostErrors": host_errors,
        "transportErrors": transport_errors,
        "triedHosts": tried_hosts,
        "selectedHost": selected_host,
        "selectedTransport": selected_transport,
        "bars": bars,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "source": "eastmoney_direct",
            "networkMode": get_network_mode(),
            "proxyDisabled": True,
            "hostErrors": getattr(error, "host_errors", {}),
            "transportErrors": getattr(error, "transport_errors", {}),
            "triedHosts": getattr(error, "tried_hosts", []),
            "selectedHost": getattr(error, "selected_host", ""),
            "selectedTransport": getattr(error, "selected_transport", ""),
            "errorCode": getattr(error, "code", ""),
            "error": str(error),
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False))
