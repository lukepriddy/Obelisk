/*
 * Two jobs, one observer.
 *
 * 1. Reveal: anything marked .reveal fades up once when it arrives. Once, not
 *    every time it crosses the edge, because content that re-animates on the
 *    way back up is a page fighting the person reading it.
 *
 * 2. Retint: each feature section carries data-accent, and the one filling the
 *    middle of the screen sets the page accent. The header button, the chips
 *    and the panel glow all follow. It is the "make it yours" claim being
 *    demonstrated rather than asserted.
 *
 * No dependencies and no scroll handler. IntersectionObserver does this off the
 * main thread; a scroll listener recalculating positions would be the one thing
 * on the page capable of making it stutter.
 */
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.documentElement;

  // Reveal
  var revealables = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    // No observer, or no appetite for motion: show everything immediately.
    // The failure mode for a reveal script must never be invisible content.
    revealables.forEach(function (el) { el.classList.add('in-view'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in-view');
        revealObserver.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.15 });
    revealables.forEach(function (el) { revealObserver.observe(el); });
  }

  // Retint
  var sections = document.querySelectorAll('[data-accent]');
  if (!sections.length || !('IntersectionObserver' in window)) return;

  var DEFAULT_ACCENT = '#10b981';
  var visible = [];

  var accentObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var i = visible.indexOf(entry.target);
      if (entry.isIntersecting && i === -1) visible.push(entry.target);
      if (!entry.isIntersecting && i !== -1) visible.splice(i, 1);
    });

    // Document order, so scrolling up lands on the same accent scrolling down
    // gave you. Sorting by intersection ratio instead would flicker between two
    // sections while both are half on screen.
    if (!visible.length) { root.style.setProperty('--accent', DEFAULT_ACCENT); return; }
    visible.sort(function (a, b) {
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    root.style.setProperty('--accent', visible[0].getAttribute('data-accent'));
  }, { rootMargin: '-40% 0px -40% 0px' });

  sections.forEach(function (el) { accentObserver.observe(el); });
})();
