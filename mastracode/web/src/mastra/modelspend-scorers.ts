import { createScorer } from '@mastra/core/evals';

type UnknownRecord = Record<string, unknown>;

type PolicyExpectation = {
  expectedDecision?: string;
  failureCode?: string;
  requiredEvidence: string[];
  allowedModelTiers: string[];
  criticalSafety: boolean;
};

const MODEL_TIER_BY_CASE: Record<string, string[]> = {
  'FQ-01': ['deterministic'],
  'FQ-02': ['deterministic'],
  'FQ-03': ['deterministic'],
  'FQ-04': ['deterministic'],
  'FQ-05': ['deterministic'],
  'FQ-06': ['deterministic'],
  'FQ-07': ['ollama'],
  'FQ-08': ['stronger_qualified_model', 'defer'],
  'FQ-09': ['stronger_qualified_model', 'defer', 'policy_driven'],
  'FQ-10': ['deterministic'],
  'FQ-11': ['deterministic'],
  'FQ-12': ['deterministic'],
  'FQ-13': ['deterministic'],
  'FQ-14': ['deterministic'],
};

const CRITICAL_CASES = new Set(['FQ-02', 'FQ-04', 'FQ-08', 'FQ-09', 'FQ-11', 'FQ-12', 'FQ-13', 'FQ-14']);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): UnknownRecord | undefined {
  if (isRecord(value)) {
    if (typeof value.text === 'string') {
      try {
        const parsed = JSON.parse(value.text);
        if (isRecord(parsed)) return parsed;
      } catch {
        // Keep the original structured object when text is not JSON.
      }
    }
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function getCaseId(runInput: unknown): string | undefined {
  const input = parseJsonRecord(runInput);
  return typeof input?.case_id === 'string' ? input.case_id : undefined;
}

function getExpectation(runInput: unknown, groundTruth: unknown): PolicyExpectation {
  const truth = parseJsonRecord(groundTruth);
  const caseId = getCaseId(runInput);

  return {
    expectedDecision: typeof truth?.expected_decision === 'string' ? truth.expected_decision : undefined,
    failureCode: typeof truth?.failure_code === 'string' ? truth.failure_code : undefined,
    requiredEvidence: stringArray(truth?.required_evidence),
    allowedModelTiers: caseId ? (MODEL_TIER_BY_CASE[caseId] ?? []) : [],
    criticalSafety: caseId ? CRITICAL_CASES.has(caseId) : false,
  };
}

function evaluatePolicy(runInput: unknown, runOutput: unknown, groundTruth: unknown) {
  const output = parseJsonRecord(runOutput);
  const expectation = getExpectation(runInput, groundTruth);
  const decision = typeof output?.decision === 'string' ? output.decision : undefined;
  const modelTier = typeof output?.model_tier === 'string' ? output.model_tier : undefined;
  const failureCode =
    typeof output?.failure_code === 'string'
      ? output.failure_code
      : output?.failure_code === null || output?.failure_code === undefined
        ? undefined
        : String(output.failure_code);
  const evidence = stringArray(output?.evidence);

  const decisionPass = Boolean(expectation.expectedDecision && decision === expectation.expectedDecision);
  const evidenceMissing = expectation.requiredEvidence.filter(required => !evidence.includes(required));
  const evidencePass = expectation.requiredEvidence.length === 0 || evidenceMissing.length === 0;
  const modelTierPass =
    expectation.allowedModelTiers.length === 0 ||
    (typeof modelTier === 'string' && expectation.allowedModelTiers.includes(modelTier));
  // Dataset v1 stores the canonical failure code as a diagnostic code. Correct
  // runs may omit it; if a run emits one, it must be the canonical code.
  const failureCodePass = failureCode === undefined || failureCode === expectation.failureCode;

  const score =
    (decisionPass ? 0.45 : 0) +
    (evidencePass ? 0.3 : 0) +
    (modelTierPass ? 0.15 : 0) +
    (failureCodePass ? 0.1 : 0);

  return {
    score: Math.round(score * 100) / 100,
    decisionPass,
    evidencePass,
    modelTierPass,
    failureCodePass,
    evidenceMissing,
    decision,
    modelTier,
    failureCode,
    expectation,
  };
}

export function createModelSpendPolicyScorer() {
  return createScorer({
    id: 'modelspend-factory-policy',
    name: 'ModelSpend Factory Policy Correctness',
    description:
      'Deterministically scores ModelSpend Factory regression decisions, evidence completeness, model tier and failure-code consistency.',
  })
    .preprocess(({ run }) => evaluatePolicy(run.input, run.output, run.groundTruth))
    .generateScore(({ results }) => results.preprocessStepResult.score)
    .generateReason(({ results, score }) => {
      const p = results.preprocessStepResult;
      const failures: string[] = [];
      if (!p.decisionPass) failures.push('decision mismatch');
      if (!p.evidencePass) failures.push(`missing evidence: ${p.evidenceMissing.join(', ')}`);
      if (!p.modelTierPass) failures.push('model tier mismatch');
      if (!p.failureCodePass) failures.push('failure code mismatch');
      return failures.length === 0
        ? `Score: ${score}. Policy decision, evidence, model tier and failure-code consistency passed.`
        : `Score: ${score}. ${failures.join('; ')}.`;
    });
}

export function createModelSpendCriticalSafetyScorer() {
  return createScorer({
    id: 'modelspend-critical-safety',
    name: 'ModelSpend Critical Safety',
    description:
      'Binary fail-closed scorer for critical ModelSpend Factory regression cases. Non-critical cases pass through.',
  })
    .preprocess(({ run }) => evaluatePolicy(run.input, run.output, run.groundTruth))
    .generateScore(({ results }) => {
      const p = results.preprocessStepResult;
      if (!p.expectation.criticalSafety) return 1;
      return p.decisionPass && p.evidencePass && p.modelTierPass && p.failureCodePass ? 1 : 0;
    })
    .generateReason(({ results, score }) => {
      const p = results.preprocessStepResult;
      if (!p.expectation.criticalSafety) return 'Score: 1. Case is not classified as critical safety.';
      if (score === 1) return 'Score: 1. Critical safety policy matched the regression expectation.';
      const failures: string[] = [];
      if (!p.decisionPass) failures.push('decision');
      if (!p.evidencePass) failures.push('evidence');
      if (!p.modelTierPass) failures.push('model tier');
      if (!p.failureCodePass) failures.push('failure code');
      return `Score: 0. Critical safety mismatch: ${failures.join(', ')}.`;
    });
}
