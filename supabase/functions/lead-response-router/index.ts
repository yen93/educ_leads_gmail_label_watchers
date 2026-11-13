// lead-response-router — main_task 2: lead_response_router.
//
// PUSH-based router over james@'s mailbox. When a lead REPLIES to an education-sector
// follow-up (a thread carrying label:follow-up-sequence-ed-sector), this routes that
// thread to the responses label (@ sales to action/outbound lead responses) — i.e. it
// adds the responses label and removes the ed-sector label, so the sequence stops
// chasing and sales picks it up — and sets status = '8A' on the matching lead row(s)
// in public.manually_found_educ_leads (matched by the responder's EMAIL address).
//
// "Just like gmail_drafter" push: Gmail only allows ONE users.watch per mailbox, and
// the drafter already owns it (INBOX + its action labels -> Pub/Sub topic
// projects/n8nautomations-498202/topics/gmail-inbound). So this function does NOT arm
// its own watch; it receives the SAME notifications via a SECOND push subscription on
// that topic. INBOX is already watched, and lead replies land in INBOX, so they push.
// It keeps its OWN processing baseline (public.educ_watch_state) so it never fights the
// drafter's baseline.
//
// Optional ?thread=<threadId> processes just that one thread (test / backfill), skipping
// the Pub/Sub + history path.
//
// Auth of the push request: a shared secret in the URL query (?token=...) that must
// equal PUSH_SHARED_SECRET. Deploy with verify_jwt = false.

import { getGmailAccessToken } from "../_shared/google-auth.ts";
import {
  getOrCreateLabelId,
  getThread,
  header,
  listHistory,
  modifyThreadLabels,
  resolveLabelIds,
} from "../_shared/gmail.ts";
import { EDUC_LABEL_TOKEN, RESPONSES_LABEL_TOKEN } from "../_shared/labels.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Status set on a lead who responded to the outbound follow-up.
const RESPONDED_LEAD_STATUS = "8A";

const INTERNAL_DOMAIN = "@myadventuregroup.com.au";
const DAEMON_FROM = /mailer-daemon|postmaster/i;
const NOREPLY_FROM = /no-?reply|do-?not-?reply/i;

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Pull the bare email out of a header fragment like `"Jane Doe" <jane@x.edu>`.
function extractEmail(fragment: string): string | null {
  if (!fragment) return null;
  const angled = fragment.match(/<([^>]+)>/);
  const raw = (angled ? angled[1] : fragment).trim();
  const m = raw.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// Is this message an inbound reply from the lead (not our own send, not a bounce,
// not an internal colleague, not a no-reply auto-sender)?
// deno-lint-ignore no-explicit-any
function isInboundReply(msg: any, mailbox: string): boolean {
  const labels: string[] = msg.labelIds ?? [];
  if (labels.includes("SENT") || labels.includes("DRAFT")) return false;
  const from = header(msg, "From");
  if (!from) return false;
  if (DAEMON_FROM.test(from)) return false;       // a bounce (task 1's job), not a reply
  if (NOREPLY_FROM.test(from)) return false;
  const fromLc = from.toLowerCase();
  if (fromLc.includes(mailbox.toLowerCase())) return false; // our own message
  if (fromLc.includes(INTERNAL_DOMAIN)) return false;       // internal colleague
  return true;
}

// deno-lint-ignore no-explicit-any
const threadHasLabel = (thread: any, labelId: string): boolean =>
  (thread.messages ?? []).some((m: any) => (m.labelIds ?? []).includes(labelId));

// The lead email(s) to mark 8A: the From of the inbound reply message(s) plus the "To"
// of our own outbound message(s) in the thread. Internal/self addresses dropped.
// deno-lint-ignore no-explicit-any
function leadEmails(thread: any, mailbox: string): string[] {
  const out = new Set<string>();
  for (const msg of thread.messages ?? []) {
    const from = header(msg, "From");
    const fromLc = from.toLowerCase();
    const isOurs = fromLc.includes(mailbox.toLowerCase()) || (msg.labelIds ?? []).includes("SENT");
    if (isOurs) {
      for (const part of header(msg, "To").split(",")) {
        const e = extractEmail(part);
        if (e) out.add(e);
      }
    } else if (isInboundReply(msg, mailbox)) {
      const e = extractEmail(from);
      if (e) out.add(e);
    }
  }
  return [...out].filter((e) => !e.endsWith(INTERNAL_DOMAIN));
}

// Route a thread that got a lead response: move ed-sector -> responses, set leads 8A.
// Returns the number of lead rows updated, or -1 if the thread didn't qualify.
// deno-lint-ignore no-explicit-any
async function routeThread(
  token: string,
  threadId: string,
  edId: string,
  responsesId: string,
  mailbox: string,
  // deno-lint-ignore no-explicit-any
  routed: any[],
): Promise<number> {
  const thread = await getThread(token, threadId); // metadata (headers + labelIds)
  if (!threadHasLabel(thread, edId)) return -1;    // not an ed-sector sequence thread
  // deno-lint-ignore no-explicit-any
  if (!(thread.messages ?? []).some((m: any) => isInboundReply(m, mailbox))) return -1;

  // Move: add responses, remove ed-sector (atomic). Idempotent if already moved.
  await modifyThreadLabels(token, threadId, [responsesId], [edId]);

  const emails = leadEmails(thread, mailbox);
  let leadsUpdated = 0;
  if (emails.length) {
    const { data, error } = await sb
      .from("manually_found_educ_leads")
      .update({ status: RESPONDED_LEAD_STATUS })
      .in("email", emails)
      .select("id");
    if (error) throw error;
    leadsUpdated = data?.length ?? 0;
  }

  // deno-lint-ignore no-explicit-any
  const last = (thread.messages ?? []).slice(-1)[0] as any;
  routed.push({ threadId, subject: last ? header(last, "Subject") : "", emails, leadsUpdated });
  return leadsUpdated;
}

// deno-lint-ignore no-explicit-any
function logRun(summary: any, detail: unknown) {
  return sb.from("educ_router_runs").insert({
    router: "lead-response-router",
    scanned: summary.scanned,
    bounced: 0,
    moved: summary.routed,
    leads_updated: summary.leadsUpdated,
    errors: summary.errors,
    detail,
  });
}

// deno-lint-ignore no-explicit-any
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  // --- authenticate ---------------------------------------------------------
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== Deno.env.get("PUSH_SHARED_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  const summary = { scanned: 0, routed: 0, leadsUpdated: 0, errors: 0 };
  // deno-lint-ignore no-explicit-any
  const routedThreads: any[] = [];
  const singleThread = url.searchParams.get("thread"); // optional test/backfill mode

  // --- single-thread mode ---------------------------------------------------
  if (singleThread) {
    const mailbox = Deno.env.get("GMAIL_IMPERSONATE_USER") ?? "";
    try {
      const token = await getGmailAccessToken();
      const { ids } = await resolveLabelIds(token, [EDUC_LABEL_TOKEN, RESPONSES_LABEL_TOKEN]);
      const edId = ids[EDUC_LABEL_TOKEN];
      const responsesId = ids[RESPONSES_LABEL_TOKEN] ?? (await getOrCreateLabelId(token, RESPONSES_LABEL_TOKEN));
      summary.scanned++;
      if (edId) {
        const r = await routeThread(token, singleThread, edId, responsesId, mailbox, routedThreads);
        if (r >= 0) {
          summary.routed++;
          summary.leadsUpdated += r;
        }
      }
      await logRun(summary, { mode: "single", thread: singleThread, routed: routedThreads });
      return json(summary);
    } catch (e) {
      summary.errors++;
      console.error("single-thread error:", e);
      await logRun(summary, { mode: "single", thread: singleThread, error: String(e) }).catch(() => {});
      return json({ ...summary, error: String(e) }, 500);
    }
  }

  // --- decode the Pub/Sub envelope -----------------------------------------
  // deno-lint-ignore no-explicit-any
  let envelope: any;
  try {
    envelope = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const dataB64 = envelope?.message?.data;
  if (!dataB64) return new Response("no data", { status: 204 });

  let notif: { emailAddress: string; historyId: string | number };
  try {
    notif = JSON.parse(atob(dataB64));
  } catch {
    return new Response("bad data", { status: 204 });
  }
  const mailbox = notif.emailAddress;
  const notifHistoryId = String(notif.historyId);

  try {
    const token = await getGmailAccessToken();

    // --- processing baseline (self-seeds on first push) --------------------
    const { data: state } = await sb
      .from("educ_watch_state")
      .select("last_history_id")
      .eq("email_address", mailbox)
      .maybeSingle();

    if (!state?.last_history_id) {
      await sb.from("educ_watch_state").upsert({
        email_address: mailbox,
        last_history_id: notifHistoryId,
        updated_at: new Date().toISOString(),
      });
      return new Response("seeded baseline", { status: 200 });
    }

    // --- labels ------------------------------------------------------------
    const { ids } = await resolveLabelIds(token, [EDUC_LABEL_TOKEN, RESPONSES_LABEL_TOKEN]);
    const edId = ids[EDUC_LABEL_TOKEN];
    const responsesId = ids[RESPONSES_LABEL_TOKEN] ?? (await getOrCreateLabelId(token, RESPONSES_LABEL_TOKEN));

    if (edId) {
      // --- what changed: new INBOX messages (inbound replies) --------------
      let added: { id: string; threadId: string }[];
      try {
        added = await listHistory(token, String(state.last_history_id), new Set(["INBOX"]));
      } catch (e) {
        // deno-lint-ignore no-explicit-any
        if ((e as any).status === 404) {
          await sb.from("educ_watch_state").update({ last_history_id: null }).eq("email_address", mailbox);
          return new Response("history expired; re-seed needed", { status: 200 });
        }
        throw e;
      }

      const routedThreadIds = new Set<string>();
      for (const { id, threadId } of added) {
        // Idempotency lock per message.
        const { error: lockErr } = await sb
          .from("educ_processed_messages")
          .insert({ message_id: id, thread_id: threadId });
        if (lockErr) continue; // already processed

        summary.scanned++;
        try {
          if (routedThreadIds.has(threadId)) {
            await sb.from("educ_processed_messages").update({ action: "skip" }).eq("message_id", id);
            continue;
          }
          // Load the thread; confirm THIS message is an inbound reply before routing.
          const thread = await getThread(token, threadId);
          // deno-lint-ignore no-explicit-any
          const msg = (thread.messages ?? []).find((m: any) => m.id === id);
          if (!msg || !isInboundReply(msg, mailbox)) {
            await sb.from("educ_processed_messages").update({ action: "skip" }).eq("message_id", id);
            continue;
          }
          const r = await routeThread(token, threadId, edId, responsesId, mailbox, routedThreads);
          if (r >= 0) {
            routedThreadIds.add(threadId);
            summary.routed++;
            summary.leadsUpdated += r;
            await sb.from("educ_processed_messages").update({ action: "responded" }).eq("message_id", id);
          } else {
            await sb.from("educ_processed_messages").update({ action: "skip" }).eq("message_id", id);
          }
        } catch (perMsg) {
          summary.errors++;
          // Release the lock so this message is retried on the next delivery.
          await sb.from("educ_processed_messages").delete().eq("message_id", id);
          console.error(`route failed for message ${id}:`, perMsg);
        }
      }
    }

    // Advance the baseline after a clean pass.
    await sb.from("educ_watch_state").upsert({
      email_address: mailbox,
      last_history_id: notifHistoryId,
      updated_at: new Date().toISOString(),
    });

    if (summary.routed > 0 || summary.errors > 0) {
      await logRun(summary, { moved: routedThreads }).catch(() => {});
    }
    return json(summary);
  } catch (e) {
    console.error("handler error:", e);
    // 500 -> Pub/Sub retries; the ledger prevents duplicate routing.
    return json({ ...summary, error: String(e) }, 500);
  }
});
