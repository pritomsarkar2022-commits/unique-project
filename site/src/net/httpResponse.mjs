/** Port of lib/Net/HttpResponse.php: one finished outbound exchange. */
export class HttpResponse {
  /**
   * @param {Record<string,string>} headers lower-cased keys
   * @param {import('node:stream').Readable|null} stream set when the body was piped
   *   through to the caller instead of collected, which is how the relay streams a
   *   file without holding it
   */
  constructor(status, body, headers, contentType, finalUrl, downloadedBytes, stream = null) {
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.contentType = contentType;
    this.finalUrl = finalUrl;
    this.downloadedBytes = downloadedBytes;
    this.stream = stream;
  }

  ok() {
    return this.status >= 200 && this.status < 300;
  }

  header(name) {
    const v = this.headers[String(name).toLowerCase()];
    return v === undefined ? null : v;
  }

  isHtml() {
    const type = String(this.contentType).toLowerCase();
    return type.includes('html')
      || type.includes('xml')
      || /<!DOCTYPE|<html/i.test(String(this.body).slice(0, 4096));
  }

  json(fallback = {}) {
    let decoded = null;
    try {
      decoded = JSON.parse(this.body);
    } catch {
      return fallback;
    }
    return decoded !== null && typeof decoded === 'object' ? decoded : fallback;
  }

  free() {
    this.body = '';
  }
}
