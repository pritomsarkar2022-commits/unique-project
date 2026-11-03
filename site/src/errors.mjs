/**
 * The three failure types the php original raises, ported as-is.
 *
 * ExtractException carries a short user-facing hint because these messages render
 * straight into the result card, and a code name the log lines and tests match on.
 */
export class ExtractException extends Error {
  /**
   * @param {string} message what the visitor is told
   * @param {string} hint what the visitor is told to do next
   * @param {string} codeName machine-readable reason
   */
  constructor(message, hint = '', codeName = 'extract_failed') {
    super(message);
    this.name = 'ExtractException';
    this.hint = hint;
    this.codeName = codeName;
  }
}

/** Raised when an outbound request fails or is refused, with the remote status attached. */
export class HttpException extends Error {
  constructor(message, status = 0, url = '') {
    super(message);
    this.name = 'HttpException';
    this.status = status;
    this.url = url;
  }
}

/** Thrown when a url is refused before any request leaves the server. */
export class UrlGuardException extends Error {
  constructor(message) {
    super(message);
    this.name = 'UrlGuardException';
  }
}
