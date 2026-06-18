const http = require("http");

const origCreate = http.createServer.bind(http);

function normalizeIp(ip) {
  if (!ip) return "";
  return String(ip).replace(/^::ffff:/, "").trim();
}

function isTrustedProxyHop(ip) {
  const normalized = normalizeIp(ip);
  return normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized);
}

function firstForwardedIp(value) {
  if (!value) return "";
  const first = String(value).split(",")[0]?.trim();
  return normalizeIp(first);
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    // Forwarding headers present = request arrived via a reverse proxy; loopback
    // socket is the proxy hop, not the end-user, so it must not be trusted as local.
    const viaProxy = !!(req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
    const forwardedIp = firstForwardedIp(req.headers["x-forwarded-for"] || req.headers["x-real-ip"]);
    const ip = viaProxy && forwardedIp && isTrustedProxyHop(socketIp) ? forwardedIp : normalizeIp(socketIp);
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    req.headers["x-9r-real-ip"] = ip;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  return origCreate(...rest, wrapped);
};

require("./server.js");
