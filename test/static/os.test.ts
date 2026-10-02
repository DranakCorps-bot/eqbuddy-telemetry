// DRA-784 D1: the OS family classifier, on the exact strings. Pure, so it runs in Node.

import { describe, expect, it } from "vitest";
import { OS_FAMILIES, type OsFamily, osFamily } from "../../src/os";

describe("osFamily", () => {
  // Every family, from the exact form that produces it. Today's client sends only
  // the first; the three Wine forms are DRA-784 D2's wire form.
  const FORMS: Record<OsFamily, string> = {
    windows: "Windows 10.0.26200",
    "macos-wine": "Windows 10.0.19045; Wine on macOS",
    "linux-wine": "Windows 10.0.19045; Wine on Linux",
    "wine-other": "Windows 10.0.19045; Wine",
    other: "Darwin 23.4.0",
  };

  // Trap 78: every bucket must be reachable, or a family can read 0 forever and look measured.
  it("reaches every family, and the list is exactly the five", () => {
    expect(Object.keys(FORMS).sort()).toEqual([...OS_FAMILIES].sort());
    for (const [family, os] of Object.entries(FORMS)) expect(osFamily(os), os).toBe(family);
  });

  it("reads today's client form for any Major.Minor.Build, including a build of 0", () => {
    for (const os of ["Windows 10.0.26200", "Windows 10.0.19045", "Windows 6.1.7601", "Windows 10.0.0"]) {
      expect(osFamily(os), os).toBe("windows");
    }
  });

  it("a string that matches nothing is other, never guessed into a family", () => {
    for (const os of [
      "Windows", // no version: not what OsFrom builds
      "windows 10.0.26200", // case
      "Windows 10.0.26200 ", // trailing space
      " Windows 10.0.26200",
      "Windows 10.0", // two parts
      "Windows 10.0.26200.1", // four parts
      "Windows 10.0.19045; Wine on FreeBSD", // a host D2 does not name
      "Windows 10.0.19045; wine on macOS", // case inside the suffix
      "Windows 10.0.19045;Wine on macOS", // no space
      "Windows 10.0.19045; Wine on macOS; extra",
      "macOS 14.4",
      "Linux 6.8.0",
      "",
    ]) {
      expect(osFamily(os), JSON.stringify(os)).toBe("other");
    }
  });
});
