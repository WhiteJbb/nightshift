import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { TermSize } from '../../shared/types.ts';

/**
 * 붙어 있는 터미널이 없으면 tmux 창을 이 화면의 터미널 영역 크기에 맞춘다: 첫 화면이 그려진 뒤, 그리고 창 크기·칸 배치(key)가
 * 바뀔 때마다 (큰 화면에서 창을 키우면 터미널도 넓어진다). 잰 크기가 지난번과 같으면 다시 맞추지 않는다:
 * 다른 화면(휴대폰 등)이 맞춘 크기를 이 화면이 되돌리지 않게
 */
export function useFitToView(view: RefObject<HTMLElement | null>, on: boolean, size: TermSize | null, key: string, measure: () => TermSize, fit: (want: TermSize) => void) {
  const last = useRef<string | null>(null);
  const latest = useRef({ measure, fit, size });
  latest.current = { measure, fit, size };
  const ready = size !== null;
  useEffect(() => {
    // 꺼졌다 다시 켜지면(나란히 보기에서 돌아옴, 붙어 있던 터미널이 떨어짐) 처음처럼 맞춘다
    if (!on) last.current = null;
    if (!on || !ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 창 크기를 끌어 바꾸는 동안은 기다렸다가 멈춘 뒤에 한 번 맞춘다
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { measure, fit, size } = latest.current;
        const want = measure();
        const seen = `${key}:${want.cols}x${want.rows}`;
        if (!size || last.current === seen) return;
        last.current = seen;
        if (want.cols !== size.cols || want.rows !== size.rows) fit(want);
      }, 300);
    };
    check();
    // 영역의 폭(사이드바·칸 배치)만 본다. 높이는 내용을 따라 바뀌어서(다른 화면이 맞춘 줄 수, 바가 줄바꿈되어 밀림) 그것으로 맞추면
    // 다른 화면의 크기를 되돌린다. 창 높이는 resize 이벤트로 본다. 폭은 테두리 상자로 잰다: 내용이 넘쳐 생기는 스크롤바는 치지 않는다
    const el = view.current;
    let width = el?.offsetWidth;
    const ro =
      el && typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (el.offsetWidth === width) return;
            width = el.offsetWidth;
            check();
          })
        : null;
    if (el) ro?.observe(el);
    window.addEventListener('resize', check);
    return () => {
      clearTimeout(timer);
      ro?.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [on, ready, key, view]);
}
