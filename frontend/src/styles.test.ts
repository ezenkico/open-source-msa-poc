import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const viteConfig = readFileSync(resolve("vite.config.ts"), "utf8");
const styles = readFileSync(resolve("src/styles.css"), "utf8");

describe("Tailwind build foundation", () => {
  it("registers the Tailwind Vite plugin", () => {
    expect(viteConfig).toContain("tailwindcss()");
  });

  it("imports Tailwind before the global base rules", () => {
    expect(styles).toMatch(/^@import "tailwindcss";/);
  });
});
