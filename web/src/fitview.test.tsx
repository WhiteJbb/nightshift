// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import type { TermSize } from '../../shared/types.ts';
import { useFitToView } from './fitview.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function View({ on, size, k, measure, fit }: { on: boolean; size: TermSize | null; k: string; measure: () => TermSize; fit: (w: TermSize) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFitToView(ref, on, size, k, measure, fit);
  return <div ref={ref} />;
}

// jsdom 에는 ResizeObserver 와 레이아웃이 없다. 알림을 직접 보내고, 폭은 clientWidth 로 정한다
let width = 600;
const observed: (() => void)[] = [];
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(cb: () => void) {
      observed.push(cb);
    }
    observe() {}
    disconnect() {}
  },
);
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });

test('fits once drawn, follows window resizes and width changes, and leaves alone a size another screen set', async () => {
  vi.useFakeTimers();
  let area = { cols: 150, rows: 40 };
  const fit = vi.fn();
  const props = { on: true, k: 'p1:false', measure: () => area, fit };
  const { rerender } = render(<View {...props} size={null} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fit).not.toHaveBeenCalled(); // 첫 화면 전에는 재지 않는다

  rerender(<View {...props} size={{ cols: 120, rows: 30 }} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fit).toHaveBeenLastCalledWith({ cols: 150, rows: 40 });

  // 창을 키우면 끄는 동안은 기다렸다가 한 번 맞춘다
  area = { cols: 300, rows: 60 };
  window.dispatchEvent(new Event('resize'));
  await act(() => vi.advanceTimersByTimeAsync(100));
  window.dispatchEvent(new Event('resize'));
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fit).toHaveBeenCalledTimes(2);
  expect(fit).toHaveBeenLastCalledWith({ cols: 300, rows: 60 });

  // 다른 화면(휴대폰)이 맞춘 크기로 바뀌어도, 이 화면의 영역이 그대로면 되돌리지 않는다
  rerender(<View {...props} size={{ cols: 50, rows: 30 }} />);
  window.dispatchEvent(new Event('resize'));
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fit).toHaveBeenCalledTimes(2);

  // 영역의 높이만 바뀐 것(내용이 바뀜)으로는 맞추지 않고, 폭이 바뀌면(사이드바·칸 배치) 맞춘다
  area = { cols: 200, rows: 55 };
  observed.forEach((cb) => cb());
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fit).toHaveBeenCalledTimes(2);
  width = 900;
  observed.forEach((cb) => cb());
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fit).toHaveBeenCalledTimes(3);
  expect(fit).toHaveBeenLastCalledWith({ cols: 200, rows: 55 });

  // 꺼졌다 켜지면(나란히 보기에서 돌아옴) 처음처럼 다시 맞춘다
  rerender(<View {...props} on={false} size={{ cols: 50, rows: 30 }} />);
  rerender(<View {...props} size={{ cols: 50, rows: 30 }} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(fit).toHaveBeenCalledTimes(4);
});
