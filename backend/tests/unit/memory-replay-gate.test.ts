import { scoreReplay } from "../../scripts/replay-memory-gate";

describe("memory gate replay scoring", () => {
  const gold = [
    { labels: ["decision"], scope: "global" },
    { labels: ["receipt"], scope: "-" },
    { labels: ["drop"], scope: "-" },
    { labels: ["project_fact", "lesson"], scope: "project" },
  ];
  const pairGold = new Map([[0, ["same"]], [1, ["conflict", "distinct"]]]);

  it("scores routes, junk admission, alternatives, and pair relations", () => {
    const score = scoreReplay(
      [
        { i: 0, label: "preference", scope: "global", confidence: 0.9, subject_key: "x", record: "X" },
        { i: 1, label: "receipt", scope: "-", confidence: 0.9, subject_key: "", record: "" },
        { i: 2, label: "authority", scope: "global", confidence: 0.8, subject_key: "x", record: "X" },
        { i: 3, label: "lesson", scope: "project", confidence: 0.9, subject_key: "x", record: "X" },
      ],
      [{ p: 0, relation: "same", confidence: 0.9 }, { p: 1, relation: "distinct", confidence: 0.8 }],
      gold,
      pairGold,
    );
    expect(score).toMatchObject({ triage_well_formed: 4, route_score: 3, junk_admitted: 1, pair_well_formed: 2, pair_score: 2 });
  });

  it("selects active only when every frozen threshold is met", () => {
    const triage = Array.from({ length: 120 }, (_, i) => ({
      i, label: i < 111 ? "decision" : "drop", scope: i < 111 ? "global" : "-",
      confidence: 0.9, subject_key: i < 111 ? `subject.${i}` : "", record: i < 111 ? `Record ${i}` : "",
    }));
    const fullGold = Array.from({ length: 120 }, (_, i) => ({ labels: [i < 111 ? "decision" : "drop"], scope: i < 111 ? "global" : "-" }));
    const pairs = Array.from({ length: 20 }, (_, p) => ({ p, relation: p < 17 ? "same" : "distinct", confidence: 0.9 }));
    const fullPairGold = new Map(Array.from({ length: 20 }, (_, p) => [p, [p < 17 ? "same" : "conflict"]] as [number, string[]]));

    expect(scoreReplay(triage, pairs, fullGold, fullPairGold).selected_mode).toBe("active");
    expect(scoreReplay(triage.slice(1), pairs, fullGold, fullPairGold).selected_mode).toBe("shadow");
  });
});
