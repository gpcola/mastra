import type {
  FactoryDispatchFailureCode,
  StoredFactoryDispatchFailureCode,
} from '../storage/domains/work-items/base.js';

interface FactoryDispatchFailureMetadata {
  canRetry: boolean;
  label: string;
}

const FAILURE_METADATA = {
  session_unavailable: { canRetry: true, label: 'Factory session unavailable' },
  source_control_missing: { canRetry: true, label: 'Source-control connection unavailable' },
  source_repository_missing: { canRetry: true, label: 'Source repository unavailable' },
  unsupported_provider_item: { canRetry: false, label: 'Unsupported provider work item' },
  notification_delivery_failed: { canRetry: true, label: 'Factory message delivery failed' },
  run_terminal_event_missing: { canRetry: false, label: 'Agent run terminal event was not observed' },
  skill_delivery_ambiguous: { canRetry: false, label: 'Factory skill delivery could not be confirmed' },
  run_overdue: { canRetry: false, label: 'Agent run is overdue' },
  repository_git_missing: { canRetry: false, label: 'Git is unavailable in the workspace' },
  repository_egress_blocked: { canRetry: false, label: 'Repository network access is blocked' },
  repository_clone_failed: { canRetry: true, label: 'Repository clone failed' },
  repository_pull_failed: { canRetry: true, label: 'Repository update failed' },
  repository_push_failed: { canRetry: true, label: 'Repository push failed' },
  repository_commit_failed: { canRetry: true, label: 'Repository commit failed' },
  repository_cli_missing: { canRetry: false, label: 'GitHub CLI is unavailable in the workspace' },
  repository_pr_failed: { canRetry: true, label: 'Pull request creation failed' },
  run_configuration_invalid: { canRetry: false, label: 'Run configuration rejected by provider' },
  provider_usage_limit: { canRetry: false, label: 'Model provider usage allowance exhausted' },
  unknown: { canRetry: true, label: 'Factory automation failed' },
  // Retired: no path writes these any more, stored rows still read through here.
  plan_awaiting_approval: { canRetry: false, label: 'Plan waiting for review' },
  run_awaiting_input: { canRetry: false, label: 'Agent is waiting for an answer' },
} satisfies Record<StoredFactoryDispatchFailureCode, FactoryDispatchFailureMetadata>;

/**
 * Distinguish exhausted account capacity from transient HTTP 429 throttling.
 * Do not persist provider response bodies: they may contain credentials or
 * account metadata. Inspect only a bounded structured cause/response chain.
 */
export function isProviderUsageLimitError(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === 'object'; depth += 1) {
    const detail = candidate as Record<string, unknown>;
    if (detail.code === 'usage_limit_reached' || detail.code === 'insufficient_quota') return true;
    if (detail.type === 'usage_limit_reached' || detail.type === 'insufficient_quota') return true;
    const responseBody = detail.responseBody;
    if (typeof responseBody === 'string' && responseBody.length <= 16_384) {
      try {
        const response = JSON.parse(responseBody) as { error?: { type?: unknown; code?: unknown } };
        if (response?.error?.type === 'usage_limit_reached' || response?.error?.code === 'usage_limit_reached' ||
            response?.error?.type === 'insufficient_quota' || response?.error?.code === 'insufficient_quota') {
          return true;
        }
      } catch {
        // Malformed response bodies do not classify arbitrary rate limits as quota exhaustion.
      }
    }
    candidate = detail.cause;
  }
  return false;
}

export class FactoryDispatchError extends Error {
  constructor(
    readonly code: FactoryDispatchFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FactoryDispatchError';
  }
}

export function factoryDispatchFailureCode(error: unknown): FactoryDispatchFailureCode {
  return error instanceof FactoryDispatchError ? error.code : 'unknown';
}

export function factoryDispatchFailureMetadata(
  code: StoredFactoryDispatchFailureCode | null,
): FactoryDispatchFailureMetadata {
  return code === null ? FAILURE_METADATA.unknown : FAILURE_METADATA[code];
}
