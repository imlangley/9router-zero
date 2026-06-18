// In-memory progressive lockout for dashboard login. Resets on process restart.

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset

const attempts = new Map(); // ip → { fails, lockUntil, lockLevel, lastFailAt }

function now() { return Date.now(); }

function getEntry(ip) {
  const e = attempts.get(ip);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    attempts.delete(ip);
    return null;
  }
  return e;
}

export function checkLock(ip) {
  // Skip locking for unknown IPs (null) to prevent shared bucket lockout
  if (!ip) return { locked: false };
  const e = getEntry(ip);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

export function recordFail(ip) {
  // Skip recording for unknown IPs (null) to prevent shared bucket lockout
  if (!ip) return { remainingBeforeLock: MAX_FAILS_BEFORE_LOCK };
  const e = getEntry(ip) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
  }
  attempts.set(ip, e);
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function recordSuccess(ip) {
  if (!ip) return;
  attempts.delete(ip);
}

export function getClientIp(request) {
  // Trusted: set from TCP socket by custom-server.js (client cannot spoof).
  const realIp = request.headers.get("x-9r-real-ip");
  if (realIp) {
    // If the real IP is a private/local address (proxy), try XFF
    if (isPrivateIp(realIp)) {
      const xff = request.headers.get("x-forwarded-for");
      if (xff) {
        const clientIp = xff.split(",")[0].trim();
        if (clientIp && !isPrivateIp(clientIp)) return clientIp;
      }
    }
    return realIp;
  }
  // Behind a trusted reverse proxy that overwrites XFF with the real client IP.
  if (process.env.TRUST_PROXY === "true") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  // Direct exposure without custom-server: use XFF if available, otherwise skip locking
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const clientIp = xff.split(",")[0].trim();
    if (clientIp && !isPrivateIp(clientIp)) return clientIp;
  }
  // Return null to skip locking for unknown IPs (prevents shared bucket lockout)
  return null;
}

function isPrivateIp(ip) {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
  );
}
