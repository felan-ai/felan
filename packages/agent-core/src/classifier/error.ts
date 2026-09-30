export class ClassifierError extends Error {
  readonly code: 'invalid_request' | 'response_invalid' | 'request_failed' | 'timeout' | 'aborted';

  constructor(code: ClassifierError['code'], message: string) {
    super(message);
    this.name = 'ClassifierError';
    this.code = code;
  }
}
