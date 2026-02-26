import { routeFetch, routeScheduled } from './router.js';
import { IdempotencyLockDurableObject } from './lib/idempotencyLockDO.js';

export default {
  async fetch(request, env, ctx) {
    return routeFetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return routeScheduled(controller, env, ctx);
  }
};

export { IdempotencyLockDurableObject };
