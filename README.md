# web2epub

Turn any web page into a clean EPUB e-book — with Hebrew right-to-left support, image galleries, and image compression.

## Three ways to use it

### 1. Userscript (in your browser)
Install [`web2epub.user.js`](web2epub.user.js) in [Tampermonkey](https://www.tampermonkey.net/). A **📖 EPUB** button appears on every page; click it, choose Hebrew (RTL) if needed, and the book downloads. Because it runs in your own session, pages behind a login work too.

### 2. Local web page (paste a URL)
Run the local server (see below) and open http://127.0.0.1:8777. Paste a URL and click download.

### 3. Headless browser mode
On the same page, tick **Render with JavaScript (headless browser)**. The server loads the page in Chromium via Playwright, scrolls it to load lazy content, blocks ad domains, and builds the EPUB there — best for JavaScript-heavy sites.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/playwright install chromium
.venv/bin/python web2epub-server.py        # or: web2epub-server.py 8778 for another port
```

The server listens on `127.0.0.1` only. Without Playwright it still works in fast mode; without Pillow, images are not compressed.

## Options

**Hebrew (RTL) · עברית** — auto-detected from the page, or set by hand. When on, the book gets:
- a right-to-left stylesheet (`direction: rtl; text-align: right`, etc.),
- `<dc:language>he</dc:language>` and `page-progression-direction="rtl"` on the spine,
- `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="he" dir="rtl">` on every page.

**Images: Max size and Quality** (local page) — images are resized (LANCZOS) and re-encoded as JPEG; EXIF is stripped, colour profiles kept, transparent PNGs and animations left alone, and the original is kept if it is smaller. Defaults are 1600 px / quality 75. Example from one photo-heavy page:

| Setting | Book size |
|---|---|
| Original (no compression) | 47.5 MB |
| 1600 px, quality 75 | 17.1 MB |
| 1200 px, quality 60 | 8.3 MB |
| 800 px, quality 50 | 3.8 MB |

## What it does

1. Converts the downloaded text to a DOM and reads metadata (title, author, language, cover).
2. Cleans it: unused, hidden and empty elements, comments, ads, icons, button leftovers, extra attributes and whitespace.
3. Replaces elements: heading levels, simple tags, unknown elements, CSS-styled bold/italic/pre, keeps line breaks.
4. Picks the main content, loads images, and turns image grids into clickable galleries.
5. Splits into chapters by headings and fixes links (internal anchors, external links, broken anchors).
6. Converts to XHTML and packs an EPUB 3 file (with `nav.xhtml` and `toc.ncx`) using JSZip.

Progress is shown as `progression: NN.NN %` for every step.

## Notes

- Check the result in your e-reader, or validate it with [epubcheck](https://github.com/w3c/epubcheck).
- Cross-origin images are fetched through the userscript's `GM_xmlhttpRequest` or the local server's proxy.
