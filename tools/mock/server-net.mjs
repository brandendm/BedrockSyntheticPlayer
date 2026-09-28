// A stand-in for @minecraft/server-net (game/bridge.js's HTTP to the brain): every call fails
// quietly, as if the brain weren't running.
export const http = { request: async () => ({ status: 0, body: '' }), cancelAll() {} };
export class HttpRequest {
  constructor(uri) { this.uri = uri; this.headers = []; }
  setMethod() { return this; }
  setBody() { return this; }
  setHeaders() { return this; }
  setTimeout() { return this; }
}
export const HttpRequestMethod = { Get: 'Get', Post: 'Post' };
export class HttpHeader { constructor(key, value) { this.key = key; this.value = value; } }
