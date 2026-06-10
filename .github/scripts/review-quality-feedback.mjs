import { readFile } from 'node:fs/promises';

const REVIEW_MARKER_PREFIX = '<!-- review-quality-feedback:';
const MAX_PAGE_SIZE = 100;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function wordCount(text) {
  const normalized = text.trim();
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function sentenceCount(text) {
  const matches = text.match(/[.!?](?:\s|$)/gmu);
  return matches?.length ?? 0;
}

function countMatches(text, pattern) {
  return text.match(pattern)?.length ?? 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function scoreLabel(score) {
  if (score >= 4) {
    return 'Strong';
  }

  if (score === 3) {
    return 'Good';
  }

  if (score === 2) {
    return 'Fair';
  }

  if (score === 1) {
    return 'Weak';
  }

  return 'Missing';
}

function overallLabel(score) {
  if (score >= 13) {
    return 'High signal';
  }

  if (score >= 9) {
    return 'Moderate signal';
  }

  if (score >= 5) {
    return 'Low signal';
  }

  return 'Very low signal';
}

async function requestJson(url, { method = 'GET', body } = {}) {
  const token = requireEnv('GITHUB_TOKEN');
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'review-quality-feedback',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API ${method} ${url} failed: ${response.status} ${errorBody}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function paginateJson(baseUrl) {
  const pages = [];

  for (let page = 1; ; page += 1) {
    const url = new URL(baseUrl);
    url.searchParams.set('per_page', String(MAX_PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const batch = await requestJson(url.toString());
    pages.push(...batch);

    if (batch.length < MAX_PAGE_SIZE) {
      return pages;
    }
  }
}

function evaluateReview({ reviewBody, inlineComments, changedFileCount }) {
  const inlineBodies = inlineComments
    .map((comment) => comment.body?.trim() ?? '')
    .filter(Boolean);
  const combinedText = [reviewBody.trim(), ...inlineBodies].filter(Boolean).join('\n\n');
  const combinedWords = wordCount(combinedText);
  const reviewWords = wordCount(reviewBody);
  const totalSentences = sentenceCount(combinedText);
  const distinctFiles = new Set(
    inlineComments.map((comment) => comment.path).filter(Boolean),
  );
  const actionableSignals = countMatches(
    combinedText,
    /\b(should|could|consider|please|can you|suggest|recommend|needs to|need to|avoid|prefer|replace|rename|add|remove|extract|handle|guard|validate|test|document|refactor|simplify|split)\b/giu,
  );
  const reasoningSignals = countMatches(
    combinedText,
    /\b(because|since|so that|to avoid|otherwise|risk|bug|security|performance|readability|maintainability|correctness|consistency|regression|edge case|test coverage|accessibility|reliability)\b/giu,
  );
  const specificitySignals = countMatches(
    combinedText,
    /(`[^`]+`|\bline\s+\d+\b|[A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|jsx|css|html|json|yml|yaml|md)\b)/gu,
  );

  let specificity = 0;
  if (reviewWords >= 8 || inlineComments.length > 0) {
    specificity += 1;
  }
  if (inlineComments.length > 0 || specificitySignals > 0) {
    specificity += 1;
  }
  if (totalSentences >= 3 || inlineComments.length >= 2 || distinctFiles.size >= 2) {
    specificity += 1;
  }
  if (inlineComments.length >= 4 || distinctFiles.size >= 3 || specificitySignals >= 3) {
    specificity += 1;
  }

  let actionability = 0;
  if (actionableSignals >= 1) {
    actionability += 1;
  }
  if (actionableSignals >= 3) {
    actionability += 1;
  }
  if (/\b(can you|please|consider|recommend|suggest|instead|prefer|follow up with)\b/iu.test(combinedText)) {
    actionability += 1;
  }
  if (inlineComments.length >= 2 && actionableSignals >= 2) {
    actionability += 1;
  }

  let reasoning = 0;
  if (reasoningSignals >= 1) {
    reasoning += 1;
  }
  if (reasoningSignals >= 2) {
    reasoning += 1;
  }
  if (/\b(because|so that|to avoid|otherwise)\b/iu.test(combinedText)) {
    reasoning += 1;
  }
  if (combinedWords >= 40 && reasoningSignals >= 2) {
    reasoning += 1;
  }

  let coverage = 0;
  const observableCoverageRatio = changedFileCount > 0 ? distinctFiles.size / changedFileCount : 0;
  if (reviewWords >= 15 || inlineComments.length >= 1) {
    coverage += 1;
  }
  if (distinctFiles.size >= 2 || inlineComments.length >= 2 || observableCoverageRatio >= 0.25) {
    coverage += 1;
  }
  if (distinctFiles.size >= 3 || inlineComments.length >= 4 || observableCoverageRatio >= 0.5) {
    coverage += 1;
  }
  if (distinctFiles.size >= 5 || observableCoverageRatio >= 0.75) {
    coverage += 1;
  }

  const approvalWithoutContent = combinedWords === 0;
  if (approvalWithoutContent) {
    specificity = 0;
    actionability = 0;
    reasoning = 0;
    coverage = 0;
  }

  const scores = {
    specificity: clamp(specificity, 0, 4),
    actionability: clamp(actionability, 0, 4),
    reasoning: clamp(reasoning, 0, 4),
    coverage: clamp(coverage, 0, 4),
  };

  return {
    scores,
    metrics: {
      reviewWords,
      combinedWords,
      inlineCommentCount: inlineComments.length,
      distinctReviewedFiles: distinctFiles.size,
      changedFileCount,
      observableCoverageRatio,
    },
    approvalWithoutContent,
  };
}

function dimensionFeedback({ scores, metrics }) {
  const specificityFeedback =
    scores.specificity >= 3
      ? 'The review points to concrete code locations or clearly identifies multiple issues.'
      : scores.specificity === 2
        ? 'There is some concrete feedback, but it could cite exact lines, files, or examples more often.'
        : 'The review needs more concrete references to the code or exact issues that were found.';

  const actionabilityFeedback =
    scores.actionability >= 3
      ? 'The feedback gives clear next steps or decisions for the author.'
      : scores.actionability === 2
        ? 'Some direction is present, but the author would benefit from more explicit requested changes.'
        : 'The review does not yet give the author enough specific guidance on what to change.';

  const reasoningFeedback =
    scores.reasoning >= 3
      ? 'The review explains why the feedback matters, which increases trust and learning value.'
      : scores.reasoning === 2
        ? 'Some rationale is present, but more explanation of risk, correctness, or maintainability would help.'
        : 'The review should include more reasoning about why the suggested changes matter.';

  const coverageFeedback =
    scores.coverage >= 3
      ? 'The review shows good observable breadth across the pull request.'
      : scores.coverage === 2
        ? 'The review shows some breadth, but more coverage across changed files or concerns would strengthen it.'
        : metrics.changedFileCount > 0
          ? 'Observed coverage is narrow relative to the changed files in the pull request.'
          : 'Observed coverage is limited.';

  return {
    specificityFeedback,
    actionabilityFeedback,
    reasoningFeedback,
    coverageFeedback,
  };
}

function strengthsAndImprovements({ scores, approvalWithoutContent }) {
  if (approvalWithoutContent) {
    return {
      strengths: ['The review was submitted successfully, but there is no written feedback to evaluate.'],
      improvements: [
        'Add at least one concrete observation before approving or requesting changes.',
        'Explain why the observation matters to correctness, maintainability, or user impact.',
      ],
    };
  }

  const strengths = [];
  const improvements = [];

  if (scores.specificity >= 3) {
    strengths.push('Concrete references make the review easy for the author to act on.');
  } else {
    improvements.push('Anchor feedback to specific files, lines, examples, or scenarios.');
  }

  if (scores.actionability >= 3) {
    strengths.push('The review gives clear next steps instead of vague concerns.');
  } else {
    improvements.push('Phrase more comments as explicit suggestions, requests, or alternatives.');
  }

  if (scores.reasoning >= 3) {
    strengths.push('The review explains why the requested changes matter.');
  } else {
    improvements.push('Add rationale such as risk, correctness, performance, readability, or regression impact.');
  }

  if (scores.coverage >= 3) {
    strengths.push('The review shows good observable breadth across the PR.');
  } else {
    improvements.push('Cover more of the changed surface area or mention what you intentionally spot-checked.');
  }

  if (strengths.length === 0) {
    strengths.push('The review has enough signal to coach and improve on the next pass.');
  }

  return { strengths, improvements };
}

function buildComment({
  reviewId,
  reviewerLogin,
  reviewState,
  scores,
  metrics,
  feedback,
  overall,
  strengths,
  improvements,
}) {
  const percentage = Math.round((overall.total / overall.maximum) * 100);
  const observableCoverage = metrics.changedFileCount > 0
    ? `${Math.round(metrics.observableCoverageRatio * 100)}%`
    : 'n/a';

  return [
    `${REVIEW_MARKER_PREFIX}${reviewId} -->`,
    '## Review Quality Feedback',
    '',
    `Review by @${reviewerLogin} (${reviewState})`,
    '',
    `**Overall:** ${overall.label} (${overall.total}/${overall.maximum}, ${percentage}%)`,
    '',
    '| Dimension | Score | Feedback |',
    '| --- | --- | --- |',
    `| Specificity | ${scores.specificity}/4 (${scoreLabel(scores.specificity)}) | ${feedback.specificityFeedback} |`,
    `| Actionability | ${scores.actionability}/4 (${scoreLabel(scores.actionability)}) | ${feedback.actionabilityFeedback} |`,
    `| Reasoning | ${scores.reasoning}/4 (${scoreLabel(scores.reasoning)}) | ${feedback.reasoningFeedback} |`,
    `| Observable coverage | ${scores.coverage}/4 (${scoreLabel(scores.coverage)}) | ${feedback.coverageFeedback} |`,
    '',
    `Observed ${metrics.inlineCommentCount} inline comment(s) across ${metrics.distinctReviewedFiles} file(s) on a PR that changes ${metrics.changedFileCount} file(s). Approximate observed coverage: ${observableCoverage}.`,
    '',
    '**What works well**',
    ...strengths.map((item) => `- ${item}`),
    '',
    '**How to strengthen this review**',
    ...improvements.map((item) => `- ${item}`),
    '',
    '_This is heuristic coaching based on the submitted review text and inline comments. It does not judge whether the technical conclusions of the review are correct._',
  ].join('\n');
}

async function upsertIssueComment({ owner, repo, issueNumber, marker, body }) {
  const comments = await paginateJson(
    `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
  );
  const existing = comments.find(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      (comment.body ?? '').includes(marker),
  );

  if (existing) {
    await requestJson(
      `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      {
        method: 'PATCH',
        body: { body },
      },
    );
    return 'updated';
  }

  await requestJson(
    `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      body: { body },
    },
  );
  return 'created';
}

async function main() {
  const repository = requireEnv('GITHUB_REPOSITORY');
  const eventPath = requireEnv('GITHUB_EVENT_PATH');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));

  if (event.action !== 'submitted') {
    console.log(`Skipping unsupported action: ${event.action ?? 'unknown'}`);
    return;
  }

  const review = event.review;
  const pullRequest = event.pull_request;

  if (!review || !pullRequest) {
    throw new Error('Expected pull_request_review event payload with review and pull_request objects.');
  }

  const reviewerLogin = review.user?.login ?? 'unknown';
  const reviewerType = review.user?.type ?? 'unknown';
  const isBotReview = reviewerType !== 'User' || reviewerLogin.endsWith('[bot]');

  if (isBotReview) {
    console.log(`Skipping bot or non-user review from ${reviewerLogin}.`);
    return;
  }

  const [owner, repo] = repository.split('/');
  const apiBase = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const reviewComments = await paginateJson(
    `${apiBase}/repos/${owner}/${repo}/pulls/${pullRequest.number}/reviews/${review.id}/comments`,
  );
  const changedFiles = await paginateJson(
    `${apiBase}/repos/${owner}/${repo}/pulls/${pullRequest.number}/files`,
  );

  const evaluation = evaluateReview({
    reviewBody: review.body ?? '',
    inlineComments: reviewComments,
    changedFileCount: changedFiles.length,
  });
  const overallTotal = Object.values(evaluation.scores).reduce((sum, value) => sum + value, 0);
  const overall = {
    total: overallTotal,
    maximum: 16,
    label: overallLabel(overallTotal),
  };
  const feedback = dimensionFeedback(evaluation);
  const guidance = strengthsAndImprovements(evaluation);
  const marker = `${REVIEW_MARKER_PREFIX}${review.id} -->`;
  const commentBody = buildComment({
    reviewId: review.id,
    reviewerLogin,
    reviewState: String(review.state ?? 'commented').toLowerCase(),
    scores: evaluation.scores,
    metrics: evaluation.metrics,
    feedback,
    overall,
    strengths: guidance.strengths,
    improvements: guidance.improvements,
  });

  const result = await upsertIssueComment({
    owner,
    repo,
    issueNumber: pullRequest.number,
    marker,
    body: commentBody,
  });

  console.log(`Review quality feedback ${result} for review ${review.id}.`);
}

await main();
