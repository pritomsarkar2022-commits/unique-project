(() => {
  var __defProp = Object.defineProperty;
  var __typeError = (msg) => {
    throw TypeError(msg);
  };
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
  var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
  var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
  var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
  var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

  // site/src/engine/browserBuffer.mjs
  var HEX_VALUE = /* @__PURE__ */ new Map();
  for (let i = 0; i < 16; i++) {
    HEX_VALUE.set("0123456789abcdef".charCodeAt(i), i);
    HEX_VALUE.set("0123456789ABCDEF".charCodeAt(i), i);
  }
  var HEX_PAIR = [];
  for (let i = 0; i < 256; i++) {
    HEX_PAIR.push(i.toString(16).padStart(2, "0"));
  }
  var UTF8_TEXT = new TextDecoder("utf-8");
  var UTF8_BYTES = new TextEncoder();
  function bytesOf(value, encoding = "utf8") {
    if (typeof value === "string") {
      if (encoding === "latin1" || encoding === "binary") {
        const out2 = new Uint8Array(value.length);
        for (let i = 0; i < value.length; i++) {
          out2[i] = value.charCodeAt(i) & 255;
        }
        return out2;
      }
      if (encoding === "utf8" || encoding === "utf-8") {
        return UTF8_BYTES.encode(value);
      }
      if (encoding !== "hex") {
        throw new TypeError("browserBuffer only reads latin1, utf8 and hex, not " + encoding);
      }
      const out = new Uint8Array(Math.floor(value.length / 2));
      for (let i = 0; i < out.length; i++) {
        const hi = HEX_VALUE.get(value.charCodeAt(i * 2));
        const lo = HEX_VALUE.get(value.charCodeAt(i * 2 + 1));
        if (hi === void 0 || lo === void 0) {
          return out.subarray(0, i);
        }
        out[i] = hi * 16 + lo;
      }
      return out;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return Uint8Array.from(value);
  }
  var _BrowserBuffer_instances, window_fn;
  var _BrowserBuffer = class _BrowserBuffer extends Uint8Array {
    constructor() {
      super(...arguments);
      __privateAdd(this, _BrowserBuffer_instances);
    }
    static alloc(size, fill = 0) {
      const b = new _BrowserBuffer(size);
      if (fill !== 0) {
        b.fill(fill);
      }
      return b;
    }
    static allocUnsafe(size) {
      return new _BrowserBuffer(size);
    }
    static isBuffer(value) {
      return value instanceof _BrowserBuffer;
    }
    static from(value, encoding = "utf8") {
      return new _BrowserBuffer(bytesOf(value, typeof value === "string" ? encoding : "utf8"));
    }
    static concat(list, totalLength) {
      const parts = [];
      let size = 0;
      for (const part of list) {
        const b = bytesOf(part);
        parts.push(b);
        size += b.length;
      }
      const out = new _BrowserBuffer(totalLength === void 0 ? size : totalLength);
      let at = 0;
      for (const b of parts) {
        out.set(b.subarray(0, out.length - at), at);
        at = Math.min(at + b.length, out.length);
      }
      return out;
    }
    /** node's Buffer.slice is a window on the same bytes, not a copy like Uint8Array's. */
    slice(begin, end) {
      return this.subarray(begin, end);
    }
    indexOf(value, fromIndex = 0) {
      if (typeof value === "number") {
        return Uint8Array.prototype.indexOf.call(this, value, fromIndex);
      }
      const needle = bytesOf(value, "latin1");
      for (let i = Math.max(0, fromIndex); i + needle.length <= this.length; i++) {
        let at = 0;
        while (at < needle.length && this[i + at] === needle[at]) {
          at++;
        }
        if (at === needle.length) {
          return i;
        }
      }
      return -1;
    }
    equals(other) {
      if (this.length !== other.length) {
        return false;
      }
      for (let i = 0; i < this.length; i++) {
        if (this[i] !== other[i]) {
          return false;
        }
      }
      return true;
    }
    writeUInt32BE(value, offset = 0) {
      __privateMethod(this, _BrowserBuffer_instances, window_fn).call(this).setUint32(offset, value);
      return offset + 4;
    }
    writeUInt16BE(value, offset = 0) {
      __privateMethod(this, _BrowserBuffer_instances, window_fn).call(this).setUint16(offset, value);
      return offset + 2;
    }
    writeBigUInt64LE(value, offset = 0) {
      __privateMethod(this, _BrowserBuffer_instances, window_fn).call(this).setBigUint64(offset, value, true);
      return offset + 8;
    }
    readUInt32BE(offset = 0) {
      return __privateMethod(this, _BrowserBuffer_instances, window_fn).call(this).getUint32(offset);
    }
    readBigUInt64LE(offset = 0) {
      return __privateMethod(this, _BrowserBuffer_instances, window_fn).call(this).getBigUint64(offset, true);
    }
    toString(encoding = "utf8") {
      if (encoding === "latin1" || encoding === "binary") {
        let text = "";
        for (let at = 0; at < this.length; at += 2048) {
          text += String.fromCharCode.apply(null, this.subarray(at, Math.min(at + 2048, this.length)));
        }
        return text;
      }
      if (encoding === "hex") {
        let text = "";
        for (let at = 0; at < this.length; at++) {
          text += HEX_PAIR[this[at]];
        }
        return text;
      }
      if (encoding === "utf8" || encoding === "utf-8") {
        return UTF8_TEXT.decode(this);
      }
      throw new TypeError("browserBuffer only writes latin1, utf8 and hex, not " + encoding);
    }
  };
  _BrowserBuffer_instances = new WeakSet();
  /** The reads and writes go through a DataView, which refuses the same ranges node does. */
  window_fn = function() {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  };
  var BrowserBuffer = _BrowserBuffer;

  // site/src/engine/browserGlobals.mjs
  globalThis.Buffer = BrowserBuffer;
  var process = { env: {} };

  // site/src/config.mjs
  var config = {
    brand: {
      name: "Grably",
      tagline: "Paste a link. Get the video.",
      sub_tagline: "Turn any supported video page into a direct MP4 download, with a preview before you save.",
      meta_title: "Grably: paste a video link, get an MP4"
    },
    app: {
      debug: false,
      timezone: "UTC",
      base_url: process.env.VD_BASE_URL || "",
      entry: "index.php"
    },
    security: {
      trust_proxy_ip: false
    },
    http: {
      user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      connect_timeout: 8,
      timeout: 20,
      max_redirects: 5,
      page_max_bytes: 2e6
    },
    extract: {
      depth: 3,
      max_pages: 8,
      frames_per_page: 5,
      json_configs: 3,
      deep_candidates: 40,
      verify_limit: 6,
      request_limit: 26,
      deadline_ms: 18e3,
      token_ttl_fallback: 900
    },
    jobs: {
      ttl: 1800,
      max_age: 86400,
      gc_probability: 0.05
    },
    limits: {
      max_concurrent_requests: 3,
      relay_buffer_bytes: 262144,
      relay_max_bytes: 0,
      // Added for the netlify port. A function response may carry 20 MB when it streams
      // and 6 MB when it buffers, so one proxied answer stops here and the rest of the
      // file comes in the next ranged request. The php ceiling above is a shared-hosting
      // memory limit and stays at 0 = unlimited, because nothing about the php app read
      // it; this one is enforced by Relay.
      function_stream_bytes: 18874368,
      // The size a route may answer with as one buffered body. Above it the bytes go out
      // as a stream instead, which the platform allows up to the ceiling above.
      function_buffer_bytes: 6291456
    },
    hls: {
      default_height: 1080,
      segment_concurrency: 4
    },
    build: {
      tick_seconds: 10,
      tick_segments: 3,
      max_segments: 1500,
      max_bytes: 1610612736,
      segment_max_bytes: 67108864,
      segment_timeout: 25,
      playlist_max_bytes: 4194304,
      request_limit: 900,
      ttl: 3600,
      max_age: 7200,
      scratch_budget: 3e9,
      // Added for the netlify port, where it replaces nothing: the php ceiling above
      // is a shared-hosting disk quota, and a function has a different one. A single
      // streamed response may carry 20 MB and a buffered one 6 MB, so a joined mp4 is
      // cut off at 20 MB and told to the visitor instead of failing at 1.5 GB.
      output_max_bytes: 20971520,
      // Netlify has no disk a second request can read, so every tick carries the whole
      // partial file through blob storage. Twelve parts per tick instead of the php
      // three makes one save about a quarter of the round trips; the tick deadline
      // still decides when a request stops.
      tick_segments_netlify: 12
    },
    logging: {
      enabled: true,
      dir: "storage/logs"
    },
    legal: {
      owner_notice: "Grably only fetches files a page already makes publicly available. Downloading a video you do not own or are not licensed to copy breaks the hosting site and copyright law."
    }
  };
  function cfg(key, fallback = null) {
    let c = config;
    for (const part of key.split(".")) {
      if (!c || typeof c !== "object" || !(part in c)) {
        return fallback;
      }
      c = c[part];
    }
    return c;
  }

  // site/src/supportPure.mjs
  function phpRound(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) {
      return v;
    }
    return v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5);
  }
  function phpInt(value) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? Math.trunc(value) : 0;
    }
    if (value === null || value === void 0 || typeof value === "boolean") {
      return value ? 1 : 0;
    }
    const prefix = /^[ \t\n\r\x0B\u0000]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(String(value));
    if (prefix === null) {
      return 0;
    }
    const n = Number(prefix[0]);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  function phpFloat(value) {
    if (typeof value === "number") {
      return value;
    }
    const prefix = /^[ \t\n\r\x0B\u0000]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(String(value));
    return prefix === null ? 0 : Number(prefix[0]);
  }
  function intDiv(a, b) {
    return Math.trunc(a / b);
  }
  var TRIM_CHARS = " 	\n\r\v\0";
  function phpTrim(s, chars = TRIM_CHARS) {
    return phpTrimEnd(phpTrimStart(s, chars), chars);
  }
  function phpTrimStart(s, chars = TRIM_CHARS) {
    const str = String(s);
    let i = 0;
    while (i < str.length && chars.includes(str[i])) {
      i++;
    }
    return str.slice(i);
  }
  function phpTrimEnd(s, chars = TRIM_CHARS) {
    const str = String(s);
    let end = str.length;
    while (end > 0 && chars.includes(str[end - 1])) {
      end--;
    }
    return str.slice(0, end);
  }
  function parseUrl(url) {
    if (typeof url !== "string") {
      return false;
    }
    if (url === "") {
      return { path: "" };
    }
    const out = {};
    let rest = url;
    const hash = rest.indexOf("#");
    if (hash !== -1) {
      out.fragment = rest.slice(hash + 1);
      rest = rest.slice(0, hash);
    }
    const question = rest.indexOf("?");
    if (question !== -1) {
      out.query = rest.slice(question + 1);
      rest = rest.slice(0, question);
    }
    const scheme = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(rest);
    let authority;
    if (scheme && rest.slice(scheme[0].length, scheme[0].length + 2) === "//") {
      out.scheme = scheme[1];
      authority = rest.slice(scheme[0].length + 2);
    } else if (scheme) {
      return { ...out, scheme: scheme[1], path: rest.slice(scheme[0].length) };
    } else if (rest.startsWith("//")) {
      authority = rest.slice(2);
    } else {
      return { ...out, path: rest };
    }
    let path = "";
    const slash = authority.indexOf("/");
    if (slash !== -1) {
      path = authority.slice(slash);
      authority = authority.slice(0, slash);
    }
    if (authority === "") {
      return false;
    }
    const at = authority.lastIndexOf("@");
    if (at !== -1) {
      const userinfo = authority.slice(0, at);
      authority = authority.slice(at + 1);
      const colon = userinfo.indexOf(":");
      if (colon === -1) {
        out.user = userinfo;
      } else {
        out.user = userinfo.slice(0, colon);
        out.pass = userinfo.slice(colon + 1);
      }
    }
    let host = authority;
    let portText = null;
    let bracketed = false;
    if (authority.startsWith("[")) {
      const close = authority.indexOf("]");
      if (close !== -1) {
        const after = authority.slice(close + 1);
        if (after === "" || after.startsWith(":") && bracketPortHolds(after.slice(1))) {
          bracketed = true;
          host = authority.slice(0, close + 1);
          portText = after === "" ? null : after.slice(1);
        }
      }
    }
    if (!bracketed) {
      const colon = authority.lastIndexOf(":");
      if (colon !== -1) {
        host = authority.slice(0, colon);
        portText = authority.slice(colon + 1);
      }
    }
    if (host === "") {
      return false;
    }
    if (portText !== null && portText !== "") {
      const digits = /^[ \t]*\+?(\d+)/.exec(portText);
      if (digits === null) {
        return false;
      }
      const port = Number(digits[1]);
      if (port > 65535) {
        return false;
      }
      out.port = port;
    }
    out.host = host;
    if (path !== "") {
      out.path = path;
    }
    return out;
  }
  function bracketPortHolds(text) {
    if (text === "") {
      return true;
    }
    const digits = /^[ \t]*\+?\d+/.exec(text);
    return digits !== null && text[digits[0].length] !== ":";
  }
  function urlAbsolutize(base, maybeRelative) {
    let rel = phpTrim(maybeRelative);
    if (rel === "") {
      return base;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(rel)) {
      return rel;
    }
    const p = parseUrl(base);
    if (!p || p.scheme === void 0 || p.host === void 0) {
      return rel;
    }
    const origin = p.scheme + "://" + p.host + (p.port !== void 0 && p.port !== null ? ":" + p.port : "");
    if (rel.startsWith("//")) {
      return p.scheme + ":" + rel;
    }
    if (rel[0] === "/") {
      return origin + rel;
    }
    const path = p.path !== void 0 && p.path !== "" ? p.path : "/";
    const dir = path.endsWith("/") ? path : dirnamePhp(path) + "/";
    return origin + dir + (rel.startsWith("./") ? rel.slice(2) : rel);
  }
  function dirnamePhp(path) {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    const pos = normalized.lastIndexOf("/");
    if (pos === -1) {
      return ".";
    }
    if (pos === 0) {
      return "/";
    }
    return normalized.slice(0, pos);
  }

  // site/src/hls/playlist.mjs
  var TAGS = {
    streamInf: "#ext-x-stream-inf",
    extinf: "#extinf",
    targetDuration: "#ext-x-targetduration",
    mediaSequence: "#ext-x-media-sequence",
    key: "#ext-x-key",
    map: "#ext-x-map",
    endList: "#ext-x-endlist",
    byteRange: "#ext-x-byterange"
  };
  var Playlist = class _Playlist {
    constructor() {
      __publicField(this, "isMaster", false);
      /** @type {Array<{url?:string,bandwidth:number|null,width:number|null,height:number|null,codecs:string|null,name:string|null}>} */
      __publicField(this, "variants", []);
      /** @type {Array<{url:string,duration:number,seq:number,byterange:string|null,map:string|null}>} */
      __publicField(this, "segments", []);
      __publicField(this, "key", null);
      // {method, uri, iv}
      __publicField(this, "map", null);
      // init segment url (fmp4 input)
      __publicField(this, "targetDuration", null);
      __publicField(this, "mediaSequence", 0);
      __publicField(this, "endList", false);
      __publicField(this, "live", false);
      __publicField(this, "sampleAes", false);
      __publicField(this, "totalDuration", 0);
      __publicField(this, "codecs", null);
    }
    static parse(text, baseUrl) {
      const p = new _Playlist();
      if (!hasTag(text, "#EXTM3U")) {
        return p;
      }
      const lines = text.split(/\r\n|\r|\n/);
      let seq = 0;
      let pendingInfo = null;
      let pendingDuration = null;
      let mapLocal = null;
      for (const line of lines) {
        const t = phpTrim(line);
        if (t === "") {
          continue;
        }
        if (t[0] !== "#") {
          const url = urlAbsolutize(baseUrl, t);
          if (p.isMaster) {
            p.variants.push({ ...pendingInfo ?? {}, url });
            pendingInfo = null;
          } else {
            const dur = pendingDuration ?? (p.targetDuration ?? 10);
            p.segments.push({
              url,
              duration: dur,
              seq,
              byterange: null,
              map: mapLocal
            });
            seq++;
            p.totalDuration += dur;
            pendingDuration = null;
          }
          continue;
        }
        const lower = t.toLowerCase();
        if (lower.includes(TAGS.streamInf)) {
          p.isMaster = true;
          const attrs = attributes(t.slice(t.indexOf(":") + 1));
          const res = attrs.resolution ?? null;
          let w = null;
          let h = null;
          if (typeof res === "string") {
            const mm = /^(\d+)x(\d+)$/.exec(res);
            if (mm) {
              w = Number(mm[1]);
              h = Number(mm[2]);
            }
          }
          let codecs = attrs.codecs !== void 0 ? phpTrim(String(attrs.codecs), ' 	\n\r\v\0"') : null;
          if (codecs === "") {
            codecs = null;
          }
          pendingInfo = {
            bandwidth: attrs.bandwidth !== void 0 ? phpInt(attrs.bandwidth) : null,
            width: w,
            height: h,
            codecs,
            name: attrs.name !== void 0 ? phpTrim(String(attrs.name), '"') : null
          };
          continue;
        }
        if (lower.includes(TAGS.extinf)) {
          const mm = /:\s*([\d.]+)\s*,?/.exec(t);
          if (mm) {
            pendingDuration = phpFloat(mm[1]);
          }
          continue;
        }
        if (lower.includes(TAGS.targetDuration)) {
          const mm = /:(\d+)/.exec(t);
          if (mm) {
            p.targetDuration = phpFloat(mm[1]);
          }
          continue;
        }
        if (lower.includes(TAGS.mediaSequence)) {
          const mm = /:(\d+)/.exec(t);
          if (mm) {
            p.mediaSequence = phpInt(mm[1]);
            seq = p.mediaSequence;
          }
          continue;
        }
        if (lower.includes(TAGS.key)) {
          const attrs = attributes(t.slice(t.indexOf(":") + 1));
          const method = String(attrs.method ?? "NONE").toUpperCase();
          if (method === "SAMPLE-AES" || method.includes("SAMPLE")) {
            p.sampleAes = true;
          }
          const uri = attrs.uri !== void 0 ? phpTrim(String(attrs.uri), '"') : null;
          p.key = method === "NONE" || uri === null ? null : { method, uri: urlAbsolutize(baseUrl, uri), iv: attrs.iv ?? null };
          continue;
        }
        if (lower.includes(TAGS.map)) {
          const attrs = attributes(t.slice(t.indexOf(":") + 1));
          if (attrs.uri !== void 0) {
            mapLocal = urlAbsolutize(baseUrl, phpTrim(String(attrs.uri), '"'));
            p.map = mapLocal;
          }
          continue;
        }
        if (lower.includes(TAGS.endList)) {
          p.endList = true;
          continue;
        }
        if (lower.includes(TAGS.byteRange) && p.segments.length !== 0) {
          const i = p.segments.length - 1;
          p.segments[i].byterange = phpTrim(t.replace(/^#EXT-X-BYTERANGE\s*:\s*/i, ""));
        }
      }
      p.live = !p.endList && !p.isMaster && p.segments.length !== 0;
      if (p.isMaster) {
        p.variants.sort((a, b) => phpInt(b.bandwidth) - phpInt(a.bandwidth));
      }
      return p;
    }
    /** Pick the variant closest to a target height, preferring the higher one. */
    selectVariant(targetHeight = null) {
      if (this.variants.length === 0) {
        return null;
      }
      const target = targetHeight ?? phpInt(cfg("hls.default_height", 1080));
      let best = null;
      let bestPenalty = Number.MAX_VALUE;
      for (const v of this.variants) {
        const h = v.height ?? Math.trunc(Math.sqrt(Math.max(1, phpInt(v.bandwidth) / 1.5)));
        const penalty = Math.abs(h - target) + (h > target ? 5 : 0);
        if (penalty < bestPenalty) {
          bestPenalty = penalty;
          best = v;
        }
      }
      return best;
    }
    /**
     * Rewrite every uri in a playlist through link(target, isAttributeURI).
     * Key and init segment uris are flagged so they are never treated as playlists.
     */
    static rewrite(text, baseUrl, link) {
      const lines = text.split(/\r\n|\r|\n/);
      const out = [];
      for (const line of lines) {
        let t = phpTrimEndLine(line);
        if (t === "") {
          out.push("");
          continue;
        }
        if (t[0] === "#") {
          const m = /URI="([^"]+)"/.exec(t);
          if (m) {
            const needle = '"' + m[1] + '"';
            const replacement = '"' + link(urlAbsolutize(baseUrl, m[1]), true) + '"';
            t = t.split(needle).join(replacement);
          }
          out.push(t);
          continue;
        }
        out.push(link(urlAbsolutize(baseUrl, t), false));
      }
      return out.join("\n");
    }
  };
  function hasTag(text, tag) {
    return String(text).toLowerCase().includes(tag.toLowerCase());
  }
  function phpTrimEndLine(s) {
    return phpTrim(s, " 	\n\r\v\0");
  }
  function attributes(s) {
    const out = {};
    const re = /([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      out[m[1].toLowerCase()] = phpTrim(m[2]);
    }
    return out;
  }

  // site/src/errors.mjs
  var ExtractException = class extends Error {
    /**
     * @param {string} message what the visitor is told
     * @param {string} hint what the visitor is told to do next
     * @param {string} codeName machine-readable reason
     */
    constructor(message, hint = "", codeName = "extract_failed") {
      super(message);
      this.name = "ExtractException";
      this.hint = hint;
      this.codeName = codeName;
    }
  };

  // site/src/hls/mp4Mux.mjs
  var VIDEO = 1;
  var AUDIO = 2;
  var REC_SAMPLE = 1;
  var REC_CHUNK = 2;
  var REC_BYTES = 16;
  var TS = 9e4;
  var MOVIE_TS = 1e3;
  var ZERO = (n) => BrowserBuffer.alloc(n);
  var u32 = (n) => {
    const b = BrowserBuffer.alloc(4);
    let w = Math.trunc(n) % 4294967296;
    if (w < 0) {
      w += 4294967296;
    }
    b.writeUInt32BE(w, 0);
    return b;
  };
  var u16 = (n) => {
    const b = BrowserBuffer.alloc(2);
    b.writeUInt16BE(Math.trunc(n) & 65535);
    return b;
  };
  var cat = (...parts) => BrowserBuffer.concat(parts.map((p) => BrowserBuffer.isBuffer(p) ? p : BrowserBuffer.from(p)));
  var _out, _log, _written, _Mp4Mux_instances, sample_fn, chunk_fn, readLog_fn, append_fn;
  var _Mp4Mux = class _Mp4Mux {
    constructor() {
      __privateAdd(this, _Mp4Mux_instances);
      __privateAdd(this, _out, []);
      __privateAdd(this, _log, []);
      __privateAdd(this, _written, 0);
    }
    /** A fresh file always opens with ftyp; there is nothing to resume in memory. */
    static open() {
      var _a;
      const m = new _Mp4Mux();
      __privateMethod(_a = m, _Mp4Mux_instances, append_fn).call(_a, box("ftyp", cat("isom", u32(512), "isomiso2avc1mp42")));
      return m;
    }
    /**
     * Take up a file an earlier request already wrote.
     *
     * Netlify gives one invocation no disk the next one can see, so the partial mp4 and
     * its sample log travel through blob storage between slices and come back here.
     * Appending to those bytes is what php's fopen($path, 'a') did, and the offsets in
     * the log stay true because they are absolute from the first ftyp.
     *
     * The log comes back as one block and #readLog walks a record at a time, so it is
     * cut here exactly like php's fread($fh, 16) loop: whole records only, and a short
     * tail — a write that never finished — ends the log rather than guessing at it.
     */
    static adopt(mp4, log) {
      const m = new _Mp4Mux();
      __privateSet(m, _out, [BrowserBuffer.from(mp4)]);
      __privateSet(m, _written, __privateGet(m, _out)[0].length);
      if (log !== null && log !== void 0 && log.length > 0) {
        const whole = BrowserBuffer.from(log);
        for (let at = 0; at + REC_BYTES <= whole.length; at += REC_BYTES) {
          __privateGet(m, _log).push(whole.subarray(at, at + REC_BYTES));
        }
      }
      return m;
    }
    bytesWritten() {
      return __privateGet(this, _written);
    }
    /** The finished file: ftyp, every mdat, then the moov. */
    toBuffer() {
      return BrowserBuffer.concat(__privateGet(this, _out));
    }
    /**
     * Hand back the bytes buffered since the last call and forget them.
     *
     * A build on a device does not have to hold the file it is writing, so the writer
     * drains after each part. The order is the order the file is in, and #written keeps
     * counting from the first ftyp, so the offsets packed into the log do not move.
     */
    takeOutput() {
      const out = BrowserBuffer.concat(__privateGet(this, _out));
      __privateSet(this, _out, []);
      return out;
    }
    /** The sidecar log bytes php would have written, for the parity test. */
    logBytes() {
      return BrowserBuffer.concat(__privateGet(this, _log));
    }
    /**
     * Append one segment.
     *
     * @param {Array<{data:Buffer,pts:number,dts:number,key:boolean}>} video
     * @param {Array<{data:Buffer,pts:number}>} audio
     */
    addSegment(video, audio) {
      const videoBytes = BrowserBuffer.concat(video.map((s) => s.data));
      const audioBytes = BrowserBuffer.concat(audio.map((s) => s.data));
      if (videoBytes.length === 0 && audioBytes.length === 0) {
        return;
      }
      const payload = BrowserBuffer.concat([videoBytes, audioBytes]);
      const mediaAt = __privateGet(this, _written) + 8;
      __privateMethod(this, _Mp4Mux_instances, append_fn).call(this, cat(u32(payload.length + 8), "mdat", payload));
      for (const s of video) {
        __privateMethod(this, _Mp4Mux_instances, sample_fn).call(this, VIDEO, s.data.length, s.dts, s.pts, s.key === true);
      }
      for (const s of audio) {
        const pts = s.pts ?? 0;
        __privateMethod(this, _Mp4Mux_instances, sample_fn).call(this, AUDIO, s.data.length, pts, pts, false);
      }
      if (video.length !== 0) {
        __privateMethod(this, _Mp4Mux_instances, chunk_fn).call(this, VIDEO, video.length, mediaAt);
      }
      if (audio.length !== 0) {
        __privateMethod(this, _Mp4Mux_instances, chunk_fn).call(this, AUDIO, audio.length, mediaAt + videoBytes.length);
      }
    }
    /**
     * Build and append moov from the sample log.
     *
     * @param {{width:number,height:number,avcC:Buffer,sampleRate?:number,channels?:number,asc?:Buffer}} p
     * @param {number} now creation time, fixed by the caller so the bytes are comparable
     */
    writeMoov(p, now = Math.floor(Date.now() / 1e3)) {
      const video = __privateMethod(this, _Mp4Mux_instances, readLog_fn).call(this, VIDEO);
      const audio = __privateMethod(this, _Mp4Mux_instances, readLog_fn).call(this, AUDIO);
      if (video.samples === 0) {
        throw new ExtractException("That stream carried no video frames.", "The stream file can still be saved.", "no_video");
      }
      if (!BrowserBuffer.isBuffer(p.avcC) || p.avcC.length === 0) {
        throw new ExtractException("That stream never announced its H.264 parameters.", "The stream file can still be saved.", "no_sps");
      }
      if (__privateGet(this, _written) > 4294967280) {
        throw new ExtractException("This file grew past 4 GB.", "Pick a shorter clip or a lower quality.", "too_big");
      }
      let base = video.dts[0];
      if (audio.samples > 0) {
        base = Math.min(base, audio.dts[0]);
      }
      const hasAudio = audio.samples > 0 && BrowserBuffer.isBuffer(p.asc) && p.asc.length > 0 && Number(p.sampleRate) > 0;
      const tracks = [videoTrack(video, base, p, now)];
      if (hasAudio) {
        tracks.push(audioTrack(audio, base, p, now));
      }
      let movieDur = 0;
      let body = BrowserBuffer.alloc(0);
      for (const t of tracks) {
        body = BrowserBuffer.concat([body, t.trak]);
        movieDur = Math.max(movieDur, t.movie_duration);
      }
      const mvhd = fullBox("mvhd", 0, cat(
        u32(now),
        u32(now),
        u32(MOVIE_TS),
        u32(movieDur),
        u32(65536),
        u16(256),
        u16(0),
        ZERO(8),
        matrix(),
        ZERO(24),
        u32(tracks.length + 1)
      ));
      __privateMethod(this, _Mp4Mux_instances, append_fn).call(this, box("moov", cat(mvhd, body)));
    }
  };
  _out = new WeakMap();
  _log = new WeakMap();
  _written = new WeakMap();
  _Mp4Mux_instances = new WeakSet();
  sample_fn = function(track, size, dts, pts, key) {
    const rec = BrowserBuffer.alloc(REC_BYTES);
    rec[0] = REC_SAMPLE;
    rec[1] = track | (key ? 128 : 0);
    rec.writeUInt32BE(size & 4294967295, 2);
    rec.writeUInt32BE(clampClock(dts), 6);
    rec.writeUInt32BE(clampClock(pts), 10);
    __privateGet(this, _log).push(rec);
  };
  chunk_fn = function(track, count, offset) {
    const rec = BrowserBuffer.alloc(REC_BYTES);
    rec[0] = REC_CHUNK;
    rec[1] = track;
    rec.writeUInt32BE(count >>> 0, 2);
    rec.writeBigUInt64LE(BigInt(offset), 6);
    __privateGet(this, _log).push(rec);
  };
  readLog_fn = function(track) {
    const out = { samples: 0, sizes: [], dts: [], pts: [], key: [], chunk_counts: [], chunk_offsets: [] };
    for (const rec of __privateGet(this, _log)) {
      if (rec[0] === REC_CHUNK) {
        if (rec[1] === track) {
          out.chunk_counts.push(rec.readUInt32BE(2));
          out.chunk_offsets.push(Number(rec.readBigUInt64LE(6)));
        }
        continue;
      }
      if (rec[0] !== REC_SAMPLE) {
        continue;
      }
      if ((rec[1] & 127) !== track) {
        continue;
      }
      out.samples++;
      out.sizes.push(rec.readUInt32BE(2));
      out.dts.push(rec.readUInt32BE(6));
      out.pts.push(rec.readUInt32BE(10));
      out.key.push((rec[1] & 128) !== 0 ? 1 : 0);
    }
    return out;
  };
  append_fn = function(bytes) {
    __privateGet(this, _out).push(bytes);
    __privateSet(this, _written, __privateGet(this, _written) + bytes.length);
  };
  __publicField(_Mp4Mux, "VIDEO", VIDEO);
  __publicField(_Mp4Mux, "AUDIO", AUDIO);
  var Mp4Mux = _Mp4Mux;
  function videoTrack(v, base, p, now) {
    const n = v.samples;
    const deltas = [];
    for (let i = 0; i < n - 1; i++) {
      const d = diff(v.dts[i + 1], v.dts[i]);
      deltas.push(d > 0 ? d : 1);
    }
    deltas.push(n > 1 ? deltas[n - 2] : intDiv(TS, 25));
    const mediaDur = deltas.reduce((a, b) => a + b, 0);
    const cts = [];
    for (let i = 0; i < n; i++) {
      cts.push(Math.max(0, diff(v.pts[i], v.dts[i])));
    }
    const sync = [];
    v.key.forEach((k, i) => {
      if (k === 1) {
        sync.push(i + 1);
      }
    });
    const width = Math.max(2, Math.trunc(Number(p.width) || 0));
    const height = Math.max(2, Math.trunc(Number(p.height) || 0));
    const avc1 = box("avc1", cat(
      ZERO(6),
      u16(1),
      u16(0),
      u16(0),
      ZERO(12),
      u16(width),
      u16(height),
      u32(4718592),
      u32(4718592),
      u32(0),
      u16(1),
      ZERO(32),
      u16(24),
      u16(65535),
      box("avcC", p.avcC)
    ));
    const stbl = cat(
      stsd(avc1),
      stts(deltas),
      ctts(cts),
      sync.length === n || sync.length === 0 ? BrowserBuffer.alloc(0) : stss(sync),
      stsc(v.chunk_counts),
      stsz(v.sizes),
      stco(v.chunk_offsets)
    );
    const delayMs = Math.max(0, phpRound(diff(v.pts[0], base) / TS * MOVIE_TS));
    const movieDurMs = delayMs + phpRound(mediaDur / TS * MOVIE_TS);
    const trak = box("trak", cat(
      tkhd(1, movieDurMs, width, height, false, now),
      edts(delayMs, mediaDur, TS),
      box("mdia", cat(
        mdhd(TS, mediaDur, now),
        hdlr("vide", "VideoHandler"),
        box("minf", cat(
          fullBox("vmhd", 1, cat(u16(0), ZERO(6))),
          dinf(),
          box("stbl", stbl)
        ))
      ))
    ));
    return { trak, movie_duration: movieDurMs };
  }
  function audioTrack(a, base, p, now) {
    const rate = Math.max(1, Math.trunc(Number(p.sampleRate)));
    const ch = Math.max(1, Math.trunc(Number(p.channels)));
    const n = a.samples;
    const deltas = [];
    for (let i = 0; i < n - 1; i++) {
      const d = phpRound(diff(a.pts[i + 1], a.pts[i]) / TS * rate);
      deltas.push(d > 0 ? d : 1024);
    }
    deltas.push(1024);
    const mediaDur = deltas.reduce((x, y) => x + y, 0);
    const mp4a = box("mp4a", cat(
      ZERO(6),
      u16(1),
      u16(0),
      u16(0),
      u32(0),
      u16(ch),
      u16(16),
      u16(0),
      u16(0),
      // php packs (int)($rate << 16) into 4 bytes, so 96 kHz wraps past 32 bits.
      u32(rate * 65536),
      fullBox("esds", 0, esDescriptor(p.asc, rate, a.sizes))
    ));
    const stbl = cat(
      stsd(mp4a),
      stts(deltas),
      stsc(a.chunk_counts),
      stsz(a.sizes),
      stco(a.chunk_offsets)
    );
    const delayMs = Math.max(0, phpRound(diff(a.pts[0], base) / TS * MOVIE_TS));
    const movieDurMs = delayMs + phpRound(mediaDur / rate * MOVIE_TS);
    const trak = box("trak", cat(
      tkhd(2, movieDurMs, 0, 0, true, now),
      edts(delayMs, mediaDur, rate),
      box("mdia", cat(
        mdhd(rate, mediaDur, now),
        hdlr("soun", "SoundHandler"),
        box("minf", cat(
          fullBox("smhd", 0, cat(u16(0), u16(0))),
          dinf(),
          box("stbl", stbl)
        ))
      ))
    ));
    return { trak, movie_duration: movieDurMs };
  }
  function esDescriptor(asc, rate, sizes) {
    const frames = Math.max(1, sizes.length);
    const sum = sizes.reduce((x, y) => x + y, 0);
    const avg = sizes.length > 0 ? Math.trunc(sum / frames * 8 * rate / 1024) : 128e3;
    const spec = cat(BrowserBuffer.from([5, asc.length]), asc);
    const decCfg = cat(
      BrowserBuffer.from([4, 13 + spec.length, 64, 5]),
      u32(2048).subarray(1),
      u32(avg * 2),
      u32(Math.max(1, avg)),
      spec
    );
    const sl = BrowserBuffer.from([6, 1, 2]);
    const body = cat(u16(1), BrowserBuffer.from([0]), decCfg, sl);
    return cat(BrowserBuffer.from([3, body.length]), body);
  }
  function stts(deltas) {
    return sttsRun(runs(deltas));
  }
  function sttsRun(list) {
    let body = u32(list.length);
    for (const [value, count] of list) {
      body = BrowserBuffer.concat([body, u32(count), u32(value)]);
    }
    return fullBox("stts", 0, body);
  }
  function runs(values) {
    const out = [];
    for (const v of values) {
      const last = out.length === 0 ? null : out.length - 1;
      if (last !== null && out[last][0] === v) {
        out[last][1]++;
        continue;
      }
      out.push([v, 1]);
    }
    return out;
  }
  function ctts(offsets) {
    if (offsets.length === 0 || Math.max(...offsets) === 0) {
      return BrowserBuffer.alloc(0);
    }
    const list = runs(offsets);
    let body = u32(list.length);
    for (const [offset, count] of list) {
      body = BrowserBuffer.concat([body, u32(count), u32(offset)]);
    }
    return fullBox("ctts", 0, body);
  }
  function stss(indexes) {
    let body = u32(indexes.length);
    for (const i of indexes) {
      body = BrowserBuffer.concat([body, u32(i)]);
    }
    return fullBox("stss", 0, body);
  }
  function stsz(sizes) {
    let body = BrowserBuffer.concat([u32(0), u32(sizes.length)]);
    for (const s of sizes) {
      body = BrowserBuffer.concat([body, u32(s)]);
    }
    return fullBox("stsz", 0, body);
  }
  function stsc(counts) {
    const entries = [];
    let prev = null;
    counts.forEach((c, i) => {
      if (c !== prev) {
        entries.push([i + 1, c]);
        prev = c;
      }
    });
    let body = u32(entries.length);
    for (const [chunkNo, per] of entries) {
      body = BrowserBuffer.concat([body, u32(chunkNo), u32(per), u32(1)]);
    }
    return fullBox("stsc", 0, body);
  }
  function stco(offsets) {
    let body = u32(offsets.length);
    for (const o of offsets) {
      body = BrowserBuffer.concat([body, u32(o)]);
    }
    return fullBox("stco", 0, body);
  }
  function stsd(entry) {
    return fullBox("stsd", 0, BrowserBuffer.concat([u32(1), entry]));
  }
  function tkhd(id, movieDur, w, h, audio, now) {
    return fullBox("tkhd", 3, cat(
      u32(now),
      u32(now),
      u32(id),
      u32(0),
      u32(Math.max(0, movieDur)),
      ZERO(8),
      u16(0),
      u16(0),
      u16(audio ? 256 : 0),
      u16(0),
      matrix(),
      u32(w * 65536),
      u32(h * 65536)
    ));
  }
  function mdhd(timescale, dur, now) {
    return fullBox("mdhd", 0, cat(
      u32(now),
      u32(now),
      u32(Math.max(1, timescale)),
      u32(Math.max(0, dur)),
      u16(21956),
      u16(0)
    ));
  }
  function hdlr(type, name) {
    return fullBox("hdlr", 0, cat(u32(0), type, ZERO(12), name, BrowserBuffer.from([0])));
  }
  function dinf() {
    return box("dinf", fullBox("dref", 0, BrowserBuffer.concat([u32(1), fullBox("url ", 1, BrowserBuffer.alloc(0))])));
  }
  function edts(delayMs, mediaDur, trackTs) {
    if (delayMs <= 0) {
      return BrowserBuffer.alloc(0);
    }
    const entries = cat(
      u32(delayMs),
      u32(4294967295),
      u16(1),
      u16(0),
      u32(phpRound(mediaDur / Math.max(1, trackTs) * MOVIE_TS)),
      u32(0),
      u16(1),
      u16(0)
    );
    return box("edts", fullBox("elst", 0, BrowserBuffer.concat([u32(2), entries])));
  }
  function matrix() {
    return cat(u32(65536), u32(0), u32(0), u32(0), u32(65536), u32(0), u32(0), u32(0), u32(1073741824));
  }
  function diff(a, b) {
    let d = a - b;
    if (d >= 2147483648) {
      d -= 4294967296;
    } else if (d < -2147483648) {
      d += 4294967296;
    }
    return d;
  }
  function clampClock(t) {
    const w = Math.trunc(t) % 4294967296;
    return w < 0 ? w + 4294967296 : w;
  }
  function box(type, payload) {
    return cat(u32(payload.length + 8), type, payload);
  }
  function fullBox(type, flags, payload) {
    return box(type, BrowserBuffer.concat([u32(flags), payload]));
  }

  // site/src/hls/tsDemuxer.mjs
  var PKT = 188;
  var VIDEO_TYPES = /* @__PURE__ */ new Map([[1, "mpeg2"], [2, "mpeg2"], [27, "h264"], [36, "hevc"]]);
  var AUDIO_TYPES = /* @__PURE__ */ new Map([[3, "mp1"], [4, "mp2"], [15, "aac2"], [17, "aac1"], [31, "aac4"]]);
  var TsDemuxer = class _TsDemuxer {
    constructor() {
      /** @type {Map<number,Buffer[]>} pid => payload chunks under construction */
      __publicField(this, "pending", /* @__PURE__ */ new Map());
      /** @type {Map<number,{pts:?number,dts:?number}>} */
      __publicField(this, "pendingMeta", /* @__PURE__ */ new Map());
      /** @type {Map<number,number>} pid => last continuity counter */
      __publicField(this, "lastCc", /* @__PURE__ */ new Map());
      /** @type {Map<number,number>} pid => stream_type from the PMT */
      __publicField(this, "streamType", /* @__PURE__ */ new Map());
      /** @type {Map<number,string>} pid => 'video'|'audio' */
      __publicField(this, "pidKind", /* @__PURE__ */ new Map());
      __publicField(this, "videoPid", null);
      __publicField(this, "audioPid", null);
      __publicField(this, "pcrPid", null);
      __publicField(this, "pmtPid", null);
      /** @type {Map<number,string>} pid => why it was ignored */
      __publicField(this, "skipped", /* @__PURE__ */ new Map());
      __publicField(this, "pesCount", 0);
      __publicField(this, "badPackets", 0);
    }
    /**
     * @param {Buffer} bytes
     * @param {(pid:number, kind:string, pts:number|null, dts:number|null, pesBody:Buffer) => void} onPes
     */
    demux(bytes, onPes) {
      const len = bytes.length;
      let pos = findSync(bytes, 0, len);
      pos = pos === null ? len : pos;
      while (pos + PKT <= len) {
        if (bytes[pos] !== 71) {
          const next = findSync(bytes, pos, len);
          if (next === null) {
            break;
          }
          this.badPackets++;
          pos = next;
          continue;
        }
        this.packet(bytes, pos, len, onPes);
        pos += PKT;
      }
    }
    /** Emit any PES packet left open when the stream ends. */
    flush(onPes) {
      for (const [pid, chunks] of this.pending) {
        if (chunks.length !== 0) {
          this.emit(pid, BrowserBuffer.concat(chunks), this.pendingMeta.get(pid) ?? {}, onPes);
        }
      }
      this.pending = /* @__PURE__ */ new Map();
      this.pendingMeta = /* @__PURE__ */ new Map();
    }
    /** True when the buffer starts with four packet sync bytes 188 bytes apart. */
    static looksLikeTs(b) {
      return b.length >= 4 * PKT && findSync(b, 0, b.length) !== null;
    }
    packet(b, o, len, onPes) {
      const b1 = b[o + 1];
      if ((b1 & 128) !== 0) {
        return;
      }
      const pusi = (b1 & 64) !== 0;
      if ((b1 >> 4 & 3) === 3) {
        return;
      }
      const pid = (b1 & 31) << 8 | b[o + 2];
      const b4 = b[o + 3];
      const afc = b4 >> 4 & 3;
      if (afc === 0) {
        return;
      }
      const cc = b4 & 15;
      const prevCc = this.lastCc.get(pid);
      if (prevCc !== void 0 && prevCc !== cc && (prevCc + 1 & 15) !== cc) {
        this.badPackets++;
      }
      this.lastCc.set(pid, cc);
      const end = Math.min(o + PKT, len);
      let payloadAt = o + 4;
      if (afc === 2 || afc === 3) {
        const afLen = b[o + 4];
        if (payloadAt + 1 + afLen > end) {
          return;
        }
        if (afLen > 0 && afc === 3 && (b[o + 5] & 16) !== 0 && afLen >= 8) {
          if (this.pcrPid === null) {
            this.pcrPid = pid;
          }
        }
        payloadAt += 1 + afLen;
        if (afc === 2) {
          return;
        }
      }
      if (payloadAt >= end || pid === 8191 || pid === 8190) {
        return;
      }
      const payload = b.subarray(payloadAt, end);
      if (pusi) {
        const open = this.pending.get(pid);
        if (open !== void 0 && open.length !== 0) {
          this.emit(pid, BrowserBuffer.concat(open), this.pendingMeta.get(pid), onPes);
        }
        this.pending.set(pid, []);
        this.pendingMeta.set(pid, { pts: null, dts: null });
        if (pid === 0) {
          this.readPat(payload);
          return;
        }
        if (pid === this.pmtPid) {
          this.readPmt(payload);
          return;
        }
      }
      const bucket = this.pending.get(pid);
      if (bucket !== void 0) {
        bucket.push(payload);
      } else {
        this.pending.set(pid, [payload]);
      }
    }
    readPat(p) {
      const i = tableStart(p);
      if (i === null || p[i] !== 0 || i + 5 > p.length) {
        return;
      }
      const sectionLen = (p[i + 1] & 15) << 8 | p[i + 2];
      const from = i + 5;
      const to = Math.min(p.length - 4, from + sectionLen - 3 - 4);
      for (let j = from; j + 3 < to; j += 4) {
        const program = p[j] << 8 | p[j + 1];
        const pmt = (p[j + 2] & 31) << 8 | p[j + 3];
        if (program !== 0 && pmt !== 8191) {
          this.pmtPid = pmt;
          return;
        }
      }
    }
    readPmt(p) {
      const i = tableStart(p);
      if (i === null || p[i] !== 2 || i + 12 > p.length) {
        return;
      }
      const sectionLen = (p[i + 1] & 15) << 8 | p[i + 2];
      this.pcrPid = (p[i + 8] & 31) << 8 | p[i + 9];
      const progInfoLen = (p[i + 10] & 15) << 8 | p[i + 11];
      let j = i + 12 + progInfoLen;
      const to = Math.min(p.length - 4, i + 3 + sectionLen - 4);
      while (j + 4 < to) {
        const type = p[j];
        const esPid = (p[j + 1] & 31) << 8 | p[j + 2];
        const esInfoLen = (p[j + 3] & 15) << 8 | p[j + 4];
        j += 5 + esInfoLen;
        if (esPid === 8191 || this.streamType.has(esPid)) {
          continue;
        }
        this.streamType.set(esPid, type);
        const isVideo = VIDEO_TYPES.has(type);
        const kind = isVideo ? VIDEO_TYPES.get(type) : AUDIO_TYPES.get(type) ?? (type === 6 ? "private" : null);
        if (kind === null) {
          this.skipped.set(esPid, "stream type 0x" + type.toString(16));
          continue;
        }
        if (isVideo) {
          if (this.videoPid === null) {
            this.videoPid = esPid;
            this.pidKind.set(esPid, "video");
          } else {
            this.skipped.set(esPid, "a second video track");
          }
          continue;
        }
        if (this.audioPid === null) {
          this.audioPid = esPid;
          this.pidKind.set(esPid, "audio");
        } else {
          this.skipped.set(esPid, "another audio language");
        }
      }
    }
    emit(pid, pes, meta, onPes) {
      if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) {
        return;
      }
      const streamId = pes[3];
      if (streamId === 190 || streamId === 191 || streamId === 255) {
        return;
      }
      const flags = pes[7];
      if ((flags & 192) !== 128 && (flags & 192) !== 192) {
        return;
      }
      const pts = _TsDemuxer.readTimestamp(pes, 9);
      const dts = (flags & 192) === 192 ? _TsDemuxer.readTimestamp(pes, 14) : null;
      if (pts === null) {
        return;
      }
      const start = 9 + pes[8];
      if (start >= pes.length) {
        return;
      }
      let kind = this.pidKind.get(pid);
      if (kind === void 0) {
        kind = streamId >= 224 && streamId <= 239 ? "video" : streamId >= 192 && streamId <= 223 || streamId === 189 ? "audio" : null;
        if (kind === null) {
          return;
        }
        this.pidKind.set(pid, kind);
      }
      if (this.videoPid === null && kind === "video") {
        this.videoPid = pid;
      }
      if (this.audioPid === null && kind === "audio") {
        this.audioPid = pid;
      }
      this.pesCount++;
      onPes(pid, kind, pts, dts, pes.subarray(start));
    }
    /**
     * 33-bit PTS/DTS field, marker bits skipped. Built with multiplication because the
     * value does not fit in javascript's 32-bit bitwise result.
     */
    static readTimestamp(b, o) {
      if (o + 4 >= b.length) {
        return null;
      }
      return ((b[o] & 14) >> 1) * 1073741824 + (b[o + 1] << 7 | b[o + 2] >> 1) * 32768 + (b[o + 3] << 7 | b[o + 4] >> 1);
    }
  };
  function findSync(b, from, len) {
    for (let i = from; i + 3 * PKT < len; i++) {
      if (b[i] === 71 && b[i + PKT] === 71 && b[i + 2 * PKT] === 71 && b[i + 3 * PKT] === 71) {
        return i;
      }
    }
    return from < len && b[from] === 71 ? from : null;
  }
  function tableStart(p) {
    if (p.length === 0) {
      return null;
    }
    const i = 1 + p[0];
    return i < p.length ? i : null;
  }

  // site/src/hls/bitReader.mjs
  var _data, _bit;
  var BitReader = class {
    /** @param {Buffer|Uint8Array} data */
    constructor(data) {
      __privateAdd(this, _data);
      __privateAdd(this, _bit, 0);
      __privateSet(this, _data, data);
    }
    bitsLeft() {
      return __privateGet(this, _data).length * 8 - __privateGet(this, _bit);
    }
    /** Read $n bits as an unsigned integer, or null past the end. */
    u(n) {
      if (n < 0 || this.bitsLeft() < n) {
        return null;
      }
      let value = 0;
      for (let i = 0; i < n; i++) {
        const byte = __privateGet(this, _data)[Math.floor((__privateGet(this, _bit) + i) / 8)];
        value = value * 2 + (byte >> 7 - (__privateGet(this, _bit) + i) % 8 & 1);
      }
      __privateSet(this, _bit, __privateGet(this, _bit) + n);
      return value;
    }
    /** unsigned Exp-Golomb. */
    ue() {
      let zeros = 0;
      for (; ; ) {
        const b = this.u(1);
        if (b === null) {
          return null;
        }
        if (b === 1) {
          break;
        }
        zeros++;
        if (zeros > 31) {
          return null;
        }
      }
      if (zeros === 0) {
        return 0;
      }
      const rest = this.u(zeros);
      return rest === null ? null : Math.pow(2, zeros) - 1 + rest;
    }
    /** signed Exp-Golomb. */
    se() {
      const k = this.ue();
      if (k === null) {
        return null;
      }
      const half = intDiv(k + 1, 2);
      return k % 2 === 0 ? -half : half;
    }
  };
  _data = new WeakMap();
  _bit = new WeakMap();

  // site/src/hls/avc.mjs
  var SLICE_TYPES = [1, 2, 3, 4, 5, 19, 20, 21];
  var HIGH_PROFILES = [100, 110, 120, 144, 44, 83, 86, 118, 128, 138, 139, 134, 135];
  var Avc = class _Avc {
    constructor() {
      /** @type {Buffer[]} NAL units of the access unit being collected */
      __publicField(this, "current", []);
      __publicField(this, "currentPts", null);
      __publicField(this, "currentDts", null);
      __publicField(this, "hasSlice", false);
      __publicField(this, "hasIdr", false);
      /** @type {Map<number,Buffer>} nal type => bytes of the first SPS and PPS seen */
      __publicField(this, "paramSets", /* @__PURE__ */ new Map());
      /**
       * A PES packet may end in the middle of a NAL unit, so the bytes before the next
       * start code continue the last unit of the access unit still open.
       */
      __publicField(this, "carry", BrowserBuffer.alloc(0));
      /** @type {{profile:number,constraints:number,level:number,chroma:number,depth_luma:number,depth_chroma:number}|null} */
      __publicField(this, "spsInfo", null);
      __publicField(this, "width", 0);
      __publicField(this, "height", 0);
      __publicField(this, "samples", 0);
      __publicField(this, "keyframes", 0);
    }
    /**
     * Feed one video PES packet; get back the access units it completed.
     *
     * @returns {Array<{nalus:Buffer[],pts:number,dts:number,key:boolean}>}
     */
    push(annexB, pts, dts) {
      this.stealCarry(annexB);
      const done = [];
      for (const [type, nalu] of _Avc.split(annexB)) {
        if ((type === 7 || type === 8) && !this.paramSets.has(type)) {
          this.paramSets.set(type, nalu);
          if (type === 7) {
            this.readSps(nalu);
          }
        }
        const isSlice = SLICE_TYPES.includes(type);
        const newPicture = isSlice && _Avc.firstMbIsZero(nalu) || [7, 8, 9].includes(type) && this.hasSlice;
        if (newPicture && this.hasSlice) {
          done.push(this.close());
        }
        if (type !== 0) {
          this.current.push(nalu);
        }
        if (isSlice) {
          if (!this.hasSlice) {
            this.currentPts = pts;
            this.currentDts = dts ?? pts;
          }
          this.hasSlice = true;
        }
        if (type === 5) {
          this.hasIdr = true;
        }
      }
      return done;
    }
    /**
     * Move the bytes that sit before this chunk's first start code back into the
     * NAL unit they were cut out of.
     */
    stealCarry(annexB) {
      const first = _Avc.firstStart(annexB);
      if (first === null) {
        this.carry = BrowserBuffer.concat([this.carry, annexB]);
        return;
      }
      if (first > 0) {
        this.carry = BrowserBuffer.concat([this.carry, annexB.subarray(0, first)]);
      }
      if (this.carry.length === 0) {
        return;
      }
      if (this.current.length !== 0) {
        const last = this.current.length - 1;
        this.current[last] = BrowserBuffer.concat([this.current[last], this.carry]);
      }
      this.carry = BrowserBuffer.alloc(0);
    }
    /** Close the access unit left open at the end of the stream. */
    finish() {
      if (this.carry.length !== 0 && this.current.length !== 0) {
        const last = this.current.length - 1;
        this.current[last] = BrowserBuffer.concat([this.current[last], this.carry]);
        this.carry = BrowserBuffer.alloc(0);
      }
      if (!this.hasSlice) {
        return [];
      }
      return [this.close()];
    }
    close() {
      this.samples++;
      if (this.hasIdr) {
        this.keyframes++;
      }
      const unit = {
        nalus: this.current,
        pts: this.currentPts ?? 0,
        dts: this.currentDts ?? this.currentPts ?? 0,
        key: this.hasIdr
      };
      this.current = [];
      this.currentPts = null;
      this.currentDts = null;
      this.hasSlice = false;
      this.hasIdr = false;
      return unit;
    }
    /** Index of the first start code in the chunk, or null when there is none. */
    static firstStart(b) {
      const len = b.length;
      for (let i = 0; i < len - 2; i++) {
        if (b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || b[i + 2] === 0 && i + 3 < len && b[i + 3] === 1)) {
          return i;
        }
      }
      return null;
    }
    /** @returns {Array<[number, Buffer]>} [nal type, nalu bytes without the start code] */
    static split(b) {
      const out = [];
      const len = b.length;
      let i = 0;
      let start = -1;
      while (i < len - 2) {
        if (b[i] === 0 && b[i + 1] === 0) {
          let newLen = 0;
          if (b[i + 2] === 1) {
            newLen = 3;
          } else if (b[i + 2] === 0 && i + 3 < len && b[i + 3] === 1) {
            newLen = 4;
          }
          if (newLen !== 0) {
            if (start >= 0) {
              _Avc.collect(out, b.subarray(start, i));
            }
            start = i + newLen;
            i = start;
            continue;
          }
        }
        i++;
      }
      if (start >= 0) {
        _Avc.collect(out, b.subarray(start));
      }
      return out;
    }
    static collect(out, unit) {
      let end = unit.length;
      while (end > 0 && unit[end - 1] === 0) {
        end--;
      }
      if (end > 0) {
        out.push([unit[0] & 31, unit.subarray(0, end)]);
      }
    }
    /** slice_header opens with first_mb_in_slice ue(v): zero means a new picture. */
    static firstMbIsZero(nalu) {
      const br = new BitReader(_Avc.unescape(nalu.subarray(1)));
      const v = br.ue();
      return v === null || v === 0;
    }
    /**
     * Drop the 0x03 emulation-prevention bytes.
     *
     * Written as a scan rather than a replacement so it consumes exactly what
     * preg_replace('/\x00\x00\x03([\x00\x01\x02\x03])/') consumes: a match is four
     * bytes long, so the "\x00\x00\x03" that could start inside the byte it captured is
     * not matched again. A loop that only looked for the three-byte prefix would delete
     * a 0x03 that php keeps, and the decoder would then read the wrong slice header.
     */
    static unescape(b) {
      const out = BrowserBuffer.allocUnsafe(b.length);
      let w = 0;
      for (let i = 0; i < b.length; i++) {
        if (b[i] === 0 && i + 3 < b.length && b[i + 1] === 0 && b[i + 2] === 3 && b[i + 3] <= 3) {
          out[w++] = 0;
          out[w++] = 0;
          out[w++] = b[i + 3];
          i += 3;
          continue;
        }
        out[w++] = b[i];
      }
      return out.subarray(0, w);
    }
    readSps(nalu) {
      const br = new BitReader(_Avc.unescape(nalu.subarray(1)));
      const profile = br.u(8);
      const constraints = br.u(8);
      const level = br.u(8);
      if (profile === null || constraints === null || level === null) {
        return;
      }
      br.ue();
      let chroma = 1;
      let depthLuma = 8;
      let depthChroma = 8;
      if (HIGH_PROFILES.includes(profile)) {
        const got = br.ue();
        if (got === null) {
          return;
        }
        chroma = got;
        if (chroma === 3) {
          br.u(1);
        }
        const dl = br.ue();
        const dc = br.ue();
        if (dl === null || dc === null) {
          return;
        }
        depthLuma = dl + 8;
        depthChroma = dc + 8;
        br.u(1);
        if (br.u(1) === 1) {
          for (let i = 0, n = chroma === 3 ? 12 : 8; i < n; i++) {
            if (br.u(1) === 1) {
              _Avc.skipScalingList(br, i < 6 ? 16 : 64);
            }
          }
        }
      }
      br.ue();
      const pocType = br.ue();
      if (pocType === 0) {
        br.ue();
      } else if (pocType === 1) {
        br.u(1);
        br.se();
        br.se();
        for (let i = 0, n = br.ue() ?? 0; i < n; i++) {
          br.se();
        }
      }
      br.ue();
      br.u(1);
      const wMbs = br.ue();
      const hUnits = br.ue();
      const mbsOnly = br.u(1);
      if (wMbs === null || hUnits === null || mbsOnly === null) {
        return;
      }
      if (mbsOnly === 0) {
        br.u(1);
      }
      br.u(1);
      let width = (wMbs + 1) * 16;
      let height = (hUnits + 1) * 16 * (2 - mbsOnly);
      const frameCropping = br.u(1);
      if (frameCropping === 1) {
        const cropX = chroma === 0 ? 1 : chroma === 3 ? 1 : 2;
        const cropY = (chroma === 0 ? 1 : chroma === 1 ? 2 : 1) * (2 - mbsOnly);
        width -= ((br.ue() ?? 0) + (br.ue() ?? 0)) * cropX;
        height -= ((br.ue() ?? 0) + (br.ue() ?? 0)) * cropY;
      }
      this.width = Math.max(0, width);
      this.height = Math.max(0, height);
      this.spsInfo = {
        profile,
        constraints,
        level,
        chroma,
        depth_luma: depthLuma,
        depth_chroma: depthChroma
      };
    }
    static skipScalingList(br, size) {
      let last = 8;
      let next = 8;
      for (let i = 0; i < size; i++) {
        if (i !== 0) {
          const d = br.se();
          if (d === null) {
            return;
          }
          next = (last + d + 256) % 256;
        }
        if (next !== 0) {
          last = next;
        }
      }
    }
    /** avcC box contents, or null until both parameter sets have been seen. */
    avcC() {
      const sps = this.paramSets.get(7);
      const pps = this.paramSets.get(8);
      if (sps === void 0 || pps === void 0 || this.spsInfo === null) {
        return null;
      }
      const parts = [
        Uint8Array.from([
          1,
          this.spsInfo.profile,
          this.spsInfo.constraints,
          this.spsInfo.level,
          252 | 3,
          // 4-byte nal length field
          224 | 1
        ]),
        // one sps
        u16be(sps.length),
        sps,
        Uint8Array.from([1]),
        // one pps
        u16be(pps.length),
        pps
      ];
      if (HIGH_PROFILES.includes(this.spsInfo.profile)) {
        parts.push(Uint8Array.from([
          248 | this.spsInfo.chroma,
          248 | this.spsInfo.depth_luma - 8,
          248 | this.spsInfo.depth_chroma - 8,
          252 | 0
        ]));
      }
      return BrowserBuffer.concat(parts);
    }
    /** @param {Buffer[]} nalus */
    static toAvcc(nalus) {
      const parts = [];
      for (const n of nalus) {
        const head = BrowserBuffer.alloc(4);
        head.writeUInt32BE(n.length, 0);
        parts.push(head, n);
      }
      return BrowserBuffer.concat(parts);
    }
  };
  function u16be(value) {
    const b = BrowserBuffer.alloc(2);
    b.writeUInt16BE(value & 65535, 0);
    return b;
  }

  // site/src/hls/aac.mjs
  var RATES = [96e3, 88200, 64e3, 48e3, 44100, 32e3, 24e3, 16e3, 12e3, 11025, 8e3, 7350, 0, 0];
  var _Aac = class _Aac {
    constructor() {
      __publicField(this, "sampleRate", null);
      __publicField(this, "channels", null);
      __publicField(this, "objectType", null);
      __publicField(this, "asc", null);
      __publicField(this, "frames", 0);
      __publicField(this, "skippedBytes", 0);
      /** A frame can be cut in half by a PES packet boundary, so keep the loose end. */
      __publicField(this, "carry", BrowserBuffer.alloc(0));
    }
    /**
     * Feed one audio PES packet.
     *
     * @returns {Array<{data:Buffer,samples:number}>} raw AAC frames
     */
    push(pes) {
      if (this.carry.length !== 0) {
        pes = BrowserBuffer.concat([this.carry, pes]);
        this.carry = BrowserBuffer.alloc(0);
      }
      const out = [];
      let i = 0;
      const len = pes.length;
      while (i + 7 <= len) {
        if (pes[i] !== 255 || (pes[i + 1] & 246) !== 240) {
          i++;
          this.skippedBytes++;
          continue;
        }
        const b1 = pes[i + 1];
        const b2 = pes[i + 2];
        const b3 = pes[i + 3];
        const b4 = pes[i + 4];
        const b5 = pes[i + 5];
        const mpeg4 = (b1 & 8) === 0;
        const headerLen = (b1 & 1) === 1 ? 7 : 9;
        const frameLen = (b3 & 3) << 11 | b4 << 3 | b5 >> 5 & 7;
        if (frameLen < headerLen) {
          i++;
          this.skippedBytes++;
          continue;
        }
        if (i + frameLen > len) {
          if (frameLen <= 8192) {
            this.carry = pes.subarray(i);
          }
          break;
        }
        const profile = b2 >> 6;
        const freqIdx = b2 >> 2 & 15;
        const chan = (b2 & 1) << 2 | b3 >> 6 & 3;
        const objectType = mpeg4 ? profile + 1 : profile;
        if (this.asc === null && mpeg4 && freqIdx < RATES.length && RATES[freqIdx] > 0 && chan > 0) {
          this.objectType = objectType;
          this.sampleRate = RATES[freqIdx];
          this.channels = chan;
          this.asc = _Aac.audioSpecificConfig(objectType, freqIdx, chan);
        }
        out.push({
          data: pes.subarray(i + headerLen, i + frameLen),
          samples: 1024
        });
        this.frames++;
        i += frameLen;
      }
      return out;
    }
    /**
     * Two-byte AudioSpecificConfig: 5 bits object type, 4 bits rate index, then
     * 4 bits channel configuration starting at bit 9, which is byte1 bit 3.
     */
    static audioSpecificConfig(objectType, freqIdx, channels) {
      return BrowserBuffer.from([objectType << 3 | freqIdx >> 1, (freqIdx & 1) << 7 | channels << 3]);
    }
    /** MP4 plays AAC-LC/Main/SSR; anything else should stay a stream file. */
    isMp4Friendly() {
      return this.asc !== null && [1, 2, 3, 4, 6].includes(this.objectType);
    }
  };
  __publicField(_Aac, "RATES", RATES);
  var Aac = _Aac;

  // site/src/build/tsStream.mjs
  var _demux, _avc, _aac, _video, _audio, _audioClock;
  var TsStream = class {
    constructor() {
      __privateAdd(this, _demux, new TsDemuxer());
      __privateAdd(this, _avc, new Avc());
      __privateAdd(this, _aac, new Aac());
      /** @type {Array<{data:Buffer,pts:number,dts:number,key:boolean}>} */
      __privateAdd(this, _video, []);
      /** @type {Array<{data:Buffer,pts:number}>} */
      __privateAdd(this, _audio, []);
      __privateAdd(this, _audioClock, null);
    }
    demuxer() {
      return __privateGet(this, _demux);
    }
    avc() {
      return __privateGet(this, _avc);
    }
    aac() {
      return __privateGet(this, _aac);
    }
    /** Read one MPEG-TS buffer and queue the frames it completed. */
    push(ts) {
      __privateGet(this, _demux).demux(ts, this.sink());
    }
    /**
     * Close off everything still open at the end of the stream. This is the last chance
     * to keep the loose ends.
     */
    drain() {
      __privateGet(this, _demux).flush(this.sink());
      for (const u of __privateGet(this, _avc).finish()) {
        __privateGet(this, _video).push({
          data: Avc.toAvcc(u.nalus),
          pts: u.pts,
          dts: u.dts,
          key: u.key === true
        });
      }
      return this.take();
    }
    take() {
      const out = { video: __privateGet(this, _video), audio: __privateGet(this, _audio) };
      __privateSet(this, _video, []);
      __privateSet(this, _audio, []);
      return out;
    }
    sink() {
      return (pid, kind, pts, dts, body) => {
        if (kind === "video" && pid === __privateGet(this, _demux).videoPid) {
          for (const u of __privateGet(this, _avc).push(body, pts, dts)) {
            __privateGet(this, _video).push({
              data: Avc.toAvcc(u.nalus),
              pts: u.pts,
              dts: u.dts,
              key: u.key === true
            });
          }
          return;
        }
        if (pid !== __privateGet(this, _demux).audioPid) {
          return;
        }
        const rate = Math.max(1, __privateGet(this, _aac).sampleRate ?? 44100);
        const step = 1024 * 9e4 / rate;
        if (pts !== null && (__privateGet(this, _audioClock) === null || Math.abs(pts - __privateGet(this, _audioClock)) > step * 2)) {
          __privateSet(this, _audioClock, pts);
        }
        for (const frame of __privateGet(this, _aac).push(body)) {
          __privateGet(this, _audio).push({ data: frame.data, pts: phpRound(__privateGet(this, _audioClock) ?? 0) });
          __privateSet(this, _audioClock, (__privateGet(this, _audioClock) ?? 0) + step);
        }
      };
    }
  };
  _demux = new WeakMap();
  _avc = new WeakMap();
  _aac = new WeakMap();
  _video = new WeakMap();
  _audio = new WeakMap();
  _audioClock = new WeakMap();

  // site/src/engine/aesCbc.mjs
  function xtime(a) {
    return (a << 1 ^ (a & 128 ? 283 : 0)) & 255;
  }
  function gfMul(a, b) {
    let out = 0;
    let x = a;
    let y = b;
    while (y !== 0) {
      if (y & 1) {
        out ^= x;
      }
      x = xtime(x);
      y >>= 1;
    }
    return out;
  }
  function affine(s) {
    return (s ^ (s << 1 & 255 | s >> 7) ^ (s << 2 & 255 | s >> 6) ^ (s << 3 & 255 | s >> 5) ^ (s << 4 & 255 | s >> 4) ^ 99) & 255;
  }
  var SBOX = new Uint8Array(256);
  var INV_SBOX = new Uint8Array(256);
  {
    const inverse = new Uint8Array(256);
    for (let a = 1; a < 256; a++) {
      for (let b = 1; b < 256; b++) {
        if (gfMul(a, b) === 1) {
          inverse[a] = b;
          break;
        }
      }
    }
    for (let i = 0; i < 256; i++) {
      SBOX[i] = i === 0 ? 99 : affine(inverse[i]);
    }
    for (let i = 0; i < 256; i++) {
      INV_SBOX[SBOX[i]] = i;
    }
  }
  var byConst = (c) => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      t[i] = gfMul(i, c);
    }
    return t;
  };
  var MUL_B = byConst(11);
  var MUL_D = byConst(13);
  var MUL_E = byConst(14);
  var MUL_9 = byConst(9);
  var INV_SHIFT = [0, 13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3];
  var RCON = [1, 2, 4, 8, 16, 32, 64, 128, 27, 54];
  function expandKey(key) {
    const w = new Uint8Array(176);
    w.set(key.subarray(0, 16), 0);
    for (let i = 4; i < 44; i++) {
      let t0 = w[(i - 1) * 4];
      let t1 = w[(i - 1) * 4 + 1];
      let t2 = w[(i - 1) * 4 + 2];
      let t3 = w[(i - 1) * 4 + 3];
      if (i % 4 === 0) {
        const first = t0;
        t0 = SBOX[t1] ^ RCON[i / 4 - 1];
        t1 = SBOX[t2];
        t2 = SBOX[t3];
        t3 = SBOX[first];
      }
      w[i * 4] = w[(i - 4) * 4] ^ t0;
      w[i * 4 + 1] = w[(i - 4) * 4 + 1] ^ t1;
      w[i * 4 + 2] = w[(i - 4) * 4 + 2] ^ t2;
      w[i * 4 + 3] = w[(i - 4) * 4 + 3] ^ t3;
    }
    return w;
  }
  function invMixColumns(s) {
    for (let c = 0; c < 4; c++) {
      const a0 = s[c * 4];
      const a1 = s[c * 4 + 1];
      const a2 = s[c * 4 + 2];
      const a3 = s[c * 4 + 3];
      s[c * 4] = MUL_E[a0] ^ MUL_B[a1] ^ MUL_D[a2] ^ MUL_9[a3];
      s[c * 4 + 1] = MUL_9[a0] ^ MUL_E[a1] ^ MUL_B[a2] ^ MUL_D[a3];
      s[c * 4 + 2] = MUL_D[a0] ^ MUL_9[a1] ^ MUL_E[a2] ^ MUL_B[a3];
      s[c * 4 + 3] = MUL_B[a0] ^ MUL_D[a1] ^ MUL_9[a2] ^ MUL_E[a3];
    }
  }
  function addKey(s, rk, at) {
    for (let i = 0; i < 16; i++) {
      s[i] ^= rk[at + i];
    }
  }
  function invShiftSub(s, t) {
    for (let i = 0; i < 16; i++) {
      t[i] = INV_SBOX[s[INV_SHIFT[i]]];
    }
    s.set(t);
  }
  function decryptBlock(rk, s) {
    const t = new Uint8Array(16);
    addKey(s, rk, 160);
    invShiftSub(s, t);
    for (let round = 9; round >= 1; round--) {
      addKey(s, rk, round * 16);
      invMixColumns(s);
      invShiftSub(s, t);
    }
    addKey(s, rk, 0);
  }
  function aes128CbcDecrypt(key, iv, data) {
    if (key.length !== 16 || iv.length !== 16) {
      throw new Error("AES-128 needs a 16 byte key and iv.");
    }
    const rk = expandKey(key);
    const whole = data.length - data.length % 16;
    const out = new Uint8Array(whole);
    const block = new Uint8Array(16);
    for (let at = 0; at < whole; at += 16) {
      block.set(data.subarray(at, at + 16));
      decryptBlock(rk, block);
      for (let i = 0; i < 16; i++) {
        out[at + i] = block[i] ^ (at === 0 ? iv[i] : data[at - 16 + i]);
      }
    }
    return out;
  }
  function segmentIv(declared, sequence) {
    const hex = String(declared ?? "").toLowerCase().replace(/0x|x| /g, "");
    if (hex.length === 32 && /^[0-9a-f]+$/.test(hex)) {
      const out2 = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        out2[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return out2;
    }
    const out = new Uint8Array(16);
    const seq = Math.trunc(sequence) >>> 0;
    out[12] = seq >>> 24 & 255;
    out[13] = seq >>> 16 & 255;
    out[14] = seq >>> 8 & 255;
    out[15] = seq & 255;
    return out;
  }

  // site/src/build/mp4Builder.mjs
  function stampTimes(rec, video, audio) {
    if (video.length === 0) {
      return;
    }
    let offset = Math.trunc(rec.ts_offset ?? 0);
    const first = Math.trunc(video[0].dts);
    const last = rec.last_dts === null || rec.last_dts === void 0 ? null : Math.trunc(rec.last_dts);
    if (last !== null) {
      const gap = first + offset - last;
      if (gap <= 0 || gap > 9e4 * 120) {
        offset = last + Math.trunc(rec.last_delta ?? 3600) - first;
      }
    }
    let previous = null;
    video.forEach((u, i) => {
      video[i].dts = Math.trunc(u.dts) + offset;
      video[i].pts = Math.trunc(u.pts) + offset;
      if (previous !== null && video[i].dts > previous) {
        rec.last_delta = video[i].dts - previous;
      }
      previous = video[i].dts;
    });
    audio.forEach((u, i) => {
      audio[i].pts = Math.trunc(u.pts) + offset;
    });
    rec.ts_offset = offset;
    rec.last_dts = previous;
  }
  function captureParams(rec, avc, aac) {
    const avcC = avc.avcC();
    if (avcC === null || avc.width < 2 || avc.height < 2) {
      return;
    }
    const hex = avcC.toString("hex");
    if (rec.params !== null && rec.params !== void 0) {
      if (rec.params.avcC !== hex && (rec.note === null || rec.note === void 0)) {
        rec.note = "The stream switched quality partway, so the MP4 holds the part before the switch.";
      }
      return;
    }
    rec.params = {
      width: avc.width,
      height: avc.height,
      avcC: hex,
      asc: BrowserBuffer.isBuffer(aac.asc) ? aac.asc.toString("hex") : "",
      sampleRate: Math.trunc(aac.sampleRate ?? 0),
      channels: Math.trunc(aac.channels ?? 0)
    };
  }

  // site/src/engine/localMux.mjs
  async function keyBytes(fetchBytes, uri) {
    const raw = await fetchBytes(uri);
    let key = raw.length === 16 ? raw : decodeTrimmed(raw);
    if (key.length !== 16) {
      throw new ExtractException(
        "The key for this stream is not a plain 16 byte one.",
        "Use Save stream file instead.",
        "drm"
      );
    }
    return key;
  }
  function decodeTrimmed(raw) {
    let text = "";
    for (let i = 0; i < raw.length; i++) {
      text += String.fromCharCode(raw[i]);
    }
    const trimmed = text.replace(/^[\r\n \t]+|[\r\n \t]+$/g, "");
    if (trimmed.length !== 16) {
      return raw;
    }
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      out[i] = trimmed.charCodeAt(i) & 255;
    }
    return out;
  }
  async function mediaPlaylist(o, text, base) {
    const parsed = Playlist.parse(text, base);
    if (!parsed.isMaster) {
      return [parsed, base];
    }
    const variant = parsed.selectVariant(o.height ?? null);
    if (variant === null) {
      throw new ExtractException(
        "The stream list has no video quality in it.",
        "Try Save stream file instead.",
        "no_variant"
      );
    }
    const url = String(variant.url);
    return [Playlist.parse(await o.fetchText(url), url), url];
  }
  async function readPart(o, url, attempt) {
    try {
      return await o.fetchBytes(url);
    } catch (e) {
      if (e instanceof ExtractException || attempt >= 3) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return await readPart(o, url, attempt + 1);
    }
  }
  async function muxPlaylistToMp4(o) {
    const first = await o.fetchText(o.manifestUrl);
    if (!String(first).includes("#EXTM3U")) {
      throw new ExtractException("That playlist could not be read.", "Paste the address of the .m3u8 file.", "playlist_read");
    }
    const [playlist, base] = await mediaPlaylist(o, first, o.manifestUrl);
    if (playlist.live) {
      throw new ExtractException("This stream has no end yet.", "Save it once the broadcast is over.", "live");
    }
    if (playlist.sampleAes) {
      throw new ExtractException(
        "This stream is protected with SAMPLE-AES.",
        "A stream that needs its own decrypting player cannot be joined into a file here.",
        "drm"
      );
    }
    if (playlist.map !== null) {
      throw new ExtractException(
        "This stream is already cut as MP4 segments.",
        "Use Save stream file to keep it as it is.",
        "fmp4"
      );
    }
    if (playlist.key !== null && String(playlist.key.method ?? "").toUpperCase() !== "AES-128") {
      throw new ExtractException(
        "This stream uses " + playlist.key.method + ".",
        "Only a stream with a plain key file can be joined here.",
        "drm"
      );
    }
    if (playlist.segments.length === 0) {
      throw new ExtractException("The stream list came back empty.", "Run the same link again.", "no_segments");
    }
    const maxParts = Math.trunc(Number(o.maxParts ?? 6e3));
    if (playlist.segments.length > maxParts) {
      throw new ExtractException(
        "This stream is longer than " + maxParts + " parts.",
        "Pick a lower quality if the page offers one.",
        "too_long"
      );
    }
    const declaredIv = playlist.key === null ? null : String(playlist.key.iv ?? "");
    const key = playlist.key === null ? null : await keyBytes(o.fetchBytes, urlAbsolutize(base, String(playlist.key.uri)));
    const rec = { ts_offset: 0, last_dts: null, last_delta: 3600, params: null, note: null };
    const mux = Mp4Mux.open();
    const stream = new TsStream();
    const segments = playlist.segments;
    let empties = 0;
    await o.write(mux.takeOutput());
    const ahead = Math.max(1, Math.trunc(Number(o.prefetch ?? 6)));
    const pending = /* @__PURE__ */ new Map();
    const start = (i) => {
      const asked = readPart(o, String(segments[i].url), 1);
      asked.catch(() => {
      });
      return asked;
    };
    let next = 0;
    for (let i = 0; i < segments.length; i++) {
      while (next < segments.length && next - i < ahead) {
        pending.set(next, start(next));
        next++;
      }
      let bytes;
      try {
        bytes = await pending.get(i);
      } catch {
        throw new ExtractException(
          "Part " + (i + 1) + " of " + segments.length + " did not arrive.",
          "The host dropped the connection. Run the save again to pick it up from here.",
          "segment_failed"
        );
      }
      pending.delete(i);
      if (key !== null) {
        bytes = aes128CbcDecrypt(key, segmentIv(declaredIv, Number(segments[i].seq)), bytes);
      }
      stream.push(bytes);
      const taken = stream.take();
      if (taken.video.length === 0 && taken.audio.length === 0) {
        for (const why of stream.demuxer().skipped.values()) {
          if (String(why).includes("0x24")) {
            throw new ExtractException(
              "This stream is HEVC (H.265).",
              "HEVC video needs a full converter. Use Save stream file to keep it as it is.",
              "hevc"
            );
          }
        }
        empties += 1;
        if (empties >= 2) {
          throw new ExtractException(
            "Part " + (i + 1) + " held no readable frames.",
            "The stream is cut in a way this tool cannot join. Use Save stream file instead.",
            "no_frames"
          );
        }
      } else {
        empties = 0;
        stampTimes(rec, taken.video, taken.audio);
        mux.addSegment(taken.video, taken.audio);
        captureParams(rec, stream.avc(), stream.aac());
      }
      await o.write(mux.takeOutput());
      if (o.onPart !== null && o.onPart !== void 0) {
        o.onPart(i + 1, segments.length, mux.bytesWritten());
      }
    }
    const tail = stream.drain();
    if (tail.video.length !== 0 || tail.audio.length !== 0) {
      stampTimes(rec, tail.video, tail.audio);
      mux.addSegment(tail.video, tail.audio);
    }
    if (rec.params === null || rec.params === void 0) {
      throw new ExtractException(
        "The stream never announced its video format.",
        "Use Save stream file to keep it as it is.",
        "no_sps"
      );
    }
    mux.writeMoov({
      width: rec.params.width,
      height: rec.params.height,
      avcC: BrowserBuffer.from(String(rec.params.avcC), "hex"),
      asc: BrowserBuffer.from(String(rec.params.asc), "hex"),
      sampleRate: rec.params.sampleRate,
      channels: rec.params.channels
    }, o.now);
    await o.write(mux.takeOutput());
    return { parts: segments.length, bytes: mux.bytesWritten(), note: rec.note ?? null };
  }

  // site/src/engine/muxWorker.mjs
  function plain(bytes) {
    const out = new Uint8Array(bytes.length);
    out.set(bytes);
    return out;
  }
  async function fetchPart(url, signal, attempts = 4) {
    let last = null;
    for (let tryNo = 0; tryNo < attempts; tryNo += 1) {
      const res = await fetch(url, { signal, redirect: "follow", credentials: "omit" });
      if (res.ok) {
        return res;
      }
      last = res;
      if (signal.aborted) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (tryNo + 1)));
    }
    throw new Error("The video host answered HTTP " + last.status + ".");
  }
  async function bytesOf2(url, signal) {
    const res = await fetchPart(url, signal);
    return plain(new Uint8Array(await res.arrayBuffer()));
  }
  async function textOf(url, signal) {
    const res = await fetchPart(url, signal);
    return await res.text();
  }
  self.onmessage = async (event) => {
    const msg = event.data ?? {};
    if (msg.cmd !== "mux") {
      return;
    }
    const stream = msg.stream;
    if (stream === null || stream === void 0 || typeof stream.getWriter !== "function") {
      self.postMessage({ ev: "error", message: "The file to write was never handed over." });
      return;
    }
    const writer = stream.getWriter();
    const controller = new AbortController();
    let last = 0;
    const send = (body) => {
      if (Date.now() - last < 220 && body.ev === "progress") {
        return;
      }
      last = Date.now();
      self.postMessage(body);
    };
    try {
      const done = await muxPlaylistToMp4({
        manifestUrl: String(msg.manifestUrl ?? ""),
        height: msg.height ?? null,
        fetchText: (url) => textOf(url, controller.signal),
        fetchBytes: (url) => bytesOf2(url, controller.signal),
        write: async (bytes) => {
          if (bytes.length > 0) {
            await writer.write(plain(bytes));
          }
        },
        onPart: (parts, total, bytes) => send({ ev: "progress", done: parts, total, bytes })
      });
      await writer.close();
      self.postMessage({ ev: "done", bytes: done.bytes, parts: done.parts, note: done.note });
    } catch (e) {
      controller.abort();
      const message = e && typeof e.message === "string" && e.message !== "" ? e.message : "The local saver stopped.";
      try {
        await writer.abort(e instanceof Error ? e : new Error(message));
      } catch {
      }
      self.postMessage({ ev: "error", message, hint: e instanceof Error && e.hint ? e.hint : "" });
    }
  };
})();
