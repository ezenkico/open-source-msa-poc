import { startTransition, useState } from "react";
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

const neverResolves = new Promise<never>(() => undefined);

function Suspend(): null {
  throw neverResolves;
}

interface SuspendedHarnessProps {
  committedCallback: () => void;
  interruptedCallback: () => void;
}

function SuspendedHarness({ committedCallback, interruptedCallback }: SuspendedHarnessProps) {
  const [useInterruptedCallback, setUseInterruptedCallback] = useState(false);
  const callback = useInterruptedCallback ? interruptedCallback : committedCallback;
  const { schedule } = useDebouncedCallback(callback, 250, []);

  return (
    <>
      <button type="button" onClick={schedule}>Schedule</button>
      <button
        type="button"
        onClick={() => startTransition(() => setUseInterruptedCallback(true))}
      >
        Interrupt render
      </button>
      {useInterruptedCallback && <Suspend />}
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

  it("keeps the last committed callback during a suspended render", () => {
    const committedCallback = vi.fn();
    const interruptedCallback = vi.fn();
    render(
      <SuspendedHarness
        committedCallback={committedCallback}
        interruptedCallback={interruptedCallback}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    fireEvent.click(screen.getByRole("button", { name: "Interrupt render" }));
    act(() => vi.advanceTimersByTime(250));

    expect(committedCallback).toHaveBeenCalledOnce();
    expect(interruptedCallback).not.toHaveBeenCalled();
  });
});
