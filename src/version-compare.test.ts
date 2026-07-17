import { expect, test } from "bun:test";
import { compareVersions } from "./version-compare.ts";

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

test("prerelease number is part of the order (issue #107)", () => {
  // The acceptance chain: beta1 < beta2 < rc1 < final release, same base.
  expect(sign(compareVersions("7.24beta1", "7.24beta2"))).toBe(-1);
  expect(sign(compareVersions("7.24beta2", "7.24rc1"))).toBe(-1);
  expect(sign(compareVersions("7.24rc1", "7.24"))).toBe(-1);
  // rc numbers too.
  expect(sign(compareVersions("7.20rc1", "7.20rc2"))).toBe(-1);
});

test("a sort over same-base prereleases is strictly version-ordered", () => {
  const shuffled = ["7.24", "7.24beta2", "7.24rc1", "7.24beta1", "7.24beta3"];
  expect([...shuffled].sort(compareVersions)).toEqual([
    "7.24beta1",
    "7.24beta2",
    "7.24beta3",
    "7.24rc1",
    "7.24",
  ]);
});

test("channel precedence: beta < rc < release for one base", () => {
  expect(sign(compareVersions("7.24beta5", "7.24rc1"))).toBe(-1); // higher beta N still below rc
  expect(sign(compareVersions("7.24rc9", "7.24"))).toBe(-1); // any rc below final
});

test("a bare channel marker sorts below its numbered siblings", () => {
  expect(sign(compareVersions("7.24beta", "7.24beta1"))).toBe(-1);
  expect(sign(compareVersions("7.24rc", "7.24rc1"))).toBe(-1);
});

test("numeric ordering still wins over lexical (the original trap)", () => {
  // "7.9" > "7.10" as strings, but 9 < 10 numerically.
  expect(sign(compareVersions("7.9", "7.10"))).toBe(-1);
  expect(sign(compareVersions("7.9.2", "7.24rc1"))).toBe(-1);
});

test("equal versions compare equal, symmetry holds", () => {
  expect(compareVersions("7.24beta2", "7.24beta2")).toBe(0);
  expect(sign(compareVersions("7.24beta2", "7.24beta1"))).toBe(1); // reverse of the -1 above
});
