#!/usr/bin/env python3
"""Combined proxy server for Binance + Coinbase Monitor dashboard.
STALE-WHILE-REVALIDATE pattern. Dashboard NEVER shows 0 coins.
"""

import http.server
import json
import time
import urllib.request
import urllib.error
import os
import threading
import hashlib
import base64
import traceback

PORT = 8080
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

BINANCE_ENDPOINTS = [
    'https://data-api.binance.vision/api/v3',
]

os.makedirs(CACHE_DIR, exist_ok=True)

# ---- CACHE LAYER ----

mem_cache = {}
mem_lock = threading.Lock()
refreshing = set()
refresh_lock = threading.Lock()
fetch_semaphore = threading.Semaphore(10)  # max 10 concurrent upstream fetches


def _disk_path(key):
    return os.path.join(CACHE_DIR, hashlib.md5(key.encode()).hexdigest() + '.json')


def _save_disk(key, data, ct):
    try:
        path = _disk_path(key)
        tmp = path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump({
                'key': key,
                'content_type': ct,
                'timestamp': time.time(),
                'data_b64': base64.b64encode(data).decode('ascii'),
            }, f)
        os.replace(tmp, path)
    except Exception:
        traceback.print_exc()


def _load_disk(key):
    try:
        path = _disk_path(key)
        if not os.path.exists(path):
            return None
        with open(path, 'r') as f:
            p = json.load(f)
        return base64.b64decode(p['data_b64']), p['content_type'], p['timestamp']
    except Exception:
        return None


def cache_get(key):
    with mem_lock:
        m = mem_cache.get(key)
    if m:
        return m
    d = _load_disk(key)
    if d:
        with mem_lock:
            mem_cache[key] = d
        return d
    return None


def cache_set(key, data, ct):
    entry = (data, ct, time.time())
    with mem_lock:
        mem_cache[key] = entry
    threading.Thread(target=_save_disk, args=(key, data, ct), daemon=True).start()


def _do_fetch(urls, timeout=8):
    if not fetch_semaphore.acquire(timeout=2):
        return None  # too many concurrent fetches, skip
    try:
        return _do_fetch_inner(urls, timeout)
    finally:
        fetch_semaphore.release()

def _do_fetch_inner(urls, timeout=8):
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (compatible; CryptoMonitor/1.0)',
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
                ct = resp.headers.get('Content-Type', 'application/json')
            try:
                j = json.loads(data)
                if isinstance(j, dict) and j.get('code') in (-1003, -1015, -1000):
                    continue
            except:
                pass
            return data, ct
        except urllib.error.HTTPError as e:
            if e.code in (418, 429, 403):
                continue
            return None
        except Exception:
            continue
    return None


def _bg_refresh(key, urls, timeout=8):
    try:
        result = _do_fetch(urls, timeout)
        if result:
            cache_set(key, result[0], result[1])
    except Exception:
        traceback.print_exc()
    finally:
        with refresh_lock:
            refreshing.discard(key)


def cached_fetch(key, urls, ttl=120):
    cached = cache_get(key)
    if cached:
        data, ct, ts = cached
        age = time.time() - ts
        if age < ttl:
            return data, ct, 200
        with refresh_lock:
            if key not in refreshing:
                refreshing.add(key)
                threading.Thread(target=_bg_refresh, args=(key, urls, 20), daemon=True).start()
        return data, ct, 200
    result = _do_fetch(urls)
    if result:
        cache_set(key, result[0], result[1])
        return result[0], result[1], 200
    return json.dumps({'error': 'no data available'}).encode(), 'application/json', 502


# ---- HTTP HANDLER ----

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC_DIR, **kw)

    def do_GET(self):
        try:
            if self.path.startswith('/api/'):
                self._proxy_binance()
            elif self.path.startswith('/cb/'):
                self._proxy_coinbase()
            elif self.path.startswith('/cg/'):
                self._proxy_coingecko()
            elif self.path.startswith('/ex/'):
                self._proxy_exchange()
            else:
                super().do_GET()
        except Exception:
            traceback.print_exc()
            try:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"error":"internal"}')
            except:
                pass

    def _send(self, data, ct, status):
        self.send_response(status)
        self.send_header('Content-Type', ct)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def _proxy_binance(self):
        api_path = self.path[4:]
        ttl = 120
        if 'ticker/24hr' in api_path:
            ttl = 120
        elif 'depth' in api_path:
            ttl = 300
        elif 'exchangeInfo' in api_path:
            ttl = 900
        urls = [ep + api_path for ep in BINANCE_ENDPOINTS]
        data, ct, status = cached_fetch('binance:' + api_path, urls, ttl)
        self._send(data, ct, status)

    def _proxy_coinbase(self):
        api_path = self.path[3:]  # strip /cb
        ttl = 120
        if api_path.rstrip('/') == '/products':
            ttl = 300
        elif '/stats' in api_path:
            ttl = 120
        elif '/book' in api_path:
            ttl = 300
        url = 'https://api.exchange.coinbase.com' + api_path
        data, ct, status = cached_fetch('cb:' + api_path, [url], ttl)
        self._send(data, ct, status)

    def _proxy_coingecko(self):
        api_path = self.path[3:]
        url = 'https://api.coingecko.com/api/v3' + api_path
        data, ct, status = cached_fetch('cg:' + api_path, [url], ttl=300)
        self._send(data, ct, status)

    def _proxy_exchange(self):
        ex = self.path[4:]
        url_map = {
            'coinbase': 'https://api.exchange.coinbase.com/products',
            'binance': 'https://data-api.binance.vision/api/v3/exchangeInfo',
            'okx': 'https://www.okx.com/api/v5/public/instruments?instType=SPOT',
            'kraken': 'https://api.kraken.com/0/public/AssetPairs',
        }
        url = url_map.get(ex)
        if not url:
            self.send_response(404)
            self.end_headers()
            return
        data, ct, status = cached_fetch('exchange:' + ex, [url], ttl=1800)
        self._send(data, ct, status)

    def end_headers(self):
        if hasattr(self, 'path') and (self.path == '/' or self.path.endswith('.html') or self.path.endswith('.js') or self.path.endswith('.css')):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        msg = fmt % args
        if '/api/' in msg or '/cb/' in msg or '/cg/' in msg or '404' in msg or '500' in msg:
            super().log_message(fmt, *args)


if __name__ == '__main__':
    loaded = 0
    for cache_dir in [CACHE_DIR]:
        if not os.path.isdir(cache_dir):
            continue
        for fname in os.listdir(cache_dir):
            if not fname.endswith('.json'):
                continue
            try:
                with open(os.path.join(cache_dir, fname), 'r') as f:
                    p = json.load(f)
                mem_cache[p['key']] = (base64.b64decode(p['data_b64']), p['content_type'], p['timestamp'])
                loaded += 1
            except Exception:
                pass
    print(f'[INIT] Loaded {loaded} cache entries from disk')
    print(f'[INIT] Combined Binance+Coinbase proxy on port {PORT}')

    srv = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    srv.request_queue_size = 128
    srv.serve_forever()
