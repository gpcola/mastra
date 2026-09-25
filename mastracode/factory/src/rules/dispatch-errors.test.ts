import { describe, expect, it } from 'vitest';

import { factoryDispatchFailureMetadata, isProviderUsageLimitError } from './dispatch-errors.js';

describe('Factory dispatch failure policy', () => {
  it('does not offer Retry for deterministic workspace failures', () => {
    expect(factoryDispatchFailureMetadata('repository_git_missing').canRetry).toBe(false);
    expect(factoryDispatchFailureMetadata('repository_egress_blocked').canRetry).toBe(false);
    expect(factoryDispatchFailureMetadata('repository_cli_missing').canRetry).toBe(false);
    expect(factoryDispatchFailureMetadata('unsupported_provider_item').canRetry).toBe(false);
    expect(factoryDispatchFailureMetadata('run_terminal_event_missing').canRetry).toBe(false);
    expect(factoryDispatchFailureMetadata('provider_usage_limit').canRetry).toBe(false);
    expect(factoryDispatchFailureMetadata('skill_delivery_ambiguous').canRetry).toBe(false);
    // Rows written before a pause stopped counting as a failure: retrying one kicks a run nobody asked for.
    expect(factoryDispatchFailureMetadata('plan_awaiting_approval').canRetry).toBe(false);
    expect(factoryDispatchFailureMetadata('run_awaiting_input').canRetry).toBe(false);
  });

  it('offers Retry for repeatable transport and repository operations', () => {
    expect(factoryDispatchFailureMetadata('notification_delivery_failed').canRetry).toBe(true);
    expect(factoryDispatchFailureMetadata('repository_clone_failed').canRetry).toBe(true);
    expect(factoryDispatchFailureMetadata('repository_pull_failed').canRetry).toBe(true);
    expect(factoryDispatchFailureMetadata('source_control_missing').canRetry).toBe(true);
    expect(factoryDispatchFailureMetadata('session_unavailable').canRetry).toBe(true);
    expect(factoryDispatchFailureMetadata('unknown').canRetry).toBe(true);
    expect(factoryDispatchFailureMetadata(null).canRetry).toBe(true);
  });
});


describe('provider usage-limit classification', () => {
  it('identifies the structured included-credit cap without retaining raw provider details', () => {
    const error = Object.assign(new Error('The usage limit has been reached'), {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 1234, secret: 'must-not-persist' } }),
    });
    expect(isProviderUsageLimitError(error)).toBe(true);
    expect(factoryDispatchFailureMetadata('provider_usage_limit').label).toBe('Model provider usage allowance exhausted');
  });

  it('keeps ordinary transient 429 and ambiguous errors retryable', () => {
    const transient = Object.assign(new Error('Rate limit exceeded'), {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { type: 'rate_limit_exceeded' } }),
    });
    expect(isProviderUsageLimitError(transient)).toBe(false);
    expect(isProviderUsageLimitError(new Error('Network timeout'))).toBe(false);
    expect(isProviderUsageLimitError({ responseBody: '{not-json' })).toBe(false);
    expect(factoryDispatchFailureMetadata('unknown').canRetry).toBe(true);
  });

  it('finds a typed exhausted quota inside a bounded cause chain', () => {
    expect(isProviderUsageLimitError(new Error('Provider failed', {
      cause: { responseBody: JSON.stringify({ error: { code: 'insufficient_quota' } }) },
    }))).toBe(true);
  });
});
