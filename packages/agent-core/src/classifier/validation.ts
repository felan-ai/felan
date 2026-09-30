import type { JsonObject, ClassifierQuestion as PiClassifierQuestion } from '@earendil-works/pi-ai';
import { ClassifierError } from './error.js';
import type { ClassifierAnswers, ClassifierQuestions } from './types.js';

const MAX_COMBINED_INPUT_BYTES = 64_000;
const MAX_STATE_AND_QUESTION_BYTES = 32_000;
const MAX_INSTRUCTIONS_BYTES = 4_096;

export function prepareClassifierRequest(model: string, state: unknown, questions: ClassifierQuestions) {
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch {
    throw new ClassifierError('invalid_request', 'Classifier state must be serializable');
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_STATE_AND_QUESTION_BYTES) {
    throw new ClassifierError('invalid_request', 'Classifier state exceeds the size budget');
  }
  const normalized: unknown = JSON.parse(serialized);
  if (!isRecord(normalized)) {
    throw new ClassifierError('invalid_request', 'Classifier state must be a JSON object');
  }
  if (!isRecord(questions)) throw new ClassifierError('invalid_request', 'Classifier questions must be an object');
  const entries = Object.entries(questions);
  if (entries.length === 0) throw new ClassifierError('invalid_request', 'Classifier questions are required');
  const overhead = Buffer.byteLength(JSON.stringify({ model, state: normalized, questions: {} }), 'utf8');
  const batches: Record<string, PiClassifierQuestion>[] = [];
  let current: Record<string, PiClassifierQuestion> = Object.create(null);
  let currentBytes = overhead;
  for (const [id, question] of entries) {
    if (!isRecord(question) || !id.trim() || id.length > 128 || typeof question.instructions !== 'string'
      || !question.instructions.trim()
      || Buffer.byteLength(question.instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES) {
      throw new ClassifierError('invalid_request', 'Classifier question is invalid');
    }
    let native: PiClassifierQuestion;
    if (question.type === 'choice') {
      if (!isRecord(question.criteria)) throw new ClassifierError('invalid_request', 'Classifier choice criteria are invalid');
      const values = Object.values(question.criteria);
      if (values.length < 2 || values.length > 16 || values.some(value => typeof value !== 'string')) {
        throw new ClassifierError('invalid_request', 'Classifier choice criteria are invalid');
      }
      native = { ...question, criteria: { ...question.criteria } };
    } else if (question.type === 'bool') {
      if (!isRecord(question.criteria) || typeof question.criteria.true !== 'string' || typeof question.criteria.false !== 'string') {
        throw new ClassifierError('invalid_request', 'Classifier bool criteria are invalid');
      }
      native = { ...question, criteria: { ...question.criteria } };
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 16
        || question.criteria.some(value => typeof value !== 'string')) {
        throw new ClassifierError('invalid_request', 'Classifier score criteria are invalid');
      }
      native = { ...question, criteria: [...question.criteria] };
    } else {
      throw new ClassifierError('invalid_request', 'Classifier question type is invalid');
    }
    const added = Buffer.byteLength(JSON.stringify({ [id]: native }), 'utf8') + 1;
    if (overhead + added > MAX_STATE_AND_QUESTION_BYTES) {
      throw new ClassifierError('invalid_request', 'Classifier question exceeds the size budget');
    }
    if (Object.keys(current).length > 0 && currentBytes + added > MAX_COMBINED_INPUT_BYTES) {
      batches.push(current);
      current = Object.create(null);
      currentBytes = overhead;
    }
    current[id] = native;
    currentBytes += added;
  }
  batches.push(current);
  return { state: normalized as JsonObject, batches };
}

export function validateClassifierAnswers(questions: ClassifierQuestions, value: unknown): ClassifierAnswers {
  if (!isRecord(value)) throw new ClassifierError('response_invalid', 'Classifier response is missing answers');
  const answers: Record<string, ClassifierAnswers[string]> = Object.create(null);
  for (const [id, question] of Object.entries(questions)) {
    const answer = value[id];
    if (!isRecord(answer) || answer.type !== question.type) throw invalidAnswer();
    if (question.type === 'bool') {
      if (!isUnit(answer.probability)) throw invalidAnswer();
      answers[id] = { type: 'bool', probability: answer.probability };
      continue;
    }
    if (answer.confidence !== undefined && !isUnit(answer.confidence)) throw invalidAnswer();
    const confidence = answer.confidence as number | undefined;
    if (question.type === 'choice') {
      if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)) throw invalidAnswer();
      if (answer.probabilities !== undefined && (!isRecord(answer.probabilities)
        || Object.values(answer.probabilities).some(value => !isUnit(value)))) throw invalidAnswer();
      answers[id] = {
        type: 'choice', choice: answer.choice,
        ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities as Record<string, number> }),
        ...(confidence === undefined ? {} : { confidence }),
      };
    } else {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)) throw invalidAnswer();
      answers[id] = { type: 'score', score: answer.score, ...(confidence === undefined ? {} : { confidence }) };
    }
  }
  return answers;
}

function invalidAnswer(): ClassifierError {
  return new ClassifierError('response_invalid', 'Classifier returned an invalid answer');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
