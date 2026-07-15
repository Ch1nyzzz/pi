import { describe, expect, it } from "vitest";
import {
	evaluateTrialContractGate,
	parseTrialDurationDays,
	primaryMetricRegression,
	type TrialComparison,
} from "../src/comparison.ts";

function comparisonWith(delta: Partial<TrialComparison["delta"]>, sufficient = true): TrialComparison {
	return {
		sufficiency: {
			status: sufficient ? "sufficient" : "insufficient",
			minimumSessionsPerCohort: 3,
			reasons: sufficient ? [] : ["before cohort has 1 of 3 sessions"],
		},
		delta: {
			toolErrorRate: null,
			verificationPassRate: null,
			assistantTurnsPerTask: null,
			followUpsPerTask: null,
			tokensPerTask: null,
			...delta,
		},
	} as unknown as TrialComparison;
}

const CONTRACT = { primaryMetric: "followUpsPerTask", minimumEffect: { followUpsPerTask: 0.1 } };

describe("trial contract gates", () => {
	it("parses whole-day durations only", () => {
		expect(parseTrialDurationDays("14d")).toBe(14);
		expect(parseTrialDurationDays("0d")).toBeUndefined();
		expect(parseTrialDurationDays("2w")).toBeUndefined();
	});

	it("allows a keep when evidence is sufficient and the primary metric meets the frozen effect", () => {
		const gate = evaluateTrialContractGate(CONTRACT, comparisonWith({ followUpsPerTask: -0.15 }));
		expect(gate).toEqual({ allowed: true, reasons: [] });
	});

	it("blocks a keep when the improvement is below the frozen minimum effect", () => {
		const gate = evaluateTrialContractGate(CONTRACT, comparisonWith({ followUpsPerTask: -0.05 }));
		expect(gate.allowed).toBe(false);
		expect(gate.reasons[0]).toContain("below the frozen minimum effect");
	});

	it("blocks a keep on insufficient evidence or an unmeasured primary metric", () => {
		expect(evaluateTrialContractGate(CONTRACT, comparisonWith({ followUpsPerTask: -0.2 }, false)).allowed).toBe(
			false,
		);
		const unmeasured = evaluateTrialContractGate(CONTRACT, comparisonWith({}));
		expect(unmeasured.allowed).toBe(false);
		expect(unmeasured.reasons[0]).toContain("no measurement");
	});

	it("respects metric direction for higher-is-better metrics", () => {
		const contract = { primaryMetric: "verificationPassRate", minimumEffect: { verificationPassRate: 0.05 } };
		expect(evaluateTrialContractGate(contract, comparisonWith({ verificationPassRate: 0.08 })).allowed).toBe(true);
		expect(evaluateTrialContractGate(contract, comparisonWith({ verificationPassRate: -0.08 })).allowed).toBe(false);
	});

	it("fires the machine rollback trigger only on a regression beyond the frozen effect", () => {
		expect(primaryMetricRegression(CONTRACT, comparisonWith({ followUpsPerTask: 0.2 }))).toContain("regressed");
		expect(primaryMetricRegression(CONTRACT, comparisonWith({ followUpsPerTask: 0.05 }))).toBeUndefined();
		expect(primaryMetricRegression(undefined, comparisonWith({ followUpsPerTask: 0.5 }))).toBeUndefined();
	});
});
