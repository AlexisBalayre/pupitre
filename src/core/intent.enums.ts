/**
 * Where an intent stands (decision 126). A draft is anyone's to write; only
 * the operator moves it to accepted, with `pup intent accept`. Closed is the
 * intent done with, which part 2 sets.
 */
export enum IntentStatus {
  Draft = 'draft',
  Accepted = 'accepted',
  Closed = 'closed',
}
