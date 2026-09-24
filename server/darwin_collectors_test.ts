import { assertEquals, assertThrows } from "@std/assert";
import { parseCpuUsage, parsePercent } from "./darwin_collectors.ts";

Deno.test("parseCpuUsage sums macOS user and system CPU", () => {
  assertEquals(parseCpuUsage("CPU usage: 0.80% user, 7.20% sys, 92.0% idle"), 8);
});

Deno.test("parsePercent reads memory_pressure free percentage", () => {
  assertEquals(parsePercent("System-wide memory free percentage: 75%"), 75);
});

Deno.test("macOS parser refuses changed command output", () => {
  assertThrows(() => parseCpuUsage("no cpu line"));
  assertThrows(() => parsePercent("no percentage"));
});
