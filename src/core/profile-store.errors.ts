export class UnknownProfileError extends Error {
  constructor(name: string, profilesDir: string) {
    super(`No profile layer \`${name}\` (looked for ${name}.yml in ${profilesDir}).`);
    this.name = 'UnknownProfileError';
  }
}
