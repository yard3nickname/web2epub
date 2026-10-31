#!/usr/bin/env python3
"""Local server for web2epub.html.

Two ways to load a page:
  * /render  - opens it in headless Chromium (Playwright), so JavaScript runs exactly as in a browser,
               then runs the web2epub pipeline inside it and streams progress back (Server-Sent Events).
  * /proxy   - plain download; the page then renders it in a hidden frame without scripts. Fast, no installs.

Images are compressed on the way in (resize to 1600px, JPEG quality 75, EXIF stripped, colour profile kept),
using the logic from photos-compress. Listens on 127.0.0.1 only.

Setup (once):
    python3 -m venv .venv
    .venv/bin/pip install playwright pillow pillow-heif
    .venv/bin/playwright install chromium
Run:
    .venv/bin/python web2epub-server.py          # then open http://127.0.0.1:8777
    .venv/bin/python web2epub-server.py 9000     # other port

Without the venv (plain python3) it still works: no headless mode and no image compression.
"""
import asyncio
import base64
import http.server
import io
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

try:
    from PIL import Image, ImageOps
    from pillow_heif import register_heif_opener

    register_heif_opener()
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    from playwright.async_api import async_playwright

    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
FILES = {
    '/': ('web2epub.html', 'text/html; charset=utf-8'),
    '/web2epub.html': ('web2epub.html', 'text/html; charset=utf-8'),
    '/web2epub.user.js': ('web2epub.user.js', 'text/javascript; charset=utf-8'),
}
USER_AGENT = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/130.0 Safari/537.36')
JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'

# Requests to these hosts are dropped in headless mode: ads, ad consent popups, trackers.
AD_HOSTS = (
    'googlesyndication.com', 'doubleclick.net', 'googleadservices.com', 'adservice.google.',
    'fundingchoicesmessages.google.com', 'google-analytics.com', 'googletagmanager.com',
    'amazon-adsystem.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net', 'adnxs.com',
    'facebook.net', 'hotjar.com',
)

# ------------------------------------------------------------------ images

COMPRESS_MAX_LENGTH = 1600
COMPRESS_QUALITY = 75


def compress_image_bytes(data, max_length=COMPRESS_MAX_LENGTH, quality=COMPRESS_QUALITY):
    """Bytes-in/bytes-out version of photos-compress ``core.compress_image``.

    Fixes orientation from EXIF, resizes so the long side is at most ``max_length`` (LANCZOS),
    saves an optimized JPEG, strips EXIF (privacy) and keeps the ICC profile (colours).
    Differences for web images: animated GIFs are left alone, images with real transparency stay PNG
    (JPEG would turn transparent areas black), and the original is kept when re-encoding wouldn't help.
    Returns (bytes, mime type), or None to keep the original.
    """
    if not HAS_PIL:
        return None
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        return None  # not something Pillow reads (SVG, ...): keep as is
    fmt = img.format
    if getattr(img, 'is_animated', False):
        return None
    icc_profile = img.info.get('icc_profile')
    img = ImageOps.exif_transpose(img)
    original_dimensions = img.size

    out_format = 'JPEG'
    if img.mode in ('RGBA', 'LA', 'PA') or (img.mode == 'P' and 'transparency' in img.info):
        rgba = img.convert('RGBA')
        if rgba.getextrema()[3][0] < 255:
            img, out_format = rgba, 'PNG'
        else:
            img = rgba.convert('RGB')
    elif img.mode not in ('RGB', 'L'):
        img = img.convert('RGB')

    width, height = img.size
    if max(width, height) > max_length:
        if width > height:
            new_width, new_height = max_length, round(height * (max_length / width))
        else:
            new_width, new_height = round(width * (max_length / height)), max_length
        img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

    save_kwargs = {'optimize': True}
    if out_format == 'JPEG':
        save_kwargs['quality'] = quality
    if icc_profile:
        save_kwargs['icc_profile'] = icc_profile
    buf = io.BytesIO()
    try:
        img.save(buf, out_format, **save_kwargs)
    except Exception:
        return None
    out = buf.getvalue()
    # A small, already-optimized JPEG/PNG can come out bigger; then the original is better.
    if fmt in ('JPEG', 'PNG') and len(out) >= len(data) and max(original_dimensions) <= max_length:
        return None
    return out, 'image/jpeg' if out_format == 'JPEG' else 'image/png'


def compression_settings(params):
    """Size/quality chosen on the page. max=0 means "Original": images are left untouched."""
    def num(key, default, lo, hi):
        try:
            return min(hi, max(lo, int(params.get(key, default))))
        except ValueError:
            return default
    max_length = num('max', COMPRESS_MAX_LENGTH, 0, 8000)
    if max_length == 0:
        return None
    return max(200, max_length), num('q', COMPRESS_QUALITY, 10, 100)


def human(n):
    return f'{n / 1e6:.1f} MB' if n >= 1e6 else f'{n / 1e3:.0f} KB'


def normalize_url(url):
    """Percent-encode a pasted URL (raw Hebrew etc.); None if it isn't http(s)."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname:
        return None
    netloc = parts.hostname.encode('idna').decode('ascii') + (f':{parts.port}' if parts.port else '')
    return urllib.parse.urlunsplit((
        parts.scheme, netloc,
        urllib.parse.quote(parts.path, safe="/%:@!$&'()*+,;=-._~"),
        urllib.parse.quote(parts.query, safe="=&%:@!$'()*+,;/?-._~"), ''))


def download(url, referer=None):
    """GET a URL. Returns (status, body, content type, final url)."""
    headers = {'User-Agent': USER_AGENT, 'Accept': '*/*', 'Accept-Language': 'he,en;q=0.8'}
    if referer:
        headers['Referer'] = referer
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as res:
            return 200, res.read(), res.headers.get('Content-Type', 'application/octet-stream'), res.geturl()
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get('Content-Type', 'text/plain'), url


def download_image(url, referer=None, settings=(COMPRESS_MAX_LENGTH, COMPRESS_QUALITY)):
    """Download an image and compress it with ``settings`` = (max length, quality), or keep it as is
    when ``settings`` is None. Returns (body, content type, original size) or raises."""
    if url.startswith('data:'):
        with urllib.request.urlopen(url) as res:
            data, ctype = res.read(), res.headers.get('Content-Type', '')
    else:
        target = normalize_url(url)
        if not target:
            raise ValueError('not an http(s) url: ' + url)
        status, data, ctype, _ = download(target, referer)
        if status != 200:
            raise ValueError(f'HTTP {status}')
    small = compress_image_bytes(data, *settings) if settings else None
    return (*small, len(data)) if small else (data, ctype, len(data))


# ---------------------------------------------------------- headless mode

SCROLL_JS = """async () => {
  // Scroll down in steps so lazy-loaded images and sections load, then back to the top.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last = -1;
  for (let i = 0; i < 80 && window.scrollY !== last; i++) {
    last = window.scrollY;
    window.scrollBy(0, Math.round(window.innerHeight * 0.8));
    await sleep(150);
  }
  window.scrollTo(0, 0);
  await sleep(300);
}"""

DETECT_RTL_JS = """() => {
  const root = document.documentElement, lang = (root.lang || '').toLowerCase();
  return lang.startsWith('he') || lang.startsWith('iw') || root.dir === 'rtl' || document.body?.dir === 'rtl' ||
    /[\\u0590-\\u05FF]/.test((document.title || '') + (document.body?.innerText || '').slice(0, 2000));
}"""

RUN_JS = """async (rtl) => {
  // Image sizes are handled by the server (or deliberately left original), so no in-browser shrinking.
  const toBuffer = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
  const ctx = await window.web2epub.run({
    rtl,
    fullSizeMax: Infinity,
    fetchBinary: async (u) => {
      const r = await window.__w2eFetchImage(u);
      if (r.error) throw new Error(r.error);
      return { data: toBuffer(r.b64), type: r.type };
    },
    onLog: (l) => window.__w2eEmit('log', l),
    onProgress: (p) => window.__w2eEmit('progress', p),
  });
  return { chapters: ctx.chapters.length, images: ctx.images.length };
}"""


class Renderer:
    """Owns one headless Chromium on its own thread/event loop; HTTP threads submit jobs to it."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self.browser = None
        self.lock = None

    def submit(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    async def get_browser(self):
        self.lock = self.lock or asyncio.Lock()
        async with self.lock:
            if not self.browser or not self.browser.is_connected():
                pw = await async_playwright().start()
                self.browser = await pw.chromium.launch(headless=True)
        return self.browser

    async def render(self, url, rtl, settings, emit):
        context = None
        totals = {'before': 0, 'after': 0}
        try:
            browser = await self.get_browser()
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 900}, user_agent=USER_AGENT, locale='he-IL',
                bypass_csp=True, accept_downloads=True)

            async def block_ads(route):
                host = urllib.parse.urlsplit(route.request.url).hostname or ''
                if any(h in host for h in AD_HOSTS):
                    await route.abort()
                else:
                    await route.continue_()
            await context.route('**/*', block_ads)

            page = await context.new_page()
            emit('log', 'Opening page in headless browser…')
            await page.goto(url, wait_until='domcontentloaded', timeout=60000)
            try:
                await page.wait_for_load_state('networkidle', timeout=15000)
            except Exception:
                pass  # some pages never go quiet; carry on
            emit('log', 'Scrolling to load lazy content…')
            await page.evaluate(SCROLL_JS)
            try:
                await page.wait_for_load_state('networkidle', timeout=10000)
            except Exception:
                pass

            if rtl == 'auto':
                rtl_on = await page.evaluate(DETECT_RTL_JS)
                emit('rtl', rtl_on)
            else:
                rtl_on = rtl == '1'

            async def fetch_image(image_url):
                try:
                    data, ctype, original = await asyncio.to_thread(download_image, image_url, page.url, settings)
                    totals['before'] += original
                    totals['after'] += len(data)
                    return {'b64': base64.b64encode(data).decode('ascii'), 'type': ctype}
                except Exception as e:
                    return {'error': str(e)}
            await page.expose_function('__w2eFetchImage', fetch_image)
            await page.expose_function('__w2eEmit', lambda kind, value: emit(kind, value))
            await page.evaluate('window.__w2eNoUi = true')
            await page.add_script_tag(url=JSZIP_URL)
            with open(os.path.join(HERE, 'web2epub.user.js'), encoding='utf-8') as f:
                await page.add_script_tag(content=f.read())

            emit('log', 'Compressing images: ' + (f'max {settings[0]}px, quality {settings[1]}' if settings else 'off (original files)'))
            async with page.expect_download(timeout=15 * 60 * 1000) as download_info:
                stats = await page.evaluate(RUN_JS, rtl_on)
            dl = await download_info.value
            with open(await dl.path(), 'rb') as f:
                data = f.read()
            if totals['before']:
                saved = 100 - totals['after'] * 100 / totals['before']
                emit('log', f"Images: {human(totals['before'])} → {human(totals['after'])} (−{saved:.0f}%)")
            result_id = uuid.uuid4().hex
            RESULTS[result_id] = (dl.suggested_filename or 'page.epub', data, time.time())
            emit('done', {'id': result_id, 'name': dl.suggested_filename, 'size': len(data), **stats})
        except Exception as e:
            emit('fail', f'{type(e).__name__}: {e}'.split('\n')[0])
        finally:
            if context:
                await context.close()


RENDERER = Renderer() if HAS_PLAYWRIGHT else None
RESULTS = {}  # id -> (file name, epub bytes, created); handed out once, dropped after 30 minutes


# ------------------------------------------------------------------ http

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Only answer requests addressed to this machine (blocks DNS-rebinding tricks from other sites).
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0]
        if host not in ('127.0.0.1', 'localhost'):
            return self.send_error(403)
        path, _, query = self.path.partition('?')
        params = {k: v[0] for k, v in urllib.parse.parse_qs(query).items()}
        if path in FILES:
            name, ctype = FILES[path]
            with open(os.path.join(HERE, name), 'rb') as f:
                return self.reply(200, f.read(), ctype)
        if path == '/status':
            return self.reply(200, json.dumps({'headless': HAS_PLAYWRIGHT, 'compress': HAS_PIL}).encode(),
                              'application/json')
        if path == '/proxy':
            return self.proxy(params.get('url', ''), params.get('image') == '1', compression_settings(params))
        if path == '/render':
            return self.render(params.get('url', ''), params.get('rtl', 'auto'), compression_settings(params))
        if path.startswith('/result/'):
            return self.result(path[len('/result/'):])
        self.send_error(404)

    def proxy(self, url, image, settings):
        target = normalize_url(url)
        if not target:
            return self.send_error(400, 'url must be http(s)')
        try:
            if image:
                body, ctype, original = download_image(target, None, settings)
                return self.reply(200, body, ctype, {'X-Original-Size': str(original)})
            status, body, ctype, final = download(target)
            # Tell the page where redirects ended up, so relative links resolve correctly.
            return self.reply(status, body, ctype, {'X-Final-Url': final})
        except Exception as e:  # network errors, timeouts, bad hosts
            return self.reply(502, str(e).encode(), 'text/plain; charset=utf-8')

    def render(self, url, rtl, settings):
        if not RENDERER:
            return self.send_error(501, 'Playwright is not installed')
        target = normalize_url(url)
        if not target:
            return self.send_error(400, 'url must be http(s)')
        events = queue.Queue()
        RENDERER.submit(RENDERER.render(target, rtl, settings, lambda kind, value: events.put((kind, value))))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        while True:
            kind, value = events.get()
            try:
                self.wfile.write(f'event: {kind}\ndata: {json.dumps(value, ensure_ascii=False)}\n\n'.encode('utf-8'))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return  # the page was closed; the render finishes on its own
            if kind in ('done', 'fail'):
                return

    def result(self, result_id):
        for k, (_, _, created) in list(RESULTS.items()):
            if time.time() - created > 1800:
                RESULTS.pop(k, None)
        item = RESULTS.pop(result_id, None)
        if not item:
            return self.send_error(404, 'expired')
        name, data, _ = item
        quoted = urllib.parse.quote(name)
        return self.reply(200, data, 'application/epub+zip', {
            'Content-Disposition': f"attachment; filename=\"book.epub\"; filename*=UTF-8''{quoted}"})

    def reply(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write('  ' + (fmt % args) + '\n')


if __name__ == '__main__':
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'web2epub: open http://127.0.0.1:{PORT}  (Ctrl+C to stop)')
    print(f'  headless browser: {"on" if HAS_PLAYWRIGHT else "off (run with .venv/bin/python)"}'
          f' | image compression: {"on" if HAS_PIL else "off"}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
