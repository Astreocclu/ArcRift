import { gateLatencyPrompts, recommendedPiTimeoutMs } from "../../src/scripts/measure-pi-gate-latency";
import { piProcessArgs } from "../../src/services/memory-providers";

describe("pi gate latency measurement", () => {
  it("uses five representative bounded gate prompts through the production prompt-file route", () => {
    const prompts = gateLatencyPrompts();
    expect(prompts).toHaveLength(5);
    expect(prompts.every(item => item.prompt.includes("Return"))).toBe(true);
    expect(prompts.map(item => Buffer.byteLength(item.prompt, "utf8"))).toEqual([
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
    ]);
    expect(Buffer.byteLength(prompts[0].prompt, "utf8")).toBeGreaterThanOrEqual(1_000);
    expect(Buffer.byteLength(prompts[1].prompt, "utf8")).toBeGreaterThanOrEqual(4_000);
    expect(Buffer.byteLength(prompts[2].prompt, "utf8")).toBeGreaterThanOrEqual(8_000);
    expect(Buffer.byteLength(prompts[3].prompt, "utf8")).toBeGreaterThanOrEqual(16_000);
    expect(Buffer.byteLength(prompts[4].prompt, "utf8")).toBeGreaterThanOrEqual(32_000);
    expect(piProcessArgs("openai-codex/gpt-6-luna", "/tmp/gate-prompt.txt")).toContain("@/tmp/gate-prompt.txt");
  });

  it("calculates a 1.5x timeout rounded up to seconds", () => {
    expect(recommendedPiTimeoutMs([1_000, 2_100])).toBe(4_000);
  });
});
