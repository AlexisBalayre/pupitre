export interface LedgerEntryRow {
  id: number;
  project_id: string;
  description: string;
  /** JSON array of repo-relative paths. */
  files: string;
  reason: string;
  accepted_by: string;
  review_by: string;
  status: 'open' | 'closed';
  created_at: string;
}

export interface NewLedgerEntryInput {
  projectId: string;
  description: string;
  files: string[];
  reason: string;
  acceptedBy: string;
  reviewBy: string;
}
