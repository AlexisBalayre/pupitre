export class ContextBudgetExceededError extends Error {
  constructor(
    readonly tokenEstimate: number,
    readonly budget: number,
  ) {
    super(
      `Compiled context is ~${tokenEstimate} tokens, over the ${budget}-token budget. ` +
        'Trim the task spec or conventions, or raise contextBudget on the role layer.',
    );
    this.name = 'ContextBudgetExceededError';
  }
}

export class InvalidProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProfileError';
  }
}
