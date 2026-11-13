// educ-bounced-threads-router — main_task 1: bounced_threads_router.
//
// A DAILY (06:00 PH) router over james@'s mailbox. It scans every thread still in
// the education-sector follow-up sequence (label:follow-up-sequence-ed-sector) and,
// for any bounced/blocked thread:
//   1. MOVES it into follow-up-sequence-closed (add closed label + remove ed-sector
//      label, in one atomic threads.modify) so it stops being chased; and
//   2. sets status = '10A' on the matching lead row(s) in
//      public.manually_found_educ_leads, matched by the lead's EMAIL address
//      (the failed recipient — from the DSN's X-Failed-Recipients and the outbound
//      "To"; the stored thread_id is the outbound thread, which differs from the
//      bounce thread, so email is the reliable key).
//
// Scheduled-only: NO Gmail users.watch, NO Pub/Sub. It cannot disturb the live
// draft-james-reply push pipeline on the same mailbox.
//
// Optional ?thread=<threadId> processes just that one thread (used for backfill /
// manual reprocessing); otherwise it does the full ed-sector scan.
//
// Auth of the request: a shared secret in the URL query (?token=...) that must equal
// PUSH_SHARED_SECRET (reused from the drafter project). Deploy with verify_jwt=false.

import { getGmailAccessToken } from "../_shared/google-auth.ts";
import {
  getOrCreateLabelId,
  getThread,
  hasMimeType,
  header,
  listThreads,
  modifyThreadLabels,
  resolveLabelIds,
} from "../_shared/gmail.ts";
import { CLOSED_LABEL_TOKEN, EDUC_LABEL_TOKEN } from "../_shared/labels.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Safety cap: at most this many threads scanned per full run (paged). Logged if hit.
const MAX_THREADS = 1000;

// Status set on a lead whose outbound bounced/was blocked.
const BOUNCED_LEAD_STATUS = "10A";

// Bounce/block detection — DSN + mailer-daemon signals (see plan).
const DAEMON_FROM = /mailer-daemon|postmaster/i;
const BOUNCE_SUBJECT =
  /delivery status notification|undeliverable|mail delivery (failed|subsystem)|address not found|failure notice|returned mail|delivery incomplete|could ?n.?t be delivered|can.?t be delivered|message blocked/i;
const DSN_MIME_TYPES = ["multipart/report", "message/delivery-status"];

// Our own domain — never treat these as "the lead" when pulling recipient emails.
const INTERNAL_DOMAIN = "@myadventuregroup.com.au";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// deno-lint-ignore no-explicit-any
function threadIsBounced(thread: any): boolean {
  for (const msg of thread.messages ?? []) {
    const from = header(msg, "From");
    if (DAEMON_FROM.test(from)) return true;
    if (BOUNCE_SUBJECT.test(header(msg, "Subject"))) return true;
    if (header(msg, "X-Failed-Recipients")) return true;
    if (hasMimeType(msg, DSN_MIME_TYPES)) return true;
  }
  return false;
}

// Pull the bare email out of a header fragment like `"Jane Doe" <jane@x.edu>`.
function extractEmail(fragment: string): string | null {
  if (!fragment) return null;
  const angled = fragment.match(/<([^>]+)>/);
  const raw = (angled ? angled[1] : fragment).trim();
  const m = raw.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// The lead email(s) a bounced thread is about: the failed recipients from the DSN
// (X-Failed-Recipients) plus the "To" of the outbound (non-daemon) messages.
// Internal (our own) addresses are dropped.
// deno-lint-ignore no-explicit-any
function leadEmails(thread: any): string[] {
  const out = new Set<string>();
  for (const msg of thread.messages ?? []) {
    const from = header(msg, "From");
    for (const part of header(msg, "X-Failed-Recipients").split(",")) {
      const e = extractEmail(part);
      if (e) out.add(e);
    }
    if (!DAEMON_FROM.test(from)) {
      for (const part of header(msg, "To").split(",")) {
        const e = extractEmail(part);
        if (e) out.add(e);
      }
    }
  }
  return [...out].filter((e) => !e.endsWith(INTERNAL_DOMAIN));
}

// Process one thread: if bounced, move it to closed and mark its lead(s) 10A.
// deno-lint-ignore no-explicit-any
async function processThread(
  token: string,
  id: string,
  edId: string,
  closedId: string,
  // deno-lint-ignore no-explicit-any
  summary: any,
  // deno-lint-ignore no-explicit-any
  moved: any[],
): Promise<void> {
  const thread = await getThread(token, id); // metadata format
  if (!threadIsBounced(thread)) return;
  summary.bounced++;

  // Move: add closed, remove ed-sector (atomic). Idempotent if already moved.
  await modifyThreadLabels(token, id, [closedId], [edId]);
  summary.moved++;

  // Mark the matching lead(s) 10A, by email.
  const emails = leadEmails(thread);
  let leadsUpdated = 0;
  if (emails.length) {
    const { data, error } = await sb
      .from("manually_found_educ_leads")
      .update({ status: BOUNCED_LEAD_STATUS })
      .in("email", emails)
      .select("id");
    if (error) throw error; // treated as a per-thread error (self-heals next run)
    leadsUpdated = data?.length ?? 0;
    summary.leadsUpdated += leadsUpdated;
  }

  // deno-lint-ignore no-explicit-any
  const first = (thread.messages ?? [])[0] as any;
  moved.push({
    threadId: id,
    subject: first ? header(first, "Subject") : "",
    emails,
    leadsUpdated,
  });
}

Deno.serve(async (req) => {
  // --- authenticate ---------------------------------------------------------
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== Deno.env.get("PUSH_SHARED_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const singleThread = url.searchParams.get("thread"); // optional backfill mode

  const summary = { scanned: 0, bounced: 0, moved: 0, leadsUpdated: 0, errors: 0, capped: false };
  // deno-lint-ignore no-explicit-any
  const movedThreads: any[] = [];

  try {
    const token = await getGmailAccessToken();

    // --- resolve labels ----------------------------------------------------
    const { ids, missing } = await resolveLabelIds(token, [EDUC_LABEL_TOKEN, CLOSED_LABEL_TOKEN]);
    const edId = ids[EDUC_LABEL_TOKEN];
    // Target label: resolved, or created if it doesn't exist yet.
    const closedId = ids[CLOSED_LABEL_TOKEN] ?? (await getOrCreateLabelId(token, CLOSED_LABEL_TOKEN));

    // --- single-thread backfill mode ---------------------------------------
    if (singleThread) {
      summary.scanned++;
      try {
        await processThread(token, singleThread, edId ?? "", closedId, summary, movedThreads);
      } catch (perThread) {
        summary.errors++;
        console.error(`single-thread process failed for ${singleThread}:`, perThread);
      }
      await logRun(summary, { mode: "single", thread: singleThread, moved: movedThreads });
      return json(summary);
    }

    // --- full ed-sector scan -----------------------------------------------
    if (!edId) {
      console.warn("ed-sector label not found; nothing to do:", missing);
      await logRun(summary, { note: "ed-sector label missing", missing });
      return json({ ...summary, note: "ed-sector label missing" });
    }

    let pageToken: string | undefined;
    outer:
    do {
      const { threads, nextPageToken } = await listThreads(
        token,
        `label:${EDUC_LABEL_TOKEN}`,
        pageToken,
      );
      pageToken = nextPageToken;

      for (const { id } of threads) {
        if (summary.scanned >= MAX_THREADS) {
          summary.capped = true;
          break outer;
        }
        summary.scanned++;
        try {
          await processThread(token, id, edId, closedId, summary, movedThreads);
        } catch (perThread) {
          summary.errors++;
          console.error(`process failed for thread ${id}:`, perThread);
          // Not re-thrown: the thread still carries the ed label, so it's retried
          // on the next daily run.
        }
      }
    } while (pageToken);

    await logRun(summary, { moved: movedThreads });
    console.log("bounced-threads-router run:", JSON.stringify(summary));
    return json(summary);
  } catch (e) {
    summary.errors++;
    console.error("handler error:", e);
    await logRun(summary, { error: String(e) }).catch(() => {});
    return json({ ...summary, error: String(e) }, 500);
  }
});

// deno-lint-ignore no-explicit-any
function logRun(summary: any, detail: unknown) {
  return sb.from("educ_router_runs").insert({
    router: "bounced-threads-router",
    scanned: summary.scanned,
    bounced: summary.bounced,
    moved: summary.moved,
    leads_updated: summary.leadsUpdated,
    errors: summary.errors,
    detail,
  });
}

// deno-lint-ignore no-explicit-any
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
