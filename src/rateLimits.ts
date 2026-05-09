import { currentPolicies } from "./policies.js";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function checkBucket(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + windowMs };
    buckets.set(key, next);
    return { allowed: true, remaining: limit - 1, resetAt: next.resetAt };
  }
  if (current.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: current.resetAt };
  }
  current.count += 1;
  return { allowed: true, remaining: limit - current.count, resetAt: current.resetAt };
}

export function checkMessageRate(contactId?: number) {
  const policy = currentPolicies().rateLimits.globalMessages;
  const windowMs = policy.windowSeconds * 1000;
  const global = checkBucket("messages:global", policy.limit, windowMs);
  const contact = contactId ? checkBucket(`messages:contact:${contactId}`, policy.limit, windowMs) : global;
  return global.allowed && contact.allowed ? contact : { allowed: false, remaining: 0, resetAt: Math.max(global.resetAt, contact.resetAt) };
}

export function checkAiRate(userId: number) {
  const policies = currentPolicies().rateLimits;
  const minute = checkBucket(`ai:minute:${userId}`, policies.aiGeneration.limit, policies.aiGeneration.windowSeconds * 1000);
  const daily = checkBucket(`ai:daily:${userId}`, policies.aiDaily.limit, policies.aiDaily.windowSeconds * 1000);
  return minute.allowed && daily.allowed ? minute : { allowed: false, remaining: 0, resetAt: Math.max(minute.resetAt, daily.resetAt) };
}

export function checkAiQuota(userId: number, contactId: number) {
  const user = checkAiRate(userId);
  const policy = currentPolicies().rateLimits.aiContactDaily;
  const contactDaily = checkBucket(`ai:contact-daily:${contactId}`, policy.limit, policy.windowSeconds * 1000);
  return user.allowed && contactDaily.allowed ? {
    allowed: true,
    remaining: Math.min(user.remaining, contactDaily.remaining),
    resetAt: Math.max(user.resetAt, contactDaily.resetAt),
    scope: `user:${userId}:contact:${contactId}`
  } : {
    allowed: false,
    remaining: 0,
    resetAt: Math.max(user.resetAt, contactDaily.resetAt),
    scope: user.allowed ? `contact:${contactId}:daily` : `user:${userId}`
  };
}

export function rateLimitStatus() {
  const now = Date.now();
  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    count: bucket.resetAt > now ? bucket.count : 0,
    resetAt: new Date(bucket.resetAt).toISOString()
  }));
}
