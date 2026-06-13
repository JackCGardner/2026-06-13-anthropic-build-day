// The zendesk kernel: the support inbox, faithful down to a real quirk. It lists
// tickets, gets a ticket, and updates a ticket through its status lifecycle. It
// holds no money policy. The load-bearing fidelity detail: there is no
// create-comment endpoint. A comment is added by putting a `comment` object on
// the ticket UPDATE; the comment's `public` flag inherits the ticket's prior
// public state unless explicitly set. Reproducing this shape forces the harness
// to exercise the same code path it would against the real API.

import type { EgressRequest, ToolResponse } from "../contracts/index.js";
import {
  ScopedStore,
  errorResponse,
  jsonResponse,
  lastPathSegment,
  parseBody,
} from "./shared.js";

const TICKETS_LIST_PATH = /^\/api\/v2\/tickets\/?$/;
const TICKET_BY_ID_PATH = /^\/api\/v2\/tickets\/[^/]+\/?$/;

const TICKET_STATUSES = new Set([
  "new",
  "open",
  "pending",
  "hold",
  "solved",
  "closed",
]);

export function zendeskKernel(
  req: EgressRequest,
  store: ScopedStore,
): ToolResponse {
  if (req.method === "GET" && TICKETS_LIST_PATH.test(req.path)) {
    return listTickets(store);
  }
  if (req.method === "GET" && TICKET_BY_ID_PATH.test(req.path)) {
    return getTicket(req, store);
  }
  if (req.method === "PUT" && TICKET_BY_ID_PATH.test(req.path)) {
    return updateTicket(req, store);
  }
  return errorResponse(404, "RecordNotFound", `No route for ${req.method} ${req.path}.`);
}

function listTickets(store: ScopedStore): ToolResponse {
  // Tickets are seeded as "ticket:<id>" records; list returns the open ones in
  // a stable, id-sorted order so the response is deterministic.
  const tickets = collectTickets(store);
  return jsonResponse(200, { tickets, count: tickets.length }, []);
}

function getTicket(req: EgressRequest, store: ScopedStore): ToolResponse {
  const id = lastPathSegment(req.path);
  const ticket = store.get(`ticket:${id}`);
  if (ticket === undefined) {
    return errorResponse(404, "RecordNotFound", `Ticket '${id}' not found.`);
  }
  return jsonResponse(200, { ticket: { id, ...ticket } }, []);
}

// PUT /api/v2/tickets/{id}. Updates status and, via the comment-on-update quirk,
// appends a comment. There is deliberately no separate comment endpoint.
function updateTicket(req: EgressRequest, store: ScopedStore): ToolResponse {
  const id = lastPathSegment(req.path);
  const existing = store.get(`ticket:${id}`);
  if (existing === undefined) {
    return errorResponse(404, "RecordNotFound", `Ticket '${id}' not found.`);
  }

  const update = extractTicketUpdate(req.body);

  const nextStatus =
    update.status ?? (stringField(existing, "status") || "open");
  if (!TICKET_STATUSES.has(nextStatus)) {
    return errorResponse(
      422,
      "RecordInvalid",
      `Status: '${nextStatus}' is not a valid status.`,
    );
  }

  // The comment thread is an array on the ticket record. A comment supplied on
  // the update is appended here; the `public` flag inherits the ticket's prior
  // public flag unless the caller set it explicitly.
  const priorComments = arrayField(existing, "comments");
  const priorPublic = boolFieldDefault(existing, "public", true);
  let comments = priorComments;
  let nextPublic = priorPublic;
  if (update.comment !== undefined) {
    const isPublic = update.comment.public ?? priorPublic;
    nextPublic = isPublic;
    const commentId = store.nextId("comment");
    comments = [
      ...priorComments,
      {
        id: commentId,
        body: update.comment.body,
        public: isPublic,
      },
    ];
  }

  const updated: Record<string, unknown> = {
    ...existing,
    status: nextStatus,
    public: nextPublic,
    comments,
  };
  store.set(`ticket:${id}`, updated, `ticket ${id} updated to ${nextStatus}`);

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { ticket: { id, ...updated } },
    state_mutations: store.drainMutations(),
  };
}

// Collect seeded ticket records into a deterministic, id-sorted list.
function collectTickets(store: ScopedStore): Array<Record<string, unknown>> {
  // ScopedStore exposes individual reads; tickets are addressed by id elsewhere,
  // so the seed convention places ticket ids under "ticket:index" for listing.
  const index = store.get("ticket:index");
  const ids =
    index !== undefined && Array.isArray(index["ids"])
      ? (index["ids"] as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : [];
  const tickets: Array<Record<string, unknown>> = [];
  for (const id of [...ids].sort()) {
    const ticket = store.get(`ticket:${id}`);
    if (ticket !== undefined) tickets.push({ id, ...ticket });
  }
  return tickets;
}

// Pull the status and optional comment out of the PUT body. The Zendesk shape
// nests these under a top-level `ticket` object.
function extractTicketUpdate(body: unknown): {
  status?: string;
  comment?: { body: string; public?: boolean };
} {
  const root =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : parseBody(body);
  const ticket =
    root["ticket"] !== null && typeof root["ticket"] === "object"
      ? (root["ticket"] as Record<string, unknown>)
      : root;

  const out: { status?: string; comment?: { body: string; public?: boolean } } =
    {};
  if (typeof ticket["status"] === "string") out.status = ticket["status"];
  const comment = ticket["comment"];
  if (comment !== null && typeof comment === "object") {
    const c = comment as Record<string, unknown>;
    const cbody = typeof c["body"] === "string" ? c["body"] : "";
    const cpublic = typeof c["public"] === "boolean" ? c["public"] : undefined;
    out.comment = cpublic === undefined
      ? { body: cbody }
      : { body: cbody, public: cpublic };
  }
  return out;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const v = record[key];
  return typeof v === "string" ? v : "";
}

function boolFieldDefault(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const v = record[key];
  return typeof v === "boolean" ? v : fallback;
}

function arrayField(
  record: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const v = record[key];
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is Record<string, unknown> =>
      x !== null && typeof x === "object" && !Array.isArray(x),
  );
}
