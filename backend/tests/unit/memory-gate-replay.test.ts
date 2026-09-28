import { mapReplayDecision, validateReplay } from "../../src/scripts/validate-memory-gate-replay";

describe("memory gate replay validator", () => {
  it("maps bake-off keeper and non-memory predictions into production decisions", () => {
    expect(mapReplayDecision({ i: 0, label: "decision", scope: "global", confidence: 0.9, subject_key: "git.rule", record: "Keep Git mechanics agent-owned." })).toEqual({
      label: "decision", scope: "global", confidence: 0.9, records: [{ subject_key: "git.rule", text: "Keep Git mechanics agent-owned." }],
    });
    expect(mapReplayDecision({ i: 1, label: "drop", scope: "-", confidence: 0.8, subject_key: "", record: "" })).toEqual({
      label: "drop", scope: "-", confidence: 0.8, records: [],
    });
  });

  it("reports every failed replay index and validator reason without source text", () => {
    const receipt = validateReplay({
      "0": { i: 0, label: "decision", scope: "global", confidence: 0.9, subject_key: "git.rule", record: "Keep Git mechanics agent-owned." },
      "1": { i: 1, label: "receipt", scope: "global", confidence: 0.9, subject_key: "", record: "" },
    });
    expect(receipt).toEqual({ total: 2, passed: 1, failed: [{ i: 1, reason: "invalid non-memory gate result" }] });
    expect(JSON.stringify(receipt)).not.toContain("Keep Git mechanics");
  });
});
