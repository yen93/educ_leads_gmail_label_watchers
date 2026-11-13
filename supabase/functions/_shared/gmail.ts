// Thin Gmail REST helpers (all act as the impersonated user "me").
//
// Trimmed from email_drafter_edge_function/_shared/gmail.ts: keeps the gfetch core,
// label listing/resolution and the header parser, and adds the thread search +
// atomic label-move helpers this router needs. No history/watch/draft helpers here
// — this router is scheduled-only and never touches users.watch or drafts.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailHeader {
  name: string;
  value: string;
}

async function gfetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Gmail ${path} -> ${res.status} ${text}`);
    // deno-lint-ignore no-explicit-any
    (err as any).status = res.status;
    throw err;
  }
  return res.json();
}

// Returns de-duplicated {id, threadId} for messages that became relevant since
// startHistoryId, where "relevant" means they carry one of `targetLabelIds` (for the
// lead-response router that's just INBOX — new inbound replies). Reacts to messageAdded
// AND labelAdded. Throws with .status === 404 if startHistoryId is too old (caller
// should clear the baseline and re-seed on the next push).
export async function listHistory(
  token: string,
  startHistoryId: string,
  targetLabelIds: Set<string>,
): Promise<{ id: string; threadId: string }[]> {
  const added: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ startHistoryId });
    qs.append("historyTypes", "messageAdded");
    qs.append("historyTypes", "labelAdded");
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await gfetch(token, `/history?${qs}`);
    for (const h of data.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        const msg = m.message;
        if (msg && (msg.labelIds ?? []).some((l: string) => targetLabelIds.has(l))) {
          added.push({ id: msg.id, threadId: msg.threadId });
        }
      }
      for (const la of h.labelsAdded ?? []) {
        if ((la.labelIds ?? []).some((l: string) => targetLabelIds.has(l)) && la.message) {
          added.push({ id: la.message.id, threadId: la.message.threadId });
        }
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return [...new Map(added.map((m) => [m.id, m])).values()];
}

// List threads matching a Gmail search query (e.g. `label:follow-up-sequence-ed-sector`).
// One page of up to 100; pass the returned nextPageToken to keep paging.
export async function listThreads(
  token: string,
  q: string,
  pageToken?: string,
): Promise<{ threads: { id: string }[]; nextPageToken?: string }> {
  const qs = new URLSearchParams({ q, maxResults: "100" });
  if (pageToken) qs.set("pageToken", pageToken);
  const data = await gfetch(token, `/threads?${qs}`);
  return { threads: data.threads ?? [], nextPageToken: data.nextPageToken };
}

// Fetch a thread. Defaults to `metadata` format with just the headers we inspect,
// which keeps payloads small but still exposes each message's payload.mimeType and
// nested parts[].mimeType (enough to spot DSN / delivery-status parts).
export function getThread(
  token: string,
  id: string,
  format: "metadata" | "full" = "metadata",
  metadataHeaders: string[] = ["From", "To", "Subject", "X-Failed-Recipients"],
) {
  const qs = new URLSearchParams({ format });
  if (format === "metadata") {
    for (const h of metadataHeaders) qs.append("metadataHeaders", h);
  }
  return gfetch(token, `/threads/${id}?${qs}`);
}

// Add and/or remove labels on a whole thread in one atomic modify call.
export const modifyThreadLabels = (
  token: string,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
) =>
  gfetch(token, `/threads/${threadId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });

// List all of the mailbox's labels.
export const listLabels = (token: string) => gfetch(token, `/labels`);

// Separator-insensitive label-name key: lowercase, strip a leading "label:",
// collapse every run of non-alphanumeric (except "@") into a single "-", trim
// leading/trailing "-". So "Follow Up Sequence/Ed Sector" and the token
// "follow-up-sequence-ed-sector" key to the same string.
const labelKey = (s: string) =>
  s.toLowerCase().replace(/^label:/, "").replace(/[^a-z0-9@]+/g, "-").replace(/^-+|-+$/g, "");

// Resolve Gmail `label:` search tokens to the mailbox's actual label IDs. Tokens
// that match no existing label are returned in `missing` (for logging) rather than
// failing — a label that isn't there simply isn't scanned.
export async function resolveLabelIds(
  token: string,
  tokens: string[],
): Promise<{ ids: Record<string, string>; missing: string[] }> {
  const data = await listLabels(token);
  const byKey = new Map<string, string>();
  // deno-lint-ignore no-explicit-any
  for (const l of (data.labels ?? []) as any[]) byKey.set(labelKey(l.name), l.id);
  const ids: Record<string, string> = {};
  const missing: string[] = [];
  for (const t of tokens) {
    const id = byKey.get(labelKey(t));
    if (id) ids[t] = id;
    else missing.push(t);
  }
  return { ids, missing };
}

// Resolve a user label id by name, creating the label only if truly absent.
// Matching uses the same separator-insensitive normalization, so an existing label
// under a different case/spacing/nesting is reused. Creation is guarded: Gmail 409s
// on a conflicting name, so on 409 we re-list and match rather than fail.
export async function getOrCreateLabelId(token: string, name: string): Promise<string> {
  const want = labelKey(name);
  const find = async (): Promise<string | undefined> => {
    const data = await gfetch(token, `/labels`);
    // deno-lint-ignore no-explicit-any
    return (data.labels ?? []).find((l: any) => labelKey(l.name) === want)?.id;
  };

  const existing = await find();
  if (existing) return existing;

  try {
    const created = await gfetch(token, `/labels`, {
      method: "POST",
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
    return created.id;
  } catch (e) {
    // deno-lint-ignore no-explicit-any
    if ((e as any).status === 409) {
      const again = await find();
      if (again) return again;
    }
    throw e;
  }
}

// deno-lint-ignore no-explicit-any
export function header(msg: any, name: string): string {
  const h = (msg.payload?.headers ?? []).find(
    (x: GmailHeader) => x.name.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? "";
}

// True if any part of the message's MIME tree has one of the given mime types.
// deno-lint-ignore no-explicit-any
export function hasMimeType(msg: any, types: string[]): boolean {
  // deno-lint-ignore no-explicit-any
  const walk = (p: any): boolean => {
    if (!p) return false;
    if (p.mimeType && types.includes(p.mimeType.toLowerCase())) return true;
    for (const c of p.parts ?? []) if (walk(c)) return true;
    return false;
  };
  return walk(msg.payload);
}
