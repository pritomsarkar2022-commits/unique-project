// Direct port of config/app.php. Values and key names are unchanged so the
// behaviour of every budget and limit matches the original site.
export const config = {
  brand: {
    name: 'Grably',
    tagline: 'Paste a link. Get the video.',
    sub_tagline: 'Turn any supported video page into a direct MP4 download, with a preview before you save.',
    meta_title: 'Grably: paste a video link, get an MP4',
  },

  app: {
    debug: false,
    timezone: 'UTC',
    base_url: process.env.VD_BASE_URL || '',
    entry: 'index.php',
  },

  security: {
    trust_proxy_ip: false,
  },

  http: {
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    connect_timeout: 8,
    timeout: 20,
    max_redirects: 5,
    page_max_bytes: 2000000,
  },

  extract: {
    depth: 3,
    max_pages: 8,
    frames_per_page: 5,
    json_configs: 3,
    deep_candidates: 40,
    verify_limit: 6,
    request_limit: 26,
    deadline_ms: 18000,
    token_ttl_fallback: 900,
  },

  jobs: {
    ttl: 1800,
    max_age: 86400,
    gc_probability: 0.05,
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
  },

  hls: {
    default_height: 1080,
    segment_concurrency: 4,
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
    scratch_budget: 3000000000,

    // Added for the netlify port, where it replaces nothing: the php ceiling above
    // is a shared-hosting disk quota, and a function has a different one. A single
    // streamed response may carry 20 MB and a buffered one 6 MB, so a joined mp4 is
    // cut off at 20 MB and told to the visitor instead of failing at 1.5 GB.
    output_max_bytes: 20971520,
    // Netlify has no disk a second request can read, so every tick carries the whole
    // partial file through blob storage. Twelve parts per tick instead of the php
    // three makes one save about a quarter of the round trips; the tick deadline
    // still decides when a request stops.
    tick_segments_netlify: 12,
  },

  logging: {
    enabled: true,
    dir: 'storage/logs',
  },

  legal: {
    owner_notice: 'Grably only fetches files a page already makes publicly available. Downloading a video you do not own or are not licensed to copy breaks the hosting site and copyright law.',
  },
};

/** cfg('extract.depth') reads config.extract.depth, exactly like the PHP helper. */
export function cfg(key, fallback = null) {
  let c = config;
  for (const part of key.split('.')) {
    if (!c || typeof c !== 'object' || !(part in c)) {
      return fallback;
    }
    c = c[part];
  }
  return c;
}
