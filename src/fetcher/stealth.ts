import { loadConfig } from "../config.js";

/**
 * Custom-header + hand-rolled browser-fingerprint helpers ("stealth-plus").
 *
 * This is "look like a normal browser" hardening that hand-implements the
 * standard evasions shipped by playwright-stealth / rebrowser-patches WITHOUT
 * any extra dependency. It covers the common headless tells: navigator.webdriver,
 * empty languages, missing plugins/mimeTypes, missing window.chrome, the
 * permissions.query Notification mismatch, the SwiftShader/headless WebGL vendor
 * strings, and low hardwareConcurrency/deviceMemory. Patched functions keep a
 * native-looking toString().
 *
 * Everything here is pure and network-free, and every browser-side patch is
 * wrapped in try/catch so a single failing patch can never break the page.
 */

/**
 * Parse the configured `extraHeaders` JSON object into a string->string map.
 *
 * - Returns {} when the value is missing or not valid JSON (never throws).
 * - Accepts only a plain object whose values are strings; numbers and booleans
 *   are coerced to strings; all other value types (objects, arrays, null) are
 *   dropped.
 */
export function parseExtraHeaders(raw: string | undefined = loadConfig().extraHeaders): Record<string, string> {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = String(value);
    } else if (typeof value === "boolean") {
      out[key] = String(value);
    }
    // drop nested objects/arrays/null/undefined
  }
  return out;
}

/**
 * A current, realistic desktop Chrome user-agent string.
 */
export function realisticUserAgent(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
}

/**
 * Browser context options that make a headless page look like a normal desktop
 * Chrome session. Intended to be spread into Playwright's `browser.newContext`.
 */
export function stealthContextOptions(): {
  userAgent: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
} {
  return {
    userAgent: realisticUserAgent(),
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1280, height: 800 }
  };
}

/**
 * A comprehensive init script (as a string) to inject via `page.addInitScript`.
 *
 * It hand-implements the evasions that playwright-stealth / rebrowser-patches
 * apply, with each block isolated in try/catch so one failing patch can never
 * break the page:
 *   - delete/undefine `navigator.webdriver`
 *   - set `navigator.languages` to ['en-US','en']
 *   - spoof a non-empty, plausible `navigator.plugins` + `navigator.mimeTypes`
 *   - define `window.chrome = { runtime: {} }`
 *   - patch `navigator.permissions.query` so the Notification probe returns the
 *     real permission shape instead of the headless mismatch
 *   - spoof WebGL UNMASKED_VENDOR_WEBGL (37445) / UNMASKED_RENDERER_WEBGL (37446)
 *   - set plausible `navigator.hardwareConcurrency` (8) and `deviceMemory` (8)
 *
 * Patched functions are wrapped so `Function.prototype.toString` still reports
 * `function ... { [native code] }`, defeating the common toString fingerprint.
 */
export function stealthInitScript(): string {
  return `(() => {
  // --- native-looking toString for patched functions ---------------------
  // Keep a registry of {patched -> string-to-report}. We override
  // Function.prototype.toString once so any patched fn looks native.
  var nativeToStringMap = new WeakMap();
  try {
    var fnToString = Function.prototype.toString;
    function patchedToString() {
      try {
        if (nativeToStringMap.has(this)) {
          return nativeToStringMap.get(this);
        }
      } catch (e) {}
      return fnToString.call(this);
    }
    // Make the override itself look native, and avoid infinite recursion.
    nativeToStringMap.set(patchedToString, "function toString() { [native code] }");
    Function.prototype.toString = patchedToString;
  } catch (e) {}

  function makeNative(fn, name) {
    try {
      var label = "function " + (name || (fn && fn.name) || "") + "() { [native code] }";
      nativeToStringMap.set(fn, label);
    } catch (e) {}
    return fn;
  }

  // --- navigator.webdriver ------------------------------------------------
  try {
    Object.defineProperty(navigator, 'webdriver', { get: makeNative(function () { return undefined; }, 'get webdriver'), configurable: true });
  } catch (e) {}
  try { delete navigator.webdriver; } catch (e) {}

  // --- navigator.languages ------------------------------------------------
  try {
    Object.defineProperty(navigator, 'languages', { get: makeNative(function () { return ['en-US', 'en']; }, 'get languages'), configurable: true });
  } catch (e) {}

  // --- navigator.plugins + navigator.mimeTypes ----------------------------
  try {
    var pluginData = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
    ];
    var mimeData = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
    ];

    var mimeArray = [];
    var pluginArray = [];

    function makePlugin(info) {
      var plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name: { value: info.name, enumerable: true },
        filename: { value: info.filename, enumerable: true },
        description: { value: info.description, enumerable: true },
        length: { value: mimeData.length, enumerable: true }
      });
      return plugin;
    }

    for (var p = 0; p < pluginData.length; p++) {
      pluginArray.push(makePlugin(pluginData[p]));
    }
    for (var m = 0; m < mimeData.length; m++) {
      var mime = Object.create(MimeType.prototype);
      Object.defineProperties(mime, {
        type: { value: mimeData[m].type, enumerable: true },
        suffixes: { value: mimeData[m].suffixes, enumerable: true },
        description: { value: mimeData[m].description, enumerable: true },
        enabledPlugin: { value: pluginArray[0], enumerable: true }
      });
      mimeArray.push(mime);
    }

    // Wire mimeTypes into each plugin (indexed + named access).
    for (var pi = 0; pi < pluginArray.length; pi++) {
      for (var mi = 0; mi < mimeArray.length; mi++) {
        pluginArray[pi][mi] = mimeArray[mi];
      }
      pluginArray[pi].item = makeNative(function (i) { return this[i]; }, 'item');
      pluginArray[pi].namedItem = makeNative(function (n) {
        for (var k = 0; k < this.length; k++) { if (this[k] && this[k].type === n) return this[k]; }
        return null;
      }, 'namedItem');
    }

    function buildArray(items, proto) {
      var arr = Object.create(proto);
      for (var i = 0; i < items.length; i++) {
        Object.defineProperty(arr, i, { value: items[i], enumerable: true });
      }
      Object.defineProperty(arr, 'length', { value: items.length });
      Object.defineProperty(arr, 'item', { value: makeNative(function (i) { return this[i] || null; }, 'item') });
      Object.defineProperty(arr, 'namedItem', { value: makeNative(function (n) {
        for (var k = 0; k < this.length; k++) {
          if (this[k] && (this[k].name === n || this[k].type === n)) return this[k];
        }
        return null;
      }, 'namedItem') });
      return arr;
    }

    var pluginsResult = buildArray(pluginArray, PluginArray.prototype);
    var mimeTypesResult = buildArray(mimeArray, MimeTypeArray.prototype);

    Object.defineProperty(navigator, 'plugins', { get: makeNative(function () { return pluginsResult; }, 'get plugins'), configurable: true });
    Object.defineProperty(navigator, 'mimeTypes', { get: makeNative(function () { return mimeTypesResult; }, 'get mimeTypes'), configurable: true });
  } catch (e) {}

  // --- window.chrome ------------------------------------------------------
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', { value: { runtime: {} }, writable: true, enumerable: true, configurable: true });
    } else if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
  } catch (e) {}

  // --- navigator.permissions.query ---------------------------------------
  try {
    if (navigator.permissions && navigator.permissions.query) {
      var originalQuery = navigator.permissions.query.bind(navigator.permissions);
      var patchedQuery = function (parameters) {
        try {
          if (parameters && parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission, onchange: null });
          }
        } catch (e) {}
        return originalQuery(parameters);
      };
      makeNative(patchedQuery, 'query');
      navigator.permissions.query = patchedQuery;
    }
  } catch (e) {}

  // --- WebGL vendor / renderer -------------------------------------------
  try {
    var spoofGl = function (proto) {
      if (!proto || !proto.getParameter) return;
      var getParameter = proto.getParameter;
      var patched = function (parameter) {
        // UNMASKED_VENDOR_WEBGL
        if (parameter === 37445) return 'Intel Inc.';
        // UNMASKED_RENDERER_WEBGL
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter.call(this, parameter);
      };
      makeNative(patched, 'getParameter');
      proto.getParameter = patched;
    };
    if (typeof WebGLRenderingContext !== 'undefined') spoofGl(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') spoofGl(WebGL2RenderingContext.prototype);
  } catch (e) {}

  // --- hardwareConcurrency / deviceMemory --------------------------------
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: makeNative(function () { return 8; }, 'get hardwareConcurrency'), configurable: true });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'deviceMemory', { get: makeNative(function () { return 8; }, 'get deviceMemory'), configurable: true });
  } catch (e) {}
})();`;
}

/**
 * Chromium launch args that hide the most obvious automation tells. Kept to a
 * small, safe set — no sandbox toggles, no site-isolation changes.
 */
export function stealthLaunchArgs(): string[] {
  return ["--disable-blink-features=AutomationControlled"];
}

/**
 * Launch options for `chromium.launch`. Combines {@link stealthLaunchArgs} with
 * `ignoreDefaultArgs: ["--enable-automation"]` so Chromium drops the
 * "Chrome is being controlled by automated test software" banner and the
 * automation flag it implies.
 */
export function stealthLaunchOptions(): { args: string[]; ignoreDefaultArgs: string[] } {
  return {
    args: stealthLaunchArgs(),
    ignoreDefaultArgs: ["--enable-automation"]
  };
}

/**
 * Best-effort static Client Hints headers consistent with the given UA. These
 * mirror what Chrome 126 on Windows sends and are intended for the HTTP fetch
 * path (which has no real Client Hints negotiation). Static by design —
 * derived from the desktop Chrome UA, not parsed exhaustively.
 */
export function uaClientHints(userAgent: string = realisticUserAgent()): Record<string, string> {
  const isMobile = /\bMobile\b|Android|iPhone|iPad/i.test(userAgent);
  let platform = '"Windows"';
  if (/Macintosh|Mac OS X/i.test(userAgent)) platform = '"macOS"';
  else if (/Android/i.test(userAgent)) platform = '"Android"';
  else if (/Linux/i.test(userAgent) && !/Android/i.test(userAgent)) platform = '"Linux"';
  else if (/CrOS/i.test(userAgent)) platform = '"Chrome OS"';

  const versionMatch = /Chrome\/(\d+)/i.exec(userAgent);
  const version = versionMatch ? versionMatch[1] : "126";

  return {
    "Sec-Ch-Ua": `"Chromium";v="${version}", "Not.A/Brand";v="24", "Google Chrome";v="${version}"`,
    "Sec-Ch-Ua-Mobile": isMobile ? "?1" : "?0",
    "Sec-Ch-Ua-Platform": platform
  };
}

/**
 * Merge header sources for an HTTP fetch.
 *
 * Precedence (later wins): base < stealth headers (only when `opts.stealth`) <
 * extra. The stealth set adds a realistic Accept-Language and User-Agent so a
 * bare HTTP client looks more like a browser; `extra` (e.g. user-configured
 * headers) always takes precedence over both.
 */
export function buildFetchHeaders(
  base: Record<string, string>,
  opts?: { stealth?: boolean; extra?: Record<string, string> }
): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  if (opts?.stealth) {
    Object.assign(merged, stealthHeaders());
  }
  if (opts?.extra) {
    Object.assign(merged, opts.extra);
  }
  return merged;
}

/**
 * A small set of realistic browser-ish request headers used by `buildFetchHeaders`
 * when stealth is enabled.
 */
function stealthHeaders(): Record<string, string> {
  return {
    "User-Agent": realisticUserAgent(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Ch-Ua": '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Upgrade-Insecure-Requests": "1"
  };
}
