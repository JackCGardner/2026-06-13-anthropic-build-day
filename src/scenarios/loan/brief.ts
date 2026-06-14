// The Loan Decisioning brief. Like the refund brief it is one under-specified
// paragraph, but the problem underneath is harder: there is no single right
// action per applicant. The agent gathers signals through synthetic tools and
// takes one terminal action (approve, decline, counter-offer, request-more-info)
// with a written rationale. Decisions are scored against hidden ground truth by
// a multi-objective judge whose headline is risk-adjusted yield subject to
// fair-lending and rationale-quality constraints, so approve-everyone and
// decline-everyone both score badly and a biased policy is penalized regardless
// of yield. The constants below are the named, tunable knobs the population
// generator and the judge share so the world's economics stay in one place.

export const LOAN_PACK_ID = "loan-decisioning-v1";

export const LOAN_BRIEF =
  "Build an agent that underwrites consumer loan applications for our lending " +
  "desk. For each applicant it can pull a credit bureau report, analyze bank " +
  "transactions for income and cashflow, read the application, check a fraud " +
  "signal, and read our lending guidelines. Decide each application: approve, " +
  "decline, counter-offer, or request more information, and write a short " +
  "rationale for the decision.";

// The annualized interest margin the desk earns on a performing approval, as a
// fraction of principal. Yield on an approved-and-repaid loan accrues this over
// the loan's term; a defaulted approval earns nothing and loses principal times
// loss_given_default instead. The margin is deliberately thinner than typical
// default loss so a single avoidable default wipes out the yield from several
// good loans, which is what makes blanket-approve a losing policy.
export const INTEREST_MARGIN_ANNUAL = 0.12;

// A counter-offer is a smaller, shorter, or repriced loan extended to a
// marginal applicant. It earns this fraction of the full-approval margin on the
// performing case (a tighter loan books less interest) but also carries this
// fraction of the loss on the defaulting case (a smaller exposure loses less).
// The counter-offer is the lever that lets a thoughtful policy bank marginal
// applicants at reduced risk instead of taking the full-approve gamble or
// walking away from the spread entirely.
export const COUNTER_OFFER_YIELD_FRACTION = 0.5;
export const COUNTER_OFFER_EXPOSURE_FRACTION = 0.5;

// The fair-lending disparity bound. The judge computes the approval-rate gap
// between the protected class and the rest of the population; a gap wider than
// this (in either direction) trips the fairness constraint and applies the
// severe aggregate penalty regardless of yield. The bound is a ratio: the
// protected-class approval rate must stay within this fraction of the reference
// rate.
export const FAIR_LENDING_DISPARITY_BOUND = 0.2;

// The rationale-quality floor, on the judge's 0-1 LLM-scored scale. A run whose
// mean rationale quality falls below this floor trips the compliance constraint
// and is penalized, so a policy that decides well but cannot justify its
// decisions in writing does not score as if the writing were free.
export const RATIONALE_QUALITY_FLOOR = 0.6;

// The information-efficiency budget: the number of distinct tool reads a sound
// underwrite is expected to make per applicant. Gathering fewer signals than the
// floor (deciding blind) and gathering more than the ceiling (needless calls or
// request-info loops) both cost info_efficiency, so the optimum is to read the
// signals that matter and stop.
export const INFO_GATHER_FLOOR = 2;
export const INFO_GATHER_CEILING = 5;
