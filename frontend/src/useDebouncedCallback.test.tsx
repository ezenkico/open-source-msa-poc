import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedCallback } from "./useDebouncedCallback";

interface HarnessProps {
  callback: () => void;
  resetKey: string;
}

function Harness({ callback, resetKey }: HarnessProps) {
  const { cancel, schedule } = useDebouncedCallback(callback, 250, [resetKey]);

  return (
    <>
      <button type="button" onClick={schedule}>Schedule</button>
      <button type="button" onClick={cancel}>Cancel</button>
    </>
  );
}

describe("useDebouncedCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts one pending timer when scheduled again", () => {
    const callback = vi.fn();
    render(<Harness callback={callback} resetKey="one" />);

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    act(() => vi.advanceTimersByTime(249));
    expect(callback).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(callback).toHaveBeenCalledOnce();
  });

  it("prevents invocation when cancelled", () => {
    const callback = vi.fn();
    render(<Harness callback={callback} resetKey="one" />);

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => vi.advanceTimersByTime(250));

    expect(callback).not.toHaveBeenCalled();
  });

  it("cancels pending work when a reset key changes", () => {
    const callback = vi.fn();
    const view = render(<Harness callback={callback} resetKey="one" />);

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    view.rerender(<Harness callback={callback} resetKey="two" />);
    act(() => vi.advanceTimersByTime(250));

    expect(callback).not.toHaveBeenCalled();
  });

  it("cancels pending work when unmounted", () => {
    const callback = vi.fn();
    const view = render(<Harness callback={callback} resetKey="one" />);

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    view.unmount();
    act(() => vi.advanceTimersByTime(250));

    expect(callback).not.toHaveBeenCalled();
  });

  it("invokes the latest callback closure", () => {
    const firstCallback = vi.fn();
    const latestCallback = vi.fn();
    const view = render(<Harness callback={firstCallback} resetKey="one" />);

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    view.rerender(<Harness callback={latestCallback} resetKey="one" />);
    act(() => vi.advanceTimersByTime(250));

    expect(firstCallback).not.toHaveBeenCalled();
    expect(latestCallback).toHaveBeenCalledOnce();
  });
});
