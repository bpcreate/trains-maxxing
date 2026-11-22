// Second screens: keeping a following stage's playheads in step with the
// leading stage. The leader reports each deck's position a few times a second;
// a follower works out where the leader is now and closes the gap, gently when
// it is small and with a jump when it is large.

export const JUMP = 0.3; // seconds apart before a follower jumps instead of easing

/**
 * Where the leader's playhead is now.
 * @param tg    the leader's report for one deck: { p (s), v (clip seconds per second) }
 * @param age   seconds since that report was made
 * @param inT   loop start (s)
 * @param end   loop end (s)
 * @param loop  true when playback wraps round (plain looping)
 */
export function leadPos(tg, age, inT, end, loop) {
  let p = tg.p + tg.v * age;
  const len = end - inT;
  if (len <= 0) return inT;
  if (loop) {
    if (p >= end) p = inT + ((p - end) % len);
    else if (p < inT) p = end - ((inT - p) % len);
    return p;
  }
  return Math.min(end, Math.max(inT, p));
}

/** Signed gap from `pos` to `want`, the short way round when looping. */
export function gap(want, pos, inT, end, loop) {
  let e = want - pos;
  const len = end - inT;
  if (loop && len > 0) {
    if (e > len / 2) e -= len;
    else if (e < -len / 2) e += len;
  }
  return e;
}

/** Speed trim for a <video> that plays on its own clock: up to 12% faster or slower. */
export function trimFor(e) {
  if (Math.abs(e) < 0.025) return 1;
  return 1 + Math.min(0.12, Math.max(-0.12, e * 0.6));
}
