import { randomUUID } from 'node:crypto';
import config from '../config.js';

const DEFAULT_LEASE_MS = config.sessionLeaseMs;
const MAX_WAIT_MS = config.sessionLeaseWaitMs;

/** Single-owner FIFO lease for the one shared Gemini tab. */
export class SessionLeaseManager {
  constructor({ leaseMs = DEFAULT_LEASE_MS, maxWaitMs = MAX_WAIT_MS, onChange = () => {} } = {}) {
    this.leaseMs = leaseMs;
    this.maxWaitMs = maxWaitMs;
    this.onChange = onChange;
    this.current = null;
    this.waiters = [];
    this.expiryTimer = null;
  }

  setOnChange(callback) {
    this.onChange = callback;
  }

  acquire(ownerId, { waitMs = MAX_WAIT_MS, signal } = {}) {
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      return Promise.reject(new Error('ownerId is required'));
    }
    if (signal?.aborted) return Promise.reject(abortError());

    this.expireIfNeeded();
    if (!this.current && this.waiters.length === 0) {
      return Promise.resolve(this.grant(ownerId));
    }

    return new Promise((resolve, reject) => {
      const waiter = { ownerId, resolve, reject, settled: false, timer: null, signal, onAbort: null };
      const timeoutMs = Math.min(this.maxWaitMs, Math.max(0, Number(waitMs) || 0));
      waiter.timer = setTimeout(() => this.removeWaiter(waiter, timeoutError()), timeoutMs);
      waiter.onAbort = () => this.removeWaiter(waiter, abortError());
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  renew(token) {
    this.expireIfNeeded();
    if (!this.current || this.current.token !== token) return null;
    this.current.expiresAt = Date.now() + this.leaseMs;
    this.scheduleExpiry();
    this.onChange();
    return { expiresAt: this.current.expiresAt, leaseMs: this.leaseMs };
  }

  release(token) {
    this.expireIfNeeded();
    if (!this.current || this.current.token !== token) return false;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.current = null;
    this.onChange();
    this.grantNext();
    return true;
  }

  getActiveLeaseCount() {
    this.expireIfNeeded();
    return this.current ? 1 : 0;
  }

  getState() {
    this.expireIfNeeded();
    return {
      ownerId: this.current?.ownerId || null,
      expiresAt: this.current?.expiresAt || null,
      waiting: this.waiters.length,
    };
  }

  removeWaiter(waiter, error) {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    this.waiters = this.waiters.filter((entry) => entry !== waiter);
    waiter.reject(error);
    this.grantNext();
  }

  grant(ownerId) {
    const now = Date.now();
    const lease = { token: randomUUID(), ownerId, createdAt: now, expiresAt: now + this.leaseMs };
    this.current = lease;
    this.scheduleExpiry();
    this.onChange();
    return { token: lease.token, ownerId, expiresAt: lease.expiresAt, leaseMs: this.leaseMs };
  }

  grantNext() {
    this.expireIfNeeded();
    if (this.current) return;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(this.grant(waiter.ownerId));
      return;
    }
  }

  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    if (!this.current) return;
    const token = this.current.token;
    this.expiryTimer = setTimeout(() => {
      if (this.current?.token !== token) return;
      this.expireIfNeeded();
      this.grantNext();
    }, Math.max(1, this.current.expiresAt - Date.now()));
    this.expiryTimer.unref?.();
  }

  expireIfNeeded() {
    if (!this.current || this.current.expiresAt > Date.now()) return false;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.current = null;
    this.onChange();
    this.grantNext();
    return true;
  }
}

export const sessionLeaseManager = new SessionLeaseManager();

function timeoutError() {
  const error = new Error('Timed out waiting for Gemini session lease');
  error.code = 'SESSION_LEASE_TIMEOUT';
  return error;
}

function abortError() {
  const error = new Error('Canceled while waiting for Gemini session lease');
  error.code = 'SESSION_LEASE_CANCELED';
  return error;
}
