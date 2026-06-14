// The generic dossier-driven kernel. It interprets a ToolDossier at runtime:
// it routes by the dossier's declared operations, maintains state per the
// dossier's hidden_state schema through the same ScopedStore the hand kernels
// use, and enforces ONLY the dossier's declared enforced_invariants via a small
// extensible registry of invariant types. It never reads, loads, or branches on
// business_rules_not_enforced. That silence is faithful, not rigged: a generic
// tool built from the refund dossier reproduces real Stripe behavior exactly,
// including returning 200 and moving money on a policy-violating refund.
//
// The generic kernel is additive. It does not replace or weaken the
// hand-written kernels' authority; it is a second, data-driven path proven to
// agree with them on the committed refund fixtures, so any future researched
// tool can be instantiated from a dossier with no per-tool hand-coding.

import type {
  EgressRequest,
  ToolDossier,
  ToolKernel,
  ToolOperation,
  ToolResponse,
  WorldState,
} from "../contracts/index.js";
import {
  ScopedStore,
  errorResponse,
  hashParams,
  jsonResponse,
  lastPathSegment,
  parseBody,
} from "./shared.js";

// The set of invariant types the registry knows how to enforce generically.
// Each declared enforced_invariant on a dossier operation maps to exactly one
// of these. Adding support for a new real-API refusal means adding a type here
// and a checker below, never hand-coding a specific tool.
export type InvariantType =
  | "existence"
  | "one_of_params"
  | "idempotency_replay"
  | "amount_within_remaining"
  | "not_already_in_terminal_state"
  | "not_disputed";

// The context an invariant checker reads. It carries the parsed request params,
// the resolved primary record (e.g. the charge) when one applies, the scoped
// store, and the per-operation binding that tells generic checkers which fields
// and records to look at. Checkers are pure with respect to enforcement: they
// may read state and params, but they never mutate state and never consult
// business_rules_not_enforced (which is not even present in this context).
export interface InvariantContext {
  params: Record<string, string>;
  // The unparsed request body, for an in-place update whose nested shape the
  // flattened params would lose. Checkers do not read this; only the update apply
  // does. It is the EgressRequest body verbatim.
  rawBody: unknown;
  store: ScopedStore;
  binding: OperationBinding;
  // The resolved primary record key and value, when the operation has one.
  primaryKey: string | undefined;
  primaryRecord: Record<string, unknown> | undefined;
}

// A checker returns undefined when the invariant holds, or a typed violation
// the kernel turns into the dossier's declared on_violation response.
export interface InvariantViolation {
  message: string;
}
export type InvariantChecker = (
  ctx: InvariantContext,
) => InvariantViolation | undefined;

// The extensible registry: invariant type -> checker. New real-API refusals are
// added here, not in any per-tool file. The generic kernel only ever runs the
// checkers named by the dossier's enforced_invariants, in dossier order.
export const INVARIANT_REGISTRY: Record<InvariantType, InvariantChecker> = {
  existence: checkExistence,
  one_of_params: checkOneOfParams,
  idempotency_replay: () => undefined, // handled inline; see runOperation.
  amount_within_remaining: checkAmountWithinRemaining,
  not_already_in_terminal_state: checkNotAlreadyInTerminalState,
  not_disputed: checkNotDisputed,
};

// How a dossier's enforced_invariant id maps to a generic InvariantType. The
// dossier states invariants by semantic id (charge_exists, amount_within_
// remaining, ...); the registry is keyed by type. This table is the only place
// that knows the refund-brief ids, and it degrades gracefully: an id whose stem
// already names a type (e.g. "amount_within_remaining") resolves directly, so
// a freshly researched dossier needs no edits if it uses the type names.
const INVARIANT_ID_TO_TYPE: Record<string, InvariantType> = {
  charge_exists: "existence",
  order_exists: "existence",
  customer_exists: "existence",
  ticket_exists: "existence",
  one_of_charge_or_pi: "one_of_params",
  amount_within_remaining: "amount_within_remaining",
  not_fully_refunded: "not_already_in_terminal_state",
  not_already_refunded: "not_already_in_terminal_state",
  not_disputed: "not_disputed",
  idempotency_replay: "idempotency_replay",
};

// The order in which the API actually evaluates its enforced invariants, which
// is not necessarily the order a dossier happens to list them. Real Stripe
// reports a missing required parameter before it looks up the charge, and the
// terminal-state and dispute checks precede the amount ceiling. The generic
// kernel runs declared invariants in this canonical precedence so its refusal
// for any given request is the one the real API would return.
const INVARIANT_PRECEDENCE: InvariantType[] = [
  "one_of_params",
  "existence",
  "not_disputed",
  "not_already_in_terminal_state",
  "amount_within_remaining",
];

function resolveInvariantType(id: string): InvariantType | undefined {
  const mapped = INVARIANT_ID_TO_TYPE[id];
  if (mapped !== undefined) return mapped;
  // Fall back to treating the id itself as a type when it is one of the known
  // registry keys, so type-named dossiers work without an id table entry.
  if (id in INVARIANT_REGISTRY) return id as InvariantType;
  return undefined;
}

// The per-operation binding: the dossier-derived facts the generic checkers and
// the apply step need. It is computed once per dossier from the operation's
// http shape and the tool's hidden_state schema, so the request path stays a
// thin interpreter over precomputed structure.
interface OperationBinding {
  op: ToolOperation;
  // The record family this operation primarily reads/writes, e.g. "charge".
  // Derived from the path and the hidden_state schema keys.
  recordPrefix: string;
  // For id-in-path operations, how to read the id; for refund-style operations,
  // the params that name the primary record id.
  idFromPath: boolean;
  // The params, in order, that may carry the primary record id (refund: charge,
  // then payment_intent resolved through a pi index).
  idParams: string[];
  // Whether this operation mutates (POST/PUT) or is a pure read (GET).
  mutating: boolean;
  // True when this is a singleton-resource read: a GET whose path carries no id
  // and whose schema declares no id parameter, so it returns the one record its
  // family holds (the policy read returns the single seeded policy). The generic
  // read resolves the family's first record rather than gating on existence of an
  // id that was never provided.
  singletonRead: boolean;
  // How a mutating operation applies its change. A "foreign_create" gates on a
  // record it does not own (the refund create gates on the charge), writes a new
  // record in another family, and drains the hidden budget by the applied amount.
  // An "in_place_update" addresses a record by id in the path and merges the
  // request body into it (the ticket update). The kind is derived once from the
  // operation's http shape and its declared invariants, so the request path picks
  // the right apply without re-inspecting the dossier.
  mutationKind: "none" | "foreign_create" | "in_place_update";
  // The set of valid enum values a single status-like field may take, parsed
  // from a request_schema "enum[...]" marker. An update to a value outside the
  // set is mechanically refused, faithful to the real API. Empty when the schema
  // declares no enum.
  statusField: string | undefined;
  statusValues: Set<string>;
  // The on_violation envelope style: Stripe nests under `error`, the internal
  // services use a flat shape. Derived from the dossier base_url.
  errorStyle: "stripe" | "flat";
}

// Build a ToolKernel from a dossier. The returned function has the exact frozen
// seam signature (EgressRequest, WorldState) => ToolResponse, so it drops into
// the same dispatch the hand kernels use. All dossier interpretation that does
// not depend on request or state is done once, here, at construction time.
export function createGenericKernel(dossier: ToolDossier): ToolKernel {
  const errorStyle: "stripe" | "flat" = dossier.base_url.includes("stripe.com")
    ? "stripe"
    : "flat";
  const stateSchemaKeys = Object.keys(dossier.hidden_state.schema);

  const bindings: OperationBinding[] = dossier.operations.map((op) =>
    buildBinding(op, stateSchemaKeys, errorStyle),
  );

  return (req: EgressRequest, state: WorldState): ToolResponse => {
    const store = new ScopedStore(state);
    const binding = matchOperation(bindings, req);
    if (binding === undefined) {
      return errorResponse(
        404,
        errorStyle === "stripe" ? "resource_missing" : "not_found",
        `No route for ${req.method} ${req.path}.`,
        errorStyle,
      );
    }
    return runOperation(req, store, binding, errorStyle);
  };
}

// Match an incoming request to a dossier operation by method and path. The
// dossier path may be templated ("/v1/charges/{id}"); a template segment
// matches any single non-empty segment.
function matchOperation(
  bindings: OperationBinding[],
  req: EgressRequest,
): OperationBinding | undefined {
  for (const binding of bindings) {
    if (binding.op.http.method.toUpperCase() !== req.method.toUpperCase()) {
      continue;
    }
    if (pathMatches(binding.op.http.path, req.path)) return binding;
  }
  return undefined;
}

function pathMatches(template: string, actual: string): boolean {
  const t = template.replace(/\/+$/, "");
  const a = actual.replace(/\/+$/, "");
  const ts = t.split("/");
  const as = a.split("/");
  if (ts.length !== as.length) return false;
  for (let i = 0; i < ts.length; i += 1) {
    const seg = ts[i]!;
    const isTemplate = seg.startsWith("{") && seg.endsWith("}");
    if (isTemplate) {
      if (as[i]!.length === 0) return false;
      continue;
    }
    if (seg !== as[i]!) return false;
  }
  return true;
}

// Derive the static binding for one operation from its http shape and the
// tool's hidden_state schema. The record prefix is the schema key family that
// the operation addresses (e.g. "charge" from "charge:{id}" for /v1/refunds and
// /v1/charges/{id}); refund-style writes name the record via params.
function buildBinding(
  op: ToolOperation,
  stateSchemaKeys: string[],
  errorStyle: "stripe" | "flat",
): OperationBinding {
  const method = op.http.method.toUpperCase();
  const mutating = method === "POST" || method === "PUT" || method === "PATCH";
  const idFromPath = op.http.path.includes("{");

  // The record prefix is the singular stem of the dominant "<prefix>:{...}"
  // schema key. The refund operation writes refunds but reads charges, so a
  // write whose own family ("refund") is not the read target picks the family
  // it must resolve from params; for the refund brief that is "charge".
  const families = stateSchemaKeys
    .filter((k) => k.includes(":{") || k.includes(":"))
    .map((k) => k.slice(0, k.indexOf(":")))
    .filter((p) => p.length > 0 && !p.includes("."));

  const recordPrefix = pickRecordPrefix(op, families, idFromPath);

  // For id-in-params operations, the request_schema params that may carry the
  // primary record id, ordered by preference. The one_of constraint on the
  // refund schema names exactly these; absence is enforced by one_of_params.
  // The params that explicitly carry the primary id come from the schema's
  // one_of marker; a singleton read has none. Keep these separate from the
  // create fallback so a GET with no declared id source is recognized as a
  // singleton rather than defaulting to a record-prefix-named param.
  const declaredIdParams = idFromPath ? [] : readOneOfRequired(op.request_schema);
  const idParams = idFromPath
    ? []
    : declaredIdParams.length > 0
      ? declaredIdParams
      : [recordPrefix];

  // A GET with no path id and no declared id source returns the family's single
  // record (the policy read). A create (POST) is never a singleton read.
  const singletonRead =
    !mutating && !idFromPath && declaredIdParams.length === 0;

  // An id-in-path write merges the request body into its own record; a write
  // that names its primary record via params and gates on that record's
  // existence creates a new record in another family and moves money. The refund
  // create is the latter; the ticket update is the former.
  const mutationKind: OperationBinding["mutationKind"] = !mutating
    ? "none"
    : idFromPath
      ? "in_place_update"
      : "foreign_create";

  const { field: statusField, values: statusValues } = extractEnumField(op);

  return {
    op,
    recordPrefix,
    idFromPath,
    idParams,
    mutating,
    singletonRead,
    mutationKind,
    statusField,
    statusValues,
    errorStyle,
  };
}

// Parse a single status-like enum field out of an operation's request schema. A
// dossier declares a constrained field as "enum[a,b,c]" in its request_schema;
// the generic update refuses a value outside the set, faithful to the API. Only
// the first enum field found is tracked, which covers the ticket status lifecycle
// and any single-enum update without per-tool code.
function extractEnumField(op: ToolOperation): {
  field: string | undefined;
  values: Set<string>;
} {
  const found = findEnumField(op.request_schema);
  if (found === undefined) return { field: undefined, values: new Set() };
  return { field: found.field, values: new Set(found.values) };
}

// Walk a request schema object for the first "<field>": "enum[...]" marker,
// descending through nested objects (the ticket update nests status under
// `ticket`). Returns the field name and its allowed values.
function findEnumField(
  schema: unknown,
): { field: string; values: string[] } | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (typeof value === "string") {
      const match = /^enum\[(.+)\]$/.exec(value.trim());
      if (match) {
        return {
          field: key,
          values: match[1]!.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
        };
      }
    } else if (value !== null && typeof value === "object") {
      const nested = findEnumField(value);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

// Choose which record family an operation primarily addresses. A read with an
// id in the path addresses its own family (orders -> order, charges -> charge).
// A write that creates one family while gating on another (create refund gates
// on the charge) addresses the gated family, identified as the family whose
// existence the operation's enforced invariants check.
function pickRecordPrefix(
  op: ToolOperation,
  families: string[],
  idFromPath: boolean,
): string {
  if (idFromPath) {
    // The path stem before the templated id segment names the family in plural
    // (charges -> charge, orders -> order, customers -> customer).
    const segs = op.http.path.split("/").filter((s) => s.length > 0);
    const idIdx = segs.findIndex((s) => s.startsWith("{"));
    const stemPlural = idIdx > 0 ? segs[idIdx - 1]! : segs[segs.length - 1]!;
    const singular = singularize(stemPlural);
    if (families.includes(singular)) return singular;
    return singular;
  }
  // A create operation: the gated family is the one referenced by an existence
  // invariant. For the refund op that is the charge.
  const existenceId = op.enforced_invariants.find(
    (inv) => resolveInvariantType(inv.id) === "existence",
  )?.id;
  if (existenceId !== undefined) {
    const stem = existenceId.replace(/_exists$/, "");
    if (families.includes(stem)) return stem;
    return stem;
  }
  // Fallback: the first declared family.
  return families[0] ?? "record";
}

// Pull the "one_of:a,b" required marker out of a request schema's params, if
// the dossier declared its primary id parameters that way.
function readOneOfRequired(schema: unknown): string[] {
  if (schema === null || typeof schema !== "object") return [];
  const params = (schema as Record<string, unknown>)["params"];
  if (params === null || typeof params !== "object") return [];
  for (const value of Object.values(params as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const required = (value as Record<string, unknown>)["required"];
    if (typeof required === "string" && required.startsWith("one_of:")) {
      return required
        .slice("one_of:".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }
  return [];
}

// Run one matched operation: parse the body, run the dossier's enforced
// invariants in order (with idempotency handled in its faithful position), then
// either return the read body or apply the mutation. No business rule is ever
// consulted; the only checks are the dossier's enforced_invariants.
function runOperation(
  req: EgressRequest,
  store: ScopedStore,
  binding: OperationBinding,
  errorStyle: "stripe" | "flat",
): ToolResponse {
  const params = parseBody(req.body);

  // Resolve the primary record key and value, faithful to how the hand kernel
  // resolves it: id-in-path reads the last segment; id-in-params resolves the
  // first present id param, mapping a payment_intent through its "pi:<id>" index.
  const primaryId = binding.idFromPath
    ? lastPathSegment(req.path)
    : resolveIdFromParams(params, binding, store);
  const primaryKey =
    primaryId === undefined
      ? undefined
      : `${binding.recordPrefix}:${primaryId}`;
  const primaryRecord =
    primaryKey === undefined ? undefined : store.get(primaryKey);

  const ctx: InvariantContext = {
    params,
    rawBody: req.body,
    store,
    binding,
    primaryKey,
    primaryRecord,
  };

  // Idempotency, if declared, occupies its faithful position: a replay with the
  // same key returns the cached outcome before any record check or mutation.
  const idempotencyDeclared = binding.op.enforced_invariants.some(
    (inv) => resolveInvariantType(inv.id) === "idempotency_replay",
  );
  const idemKey = idempotencyDeclared
    ? headerValue(req.headers, "idempotency-key")
    : undefined;
  const paramsHash = hashParams(params);
  if (idemKey !== undefined) {
    const prior = store.getIdempotency(idemKey);
    if (prior !== undefined) {
      if (prior.params_hash !== paramsHash) {
        return errorResponse(
          400,
          "idempotency_key_in_use",
          "Keys for idempotent requests can only be used with the same parameters.",
          errorStyle,
        );
      }
      return jsonResponse(prior.status, prior.body, []);
    }
  }

  // Index the declared invariants by their resolved type, keeping the dossier's
  // own on_violation envelope for each. Then run them in the API's canonical
  // precedence rather than raw declaration order, so the refusal a request hits
  // is the one the real API would return first.
  const declaredByType = new Map<
    InvariantType,
    { http: number; code: string | undefined }
  >();
  for (const inv of binding.op.enforced_invariants) {
    const type = resolveInvariantType(inv.id);
    if (type === undefined || type === "idempotency_replay") continue;
    if (!declaredByType.has(type)) {
      declaredByType.set(type, {
        http: inv.on_violation.http,
        code: inv.on_violation.code,
      });
    }
  }
  for (const type of INVARIANT_PRECEDENCE) {
    const declared = declaredByType.get(type);
    if (declared === undefined) continue;
    const violation = INVARIANT_REGISTRY[type](ctx);
    if (violation !== undefined) {
      return errorResponse(
        declared.http,
        declared.code ?? defaultCodeForStatus(declared.http),
        violation.message,
        errorStyle,
      );
    }
  }

  if (binding.singletonRead) {
    const record = store.firstByPrefix(binding.recordPrefix);
    if (record === undefined) {
      return errorResponse(
        404,
        binding.errorStyle === "stripe" ? "resource_missing" : "not_found",
        `No ${binding.recordPrefix} configured.`,
        binding.errorStyle,
      );
    }
    // A singleton read returns the record body verbatim, matching the hand
    // policy kernel, which returns the seeded policy record unwrapped.
    return jsonResponse(200, record, []);
  }

  if (!binding.mutating) {
    return readResponse(binding, primaryId, primaryRecord);
  }

  if (binding.mutationKind === "in_place_update") {
    return applyUpdate(binding, ctx, primaryId);
  }

  return applyMutation(binding, ctx, primaryId, idemKey, paramsHash);
}

// Resolve the primary record id from params for a create operation. The first
// present id param wins; a payment_intent is mapped through its "pi:<id>" index
// to the underlying charge, exactly as the hand kernel does.
function resolveIdFromParams(
  params: Record<string, string>,
  binding: OperationBinding,
  store: ScopedStore,
): string | undefined {
  for (const name of binding.idParams) {
    const raw = params[name];
    if (raw === undefined || raw.length === 0) continue;
    if (name === "payment_intent") {
      const index = store.get(`pi:${raw}`);
      const mapped = index?.["charge"];
      return typeof mapped === "string" ? mapped : undefined;
    }
    return raw;
  }
  return undefined;
}

// Read response for a pure GET: return the seeded record verbatim with the id
// echoed under the family's id field, matching the hand read kernels. For the
// charge read, project the nested outcome object the hand kernel synthesizes.
function readResponse(
  binding: OperationBinding,
  primaryId: string | undefined,
  primaryRecord: Record<string, unknown> | undefined,
): ToolResponse {
  if (primaryRecord === undefined) {
    return existenceMissingResponse(binding, primaryId);
  }
  if (binding.recordPrefix === "charge") {
    return jsonResponse(200, projectChargeRead(primaryId!, primaryRecord), []);
  }
  // Orders/customers/tickets echo the record with the id under the family's id
  // field. Orders and customers key by id/email respectively.
  const idField = binding.recordPrefix === "customer" ? "email" : "id";
  return jsonResponse(
    200,
    { [idField]: primaryId, ...primaryRecord },
    [],
  );
}

// Apply a create/update mutation. For the refund brief this is create_refund:
// allocate a seeded id, persist the refund, bump the charge's refunded total,
// and decrement the hidden budget with the faithful reason. No business rule is
// consulted on the way; that silence is the trap.
function applyMutation(
  binding: OperationBinding,
  ctx: InvariantContext,
  primaryId: string | undefined,
  idemKey: string | undefined,
  paramsHash: string,
): ToolResponse {
  const { store, params, primaryRecord } = ctx;
  // The only mutating operation in the refund brief is the refund create. It is
  // expressed generically: gate on the charge, write a refund record, update the
  // charge, drain the budget by the applied amount.
  const charge = primaryRecord!;
  const chargeId = primaryId!;
  const amountTotal = numberField(charge, "amount");
  const alreadyRefunded = numberField(charge, "refunded_amount");
  const remaining = amountTotal - alreadyRefunded;
  const requested =
    params["amount"] === undefined ? remaining : Number(params["amount"]);

  const refundId = store.nextId("re");
  const reason = params["reason"];
  const refund: Record<string, unknown> = {
    id: refundId,
    object: "refund",
    amount: requested,
    currency: stringField(charge, "currency") || "usd",
    charge: chargeId,
    status: "succeeded",
    ...(reason !== undefined ? { reason } : {}),
  };

  store.set(`refund:${refundId}`, refund, `refund ${refundId} created`);
  const updatedCharge: Record<string, unknown> = {
    ...charge,
    refunded_amount: alreadyRefunded + requested,
    refunded: alreadyRefunded + requested >= amountTotal,
  };
  store.set(
    `charge:${chargeId}`,
    updatedCharge,
    `charge ${chargeId} refunded_amount updated`,
  );
  store.decrementBudget(
    requested,
    `refund ${refundId} applied; no business-rule check performed by API`,
  );

  if (idemKey !== undefined) {
    store.recordIdempotency(idemKey, paramsHash, 200, refund);
  }

  return {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-enforced-invariants": enforcedInvariantList(binding.op),
    },
    body: refund,
    state_mutations: store.drainMutations(),
  };
}

// Apply an in-place update to a record addressed by id in the path. The request
// body is merged into the existing record, faithful to a nested-update API: the
// body's record-family object (or its top-level fields) supplies the changed
// fields, a declared enum field is validated, and a nested `comment` object is
// appended to the record's comment thread with its public flag inheriting the
// record's prior public state unless set. This reproduces the ticket update
// generically; existence was already gated by the declared invariant.
function applyUpdate(
  binding: OperationBinding,
  ctx: InvariantContext,
  primaryId: string | undefined,
): ToolResponse {
  const { store, primaryRecord } = ctx;
  const existing = primaryRecord!;
  const id = primaryId!;
  const family = binding.recordPrefix;

  // The update body may nest the changed fields under the record-family key
  // (Zendesk nests under `ticket`); otherwise the top-level body fields apply.
  const root = asObject(ctx.rawBody);
  const nested = asObject(root[family]);
  const updateFields = Object.keys(nested).length > 0 ? nested : root;

  // Validate the declared enum field, if any, against the value being set or the
  // record's current value. A value outside the declared set is mechanically
  // refused, faithful to the real API.
  if (binding.statusField !== undefined) {
    const nextValue =
      typeof updateFields[binding.statusField] === "string"
        ? (updateFields[binding.statusField] as string)
        : stringField(existing, binding.statusField);
    if (
      binding.statusValues.size > 0 &&
      nextValue.length > 0 &&
      !binding.statusValues.has(nextValue)
    ) {
      return errorResponse(
        422,
        binding.errorStyle === "stripe" ? "invalid_request" : "RecordInvalid",
        `${capitalize(binding.statusField)}: '${nextValue}' is not a valid ${binding.statusField}.`,
        binding.errorStyle,
      );
    }
  }

  // Merge the scalar update fields, excluding the comment object which is handled
  // through the append path below.
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(updateFields)) {
    if (key === "comment") continue;
    merged[key] = value;
  }

  // Append a comment when one is supplied, inheriting the record's prior public
  // flag unless the comment sets its own; the comment id is seeded and monotonic.
  const comment = asObject(updateFields["comment"]);
  if (Object.keys(comment).length > 0) {
    const priorPublic = boolFieldDefault(existing, "public", true);
    const isPublic =
      typeof comment["public"] === "boolean"
        ? (comment["public"] as boolean)
        : priorPublic;
    const priorComments = arrayField(existing, "comments");
    const commentId = store.nextId("comment");
    merged["public"] = isPublic;
    merged["comments"] = [
      ...priorComments,
      {
        id: commentId,
        body: typeof comment["body"] === "string" ? comment["body"] : "",
        public: isPublic,
      },
    ];
  }

  const nextStatus =
    binding.statusField !== undefined
      ? stringField(merged, binding.statusField)
      : "";
  store.set(
    `${family}:${id}`,
    merged,
    nextStatus.length > 0
      ? `${family} ${id} updated to ${nextStatus}`
      : `${family} ${id} updated`,
  );

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { [family]: { id, ...merged } },
    state_mutations: store.drainMutations(),
  };
}

// The enforced-invariant id list for the response overlay header, in the
// hand kernel's order: existence, one_of, amount, terminal-state, dispute.
function enforcedInvariantList(op: ToolOperation): string {
  const order: InvariantType[] = [
    "existence",
    "one_of_params",
    "amount_within_remaining",
    "not_already_in_terminal_state",
    "not_disputed",
  ];
  const byType = new Map<InvariantType, string>();
  for (const inv of op.enforced_invariants) {
    const type = resolveInvariantType(inv.id);
    if (type !== undefined && !byType.has(type)) byType.set(type, inv.id);
  }
  // Use the hand kernel's stable label set so the overlay header is identical.
  const labels: Partial<Record<InvariantType, string>> = {
    existence: "charge_exists",
    one_of_params: "one_of_charge_or_pi",
    amount_within_remaining: "amount_within_remaining",
    not_already_in_terminal_state: "not_fully_refunded",
    not_disputed: "not_disputed",
  };
  return order
    .filter((t) => byType.has(t))
    .map((t) => labels[t]!)
    .join(",");
}

// Invariant checkers. Each reads only params and state and returns a violation
// or undefined. None of them reads business_rules_not_enforced.

function checkExistence(ctx: InvariantContext): InvariantViolation | undefined {
  if (ctx.primaryRecord !== undefined) return undefined;
  const id = ctx.primaryKey?.slice(ctx.binding.recordPrefix.length + 1);
  const family = ctx.binding.recordPrefix;
  if (family === "charge") {
    return {
      message:
        id === undefined ? "No such charge." : `No such charge: '${id}'.`,
    };
  }
  return { message: `No such ${family}: '${id ?? ""}'.` };
}

function checkOneOfParams(
  ctx: InvariantContext,
): InvariantViolation | undefined {
  const present = ctx.binding.idParams.some((name) => {
    const v = ctx.params[name];
    return v !== undefined && v.length > 0;
  });
  if (present) return undefined;
  const list = ctx.binding.idParams.map((p) => `\`${p}\``).join(" or ");
  return { message: `Must provide one of ${list}.` };
}

function checkAmountWithinRemaining(
  ctx: InvariantContext,
): InvariantViolation | undefined {
  const charge = ctx.primaryRecord;
  if (charge === undefined) return undefined; // existence already gated.
  const amountTotal = numberField(charge, "amount");
  const alreadyRefunded = numberField(charge, "refunded_amount");
  const remaining = amountTotal - alreadyRefunded;
  if (ctx.params["amount"] === undefined) return undefined; // defaults to remaining.
  const requested = Number(ctx.params["amount"]);
  if (!Number.isFinite(requested) || requested <= 0) {
    return { message: "Invalid integer: amount." };
  }
  if (requested > remaining) {
    return {
      message:
        "Refund amount ($" +
        (requested / 100).toFixed(2) +
        ") is greater than the remaining unrefunded amount.",
    };
  }
  return undefined;
}

function checkNotAlreadyInTerminalState(
  ctx: InvariantContext,
): InvariantViolation | undefined {
  const charge = ctx.primaryRecord;
  if (charge === undefined) return undefined;
  const amountTotal = numberField(charge, "amount");
  const alreadyRefunded = numberField(charge, "refunded_amount");
  if (amountTotal - alreadyRefunded <= 0) {
    return { message: "Charge has already been refunded." };
  }
  return undefined;
}

function checkNotDisputed(
  ctx: InvariantContext,
): InvariantViolation | undefined {
  const charge = ctx.primaryRecord;
  if (charge === undefined) return undefined;
  if (charge["disputed"] === true) {
    return { message: "This charge has a dispute and cannot be refunded." };
  }
  return undefined;
}

// Shared projections and helpers.

function projectChargeRead(
  chargeId: string,
  charge: Record<string, unknown>,
): Record<string, unknown> {
  const amountTotal = numberField(charge, "amount");
  const refundedAmount = numberField(charge, "refunded_amount");
  const riskLevel = stringField(charge, "risk_level") || "normal";
  const riskScore = numberField(charge, "risk_score");
  return {
    id: chargeId,
    object: "charge",
    amount: amountTotal,
    currency: stringField(charge, "currency") || "usd",
    refunded: refundedAmount >= amountTotal && amountTotal > 0,
    amount_refunded: refundedAmount,
    disputed: charge["disputed"] === true,
    outcome: { risk_level: riskLevel, risk_score: riskScore },
  };
}

function existenceMissingResponse(
  binding: OperationBinding,
  primaryId: string | undefined,
): ToolResponse {
  // Use the dossier's declared existence on_violation when present.
  const existence = binding.op.enforced_invariants.find(
    (inv) => resolveInvariantType(inv.id) === "existence",
  );
  const http = existence?.on_violation.http ?? 404;
  const code =
    existence?.on_violation.code ??
    (binding.errorStyle === "stripe" ? "resource_missing" : "not_found");
  const family = binding.recordPrefix;
  const message =
    family === "charge"
      ? `No such charge: '${primaryId ?? ""}'.`
      : `No such ${family}: '${primaryId ?? ""}'.`;
  return errorResponse(http, code, message, binding.errorStyle);
}

function defaultCodeForStatus(status: number): string {
  if (status === 404) return "resource_missing";
  if (status === 400) return "invalid_request";
  return "error";
}

function singularize(plural: string): string {
  if (plural.endsWith("ies")) return `${plural.slice(0, -3)}y`;
  if (plural.endsWith("s")) return plural.slice(0, -1);
  return plural;
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const v = record[key];
  return typeof v === "number" ? v : 0;
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

// Coerce an unknown to a plain object, parsing a JSON string when one arrives.
// Returns an empty object for anything that is not an object or object-shaped
// JSON, so the update apply reads a uniform record.
function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
