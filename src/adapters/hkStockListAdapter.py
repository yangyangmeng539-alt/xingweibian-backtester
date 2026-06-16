import json
import os
import re
import sys
import time
import traceback


PROXY_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
]

_ORIGINAL_PROXY_ENV = {key: os.environ.get(key) for key in PROXY_ENV_KEYS if os.environ.get(key)}


def get_network_mode():
    return str(os.environ.get("XWB_NETWORK_MODE") or "direct").strip().lower() or "direct"


def clear_proxy_env():
    for key in PROXY_ENV_KEYS:
        os.environ.pop(key, None)

    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"


def restore_proxy_env():
    for key in PROXY_ENV_KEYS:
        os.environ.pop(key, None)

    for key, value in _ORIGINAL_PROXY_ENV.items():
        os.environ[key] = value


def get_mode_plan(requested_mode):
    mode = str(requested_mode or "direct").strip().lower()

    if mode == "system_proxy":
        return [("system_proxy", True)]

    if mode == "auto":
        plan = [("direct", False)]

        if _ORIGINAL_PROXY_ENV:
            plan.append(("system_proxy", True))

        return plan

    return [("direct", False)]


def make_session(use_proxy=False):
    import requests

    if use_proxy:
        restore_proxy_env()
    else:
        clear_proxy_env()

    session = requests.Session()
    session.trust_env = bool(use_proxy)
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json,text/plain,*/*",
        "Connection": "close",
        "Referer": "https://quote.eastmoney.com/"
    })
    return session


def normalize_hk_code(value):
    digits = "".join(ch for ch in str(value or "").strip() if ch.isdigit())

    if not digits or len(digits) > 5:
        return ""

    return digits.zfill(5)

def is_probably_derivative_or_fund(code, name):
    clean_code = normalize_hk_code(code)
    raw_name = str(name or "").strip()
    clean_name = raw_name.upper().replace(" ", "")

    if not clean_code or not clean_name:
        return True

    # 名字就是代码，说明是占位 / 特殊证券 / 无有效名称，不进入普通股票池。
    if clean_name == clean_code or clean_name.isdigit():
        return True

    # 04xxx 在腾讯扫描样本里大量是非普通公司股票、占位、特殊证券。
    if clean_code.startswith("04"):
        return True

    # 港股临时代码 / 旧代码 / 股权代码 / 特殊手数代码，不进入第一版普通股票池。
    dirty_name_keywords = [
        "(旧)",
        "（旧）",
        "-旧",
        "旧)",
        "旧）",
        "股权",
        "一万",
        "二万",
        "三万",
        "四万",
        "五万",
        "八千",
        "五千",
        "二千",
        "一千"
    ]

    if any(keyword in clean_name for keyword in dirty_name_keywords):
        return True

    hard_keywords = [
        "ETF",
        "ETN",
        "基金",
        "债",
        "债券",
        "票据",
        "优先股",
        "认股证",
        "权证",
        "牛证",
        "熊证",
        "牛熊",
        "购证",
        "沽证",
        "CALL",
        "PUT",
        "MPF",
        "港交所科技",
        "恒指",
        "国指",
        "科指",
        "纳指",
        "道指",
        "标普",
        "日经",
        "安硕",
        "ISHARES",
        "PREMIA",
        "南方东英",
        "华夏",
        "易方达",
        "博时",
        "嘉实",
        "广发",
        "三星",
        "GLOBALX",
        "SPDR",
        "VALUEGOLD",
        "法兴",
        "摩通",
        "瑞银",
        "高盛",
        "花旗",
        "汇丰瑞",
        "海通法",
        "麦银",
        "中银瑞",
        "瑞信",
        "星展",
        "巴克莱",
        "摩利",
        "荷合"
    ]

    if any(keyword in clean_name for keyword in hard_keywords):
        return True

    derivative_issuer_keywords = [
        "摩通",
        "瑞银",
        "法兴",
        "高盛",
        "花旗",
        "摩利",
        "汇丰",
        "海通",
        "麦银",
        "瑞信",
        "星展"
    ]

    if any(keyword in clean_name for keyword in derivative_issuer_keywords) and ("购" in clean_name or "沽" in clean_name):
        return True

    if clean_name.endswith("-R") or clean_name.endswith("－R"):
        return True

    return False

def normalize_stock(raw):
    code = normalize_hk_code(raw.get("f12"))
    name = str(raw.get("f14") or "").strip()

    if not code or is_probably_derivative_or_fund(code, name):
        return None

    return {
        "symbol": f"HK:{code}",
        "code": code,
        "name": name,
        "market": "HK",
        "exchange": "HKEX",
        "currency": "HKD",
        "source": raw.get("_source") or "eastmoney_hk_clist_direct",
        "rawMarket": raw.get("f13"),
        "industry": raw.get("f100") or ""
    }


def fetch_eastmoney_hk_list(session):
    url = "https://push2.eastmoney.com/api/qt/clist/get"
    fields = "f12,f13,f14,f100,f102,f103"
    fs_candidates = [
        "m:128+t:3,m:128+t:4,m:128+t:1,m:128+t:2",
        "m:128"
    ]
    all_rows = []
    errors = []

    for fs in fs_candidates:
        page = 1
        empty_pages = 0

        while page <= 80:
            params = {
                "pn": str(page),
                "pz": "500",
                "po": "1",
                "np": "1",
                "fltt": "2",
                "invt": "2",
                "fid": "f12",
                "fs": fs,
                "fields": fields,
                "ut": "bd1d9ddb04089700cf9c27f6f7426281",
                "_": str(int(time.time() * 1000))
            }

            try:
                response = session.get(url, params=params, timeout=20)
                response.raise_for_status()
                payload = response.json()
                data = payload.get("data") or {}
                rows = data.get("diff") or []
            except Exception as error:
                errors.append(f"fs={fs} page={page} failed: {error}")
                break

            if not rows:
                empty_pages += 1
                if empty_pages >= 1:
                    break
            else:
                all_rows.extend(rows)

            total = int((data.get("total") or 0) if str(data.get("total") or "").isdigit() else 0)
            if total and page * 500 >= total:
                break

            page += 1
            time.sleep(0.15)

        if all_rows:
            break

    return all_rows, errors

def decode_response_text(response):
    raw = response.content or b""

    # 腾讯 quote 常见是 GBK/GB18030；不能先用 utf-8 + ignore，否则会吞字节导致乱码。
    for encoding in ("gb18030", "gbk", "utf-8"):
        try:
            text = raw.decode(encoding, errors="strict")
            if text:
                return text
        except Exception:
            continue

    for encoding in ("gb18030", "gbk", "utf-8"):
        try:
            text = raw.decode(encoding, errors="ignore")
            if text:
                return text
        except Exception:
            continue

    return response.text or ""


def parse_tencent_hk_quote_line(line):
    text = str(line or "").strip()

    if not text or "=" not in text:
        return None

    left, right = text.split("=", 1)
    code_match = re.search(r"r_hk(\d{5})", left)

    if not code_match:
        return None

    code = normalize_hk_code(code_match.group(1))
    payload = right.strip().strip(";").strip().strip('"')

    if not payload:
        return None

    parts = payload.split("~")

    if len(parts) < 3:
        return None

    name = str(parts[1] or "").strip()
    quoted_code = normalize_hk_code(parts[2] if len(parts) > 2 else code)

    if not quoted_code:
        quoted_code = code

    if not name or name in ("--", "N/A", "NA", "null", "None"):
        return None

    if is_probably_derivative_or_fund(quoted_code, name):
        return None

    return {
        "f12": quoted_code,
        "f14": name,
        "f13": "HK",
        "f100": "",
        "_source": "tencent_hk_quote_scan"
    }


def fetch_tencent_hk_scan_list(session):
    # 不依赖“股票列表接口”，直接扫 00001~09999 的港股 quote。
    # 这比 clist 慢一点，但更稳，逻辑类似 A 股当初多源兜底。
    url = "https://qt.gtimg.cn/q="
    batch_size = 120
    max_code = 9999
    rows = []
    errors = []

    codes = [str(index).zfill(5) for index in range(1, max_code + 1)]

    for offset in range(0, len(codes), batch_size):
        batch = codes[offset:offset + batch_size]
        query = ",".join(f"r_hk{code}" for code in batch)

        try:
            response = session.get(
                url,
                params={"q": query},
                timeout=20
            )
            response.raise_for_status()
            text = decode_response_text(response)

            for line in text.splitlines():
                item = parse_tencent_hk_quote_line(line)

                if item:
                    rows.append(item)
        except Exception as error:
            errors.append(f"tencent scan {batch[0]}-{batch[-1]} failed: {error}")

        time.sleep(0.08)

    return rows, errors

def dedupe_filter_stocks(rows):
    seen = set()
    stocks = []
    raw_count = 0

    for raw in rows or []:
        raw_count += 1
        stock = normalize_stock(raw if isinstance(raw, dict) else {})

        if not stock:
            continue

        symbol = stock["symbol"]

        if symbol in seen:
            continue

        seen.add(symbol)
        stocks.append(stock)

    stocks.sort(key=lambda item: item["symbol"])
    return raw_count, stocks


def fetch_with_network_mode(mode_name, use_proxy):
    session = make_session(use_proxy=use_proxy)
    all_errors = []

    rows, errors = fetch_eastmoney_hk_list(session)
    all_errors.extend(errors or [])
    raw_count, stocks = dedupe_filter_stocks(rows)

    if stocks:
        return {
            "ok": True,
            "source": "eastmoney_hk_clist_direct",
            "networkMode": mode_name,
            "proxyDisabled": not use_proxy,
            "rawCount": raw_count,
            "filteredCount": len(stocks),
            "stocks": stocks,
            "warnings": all_errors
        }

    tencent_rows, tencent_errors = fetch_tencent_hk_scan_list(session)
    all_errors.extend(tencent_errors or [])
    tencent_raw_count, tencent_stocks = dedupe_filter_stocks(tencent_rows)

    if tencent_stocks:
        return {
            "ok": True,
            "source": "tencent_hk_quote_scan",
            "networkMode": mode_name,
            "proxyDisabled": not use_proxy,
            "rawCount": tencent_raw_count,
            "filteredCount": len(tencent_stocks),
            "stocks": tencent_stocks,
            "warnings": all_errors
        }

    return {
        "ok": False,
        "networkMode": mode_name,
        "proxyDisabled": not use_proxy,
        "rawCount": raw_count + tencent_raw_count,
        "filteredCount": 0,
        "errors": all_errors or ["港股列表返回空数据"]
    }


def main():
    requested_mode = get_network_mode()
    all_errors = []

    for mode_name, use_proxy in get_mode_plan(requested_mode):
        result = fetch_with_network_mode(mode_name, use_proxy)

        if result.get("ok"):
            print(json.dumps(result, ensure_ascii=False))
            return

        all_errors.extend(result.get("errors") or [])

    print(json.dumps({
        "ok": False,
        "source": "eastmoney_hk_clist_direct",
        "market": "HK",
        "networkMode": requested_mode,
        "proxyDisabled": requested_mode != "system_proxy",
        "error": "港股股票列表拉取失败。",
        "errors": all_errors
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "source": "eastmoney_hk_clist_direct",
            "market": "HK",
            "networkMode": get_network_mode(),
            "proxyDisabled": get_network_mode() != "system_proxy",
            "error": str(error),
            "traceback": traceback.format_exc()
        }, ensure_ascii=False))