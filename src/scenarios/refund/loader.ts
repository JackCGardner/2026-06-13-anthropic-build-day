// The typed loader. It assembles the refund pack from its parts and validates
// the whole thing against the frozen ScenarioPackSchema before handing it to
// any consumer, so a malformed fixture, dossier, or rubric fails loudly at load
// time rather than silently downstream. It also asserts the headline invariant
// of this pack: the four bad-case dollar impacts sum to exactly $5,140.

import { ScenarioPackSchema, type ScenarioPack } from "@/engine";
import { REFUND_PACK_ID, REFUND_BRIEF } from "./brief.js";
import {
  REFUND_FIXTURES,
  EXPECTED_CASH_BURNED_CENTS,
  DOLLAR_IMPACTS,
} from "./fixtures.js";
import { REFUND_DOSSIERS } from "./dossiers.js";
import { REFUND_RUBRIC } from "./rubric.js";

// The single legitimate fixture is excluded from the held-out split so the
// headline held-out metric is dominated by trap cases. Train and held-out
// together cover all five fixtures with no overlap.
const REFUND_SPLITS = {
  train: ["legit_in_window", "out_of_window", "wrong_method_double"],
  held_out: ["serial_abuser", "chargeback_flagged"],
};

function assertCashBurnedSum(): void {
  const sum =
    DOLLAR_IMPACTS.out_of_window +
    DOLLAR_IMPACTS.serial_abuser +
    DOLLAR_IMPACTS.chargeback_flagged +
    DOLLAR_IMPACTS.wrong_method_double;
  if (sum !== EXPECTED_CASH_BURNED_CENTS) {
    throw new Error(
      `Refund pack invariant violated: bad-case impacts sum to ${sum} cents, ` +
        `expected ${EXPECTED_CASH_BURNED_CENTS} ($5,140).`,
    );
  }
}

// Build and validate the refund scenario pack. Throws if the pack does not
// satisfy the frozen schema or the $5,140 invariant.
export function loadRefundPack(): ScenarioPack {
  assertCashBurnedSum();
  const candidate = {
    id: REFUND_PACK_ID,
    brief: REFUND_BRIEF,
    fixtures: REFUND_FIXTURES,
    dossiers: REFUND_DOSSIERS,
    rubric: REFUND_RUBRIC,
    splits: REFUND_SPLITS,
  };
  return ScenarioPackSchema.parse(candidate);
}
