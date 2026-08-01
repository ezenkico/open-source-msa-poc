import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, Field, Panel, StatusBadge } from "./ui";

describe("dashboard UI primitives", () => {
  it("passes native section props and custom classes through Panel", () => {
    render(
      <Panel aria-label="Telemetry overview" className="custom-panel" data-surface="overview">
        Current telemetry
      </Panel>,
    );

    const panel = screen.getByRole("region", { name: "Telemetry overview" });
    expect(panel).toHaveAttribute("data-surface", "overview");
    expect(panel).toHaveClass("custom-panel");
    expect(panel).toHaveTextContent("Current telemetry");
  });

  it.each([
    ["cyan", "border-cyan-400/20"],
    ["amber", "border-amber-400/20"],
  ] as const)("gives a %s Panel exactly one border-color utility", (borderTone, borderClass) => {
    render(
      <Panel aria-label={`${borderTone} telemetry`} borderTone={borderTone}>
        Current telemetry
      </Panel>,
    );

    const panel = screen.getByRole("region", { name: `${borderTone} telemetry` });
    expect(panel).toHaveClass("border", borderClass);
    expect(panel).not.toHaveClass("border-slate-800/90");
  });

  it("passes accessible labels and custom classes through StatusBadge", () => {
    render(
      <StatusBadge appearance="live" aria-label="Connection status" className="custom-badge">
        Live
      </StatusBadge>,
    );

    const badge = screen.getByLabelText("Connection status");
    expect(badge).toHaveClass("custom-badge");
    expect(badge).toHaveTextContent("Live");
  });

  it("preserves native button behavior and disabled state", () => {
    const onClick = vi.fn();
    render(
      <Button
        appearance="danger"
        aria-label="Remove device"
        className="custom-button"
        disabled
        onClick={onClick}
        type="button"
      >
        Remove
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Remove device" });
    expect(button).toBeDisabled();
    expect(button).toHaveClass("custom-button");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("passes native label props and custom classes through Field", () => {
    render(
      <Field htmlFor="device-name" className="custom-field" data-field="device-name">
        Device name
      </Field>,
    );

    const field = screen.getByText("Device name");
    expect(field).toHaveAttribute("for", "device-name");
    expect(field).toHaveAttribute("data-field", "device-name");
    expect(field).toHaveClass("custom-field");
  });
});
