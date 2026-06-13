// The Refund Trap scenario pack: brief, fixtures with visible and hidden state,
// per-tool dossiers, and the rubric with per-case ground truth and dollar
// impact. The typed loader validates the assembled pack against the frozen
// ScenarioPackSchema and asserts the $5,140 invariant.

export { REFUND_PACK_ID, REFUND_BRIEF } from "./brief.js";
export {
  MANAGER_APPROVAL_THRESHOLD_CENTS,
  REFUND_WINDOW_DAYS,
  SERIAL_ABUSE_REFUND_COUNT_30D,
} from "./brief.js";
export { REFUND_DOSSIERS } from "./dossiers.js";
export { REFUND_RUBRIC } from "./rubric.js";
export { REFUND_POLICY_MARKDOWN } from "./policy.js";
export {
  REFUND_FIXTURES,
  DOLLAR_IMPACTS,
  EXPECTED_CASH_BURNED_CENTS,
} from "./fixtures.js";
export { loadRefundPack } from "./loader.js";
