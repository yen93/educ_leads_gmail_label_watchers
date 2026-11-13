// Label search tokens for the education-sector follow-up routers.
//
// Stored as Gmail `label:` search tokens exactly as given in the task prompt. They
// are resolved to the mailbox's real label IDs at runtime by resolveLabelIds /
// getOrCreateLabelId (see gmail.ts), which match separator-insensitively — so
// differences in case, spacing, nesting ("/") and punctuation between the token and
// the actual Gmail label name don't matter.

// educ_label — the follow-up sequence threads we scan (source).
export const EDUC_LABEL_TOKEN = "follow-up-sequence-ed-sector";

// closed_label — where bounced/blocked threads are moved (target).
export const CLOSED_LABEL_TOKEN = "follow-up-sequence-closed";

// responses_label — where threads that got a lead response are moved (target).
export const RESPONSES_LABEL_TOKEN = "@-sales-to-action-outbound-lead-responses";
