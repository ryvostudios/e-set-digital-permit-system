import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

function ToastTrigger() {
  const toast = useToast();
  return <button onClick={() => toast.show('Saved')}>Show toast</button>;
}

describe('ToastProvider timer lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('shows a toast and dismisses it after five seconds while mounted', () => {
    const view = render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
  });

  it('cancels a pending dismissal when the provider unmounts', () => {
    const view = render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it('cancels every active dismissal when the provider unmounts', () => {
    const view = render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Show toast' });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.getAllByText('Saved')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(2);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.runAllTimers()).not.toThrow();
  });
});
