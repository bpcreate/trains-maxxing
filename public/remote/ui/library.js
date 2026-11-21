// Clips tab: browse the library and send clips (or live inputs) to a layer.

import { h, chips, buzz, fmtTime, fmtBytes } from './dom.js';
import { LAYERS } from '../../shared/state.js';

export function libraryView(app) {
  const { net } = app;
  let filter = 'all';
  let query = '';
  let cueMode = false;

  const target = chips({
    options: [['A', 'Deck A'], ['B', 'Deck B'], ['C', 'Overlay C'], ['D', 'Overlay D']],
    onPick: (v) => { app.target = v; update(); },
    cls: 'targets',
  });
  const cueBtn = h('button', { class: 'chip cue-toggle', type: 'button', onclick: () => { buzz(); cueMode = !cueMode; update(); } }, 'Hold for GO');
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search clips…', 'aria-label': 'Search clips', oninput: () => { query = search.value.trim().toLowerCase(); renderGrid(); } });
  const filters = h('div', { class: 'chips scroll' });
  const grid = h('div', { class: 'grid' });
  const empty = h('div', { class: 'empty-note' });
  const prepNote = h('p', { class: 'note' });
  const prepBtn = h('button', { class: 'btn', type: 'button', onclick: () => { buzz(); net.send({ t: 'prep', id: 'all' }); app.toast('Preparing every clip — this can take a while'); } }, 'Prepare all clips for smooth scratching');
  const clearBtn = h('button', { class: 'btn subtle', type: 'button', onclick: () => {
    if (confirm('Delete the prepared copies to free disk space? Your original videos are not touched.')) net.send({ t: 'prep.clear' });
  } }, 'Free up space');

  const el = h('div', { class: 'view', id: 'v-clips' },
    h('div', { class: 'sticky' },
      h('div', { class: 'row' }, h('span', { class: 'send-to' }, 'Send to'), target.el),
      h('div', { class: 'row' }, search, cueBtn),
      filters),
    grid, empty,
    h('section', { class: 'panel' }, prepNote, h('div', { class: 'row' }, prepBtn, clearBtn)));

  function load(src) {
    buzz(15);
    net.act({ type: 'load', layer: app.target, src, cue: cueMode });
    const where = app.target < 'C' ? `deck ${app.target}` : `overlay ${app.target}`;
    app.toast(cueMode ? `Waiting on ${where} — press GO on the Mix tab` : `Playing on ${where}`);
    if (app.returnToMix && !cueMode) app.showTab('mix');
    app.returnToMix = false;
  }

  function card({ src, name, thumb, meta, badges, fav, favId, liveId }) {
    const s = net.state;
    const on = LAYERS.filter((id) => s.layers[id].src === src);
    const cued = LAYERS.filter((id) => s.layers[id].cue === src);
    return h('div', { class: 'clip' + (on.length ? ' playing' : '') },
      h('button', { class: 'clip-main', type: 'button', onclick: () => load(src) },
        thumb ? h('img', { src: thumb, alt: '', loading: liveId ? null : 'lazy', 'data-live': liveId }) : h('div', { class: 'no-thumb' }, '…'),
        h('div', { class: 'clip-badges' },
          on.map((id) => h('span', { class: `deck-letter l${id}` }, id)),
          cued.map((id) => h('span', { class: `deck-letter l${id} cued` }, id)),
          badges),
        h('div', { class: 'clip-name' }, name),
        h('div', { class: 'clip-meta' }, meta)),
      favId ? h('button', { class: 'star' + (fav ? ' on' : ''), type: 'button', 'aria-label': 'Favourite', onclick: () => { buzz(); net.act({ type: 'fav', id: favId }); } }, fav ? '★' : '☆') : null);
  }

  function renderFilters() {
    const crates = [...new Set(net.clips.map((c) => c.crate).filter(Boolean))].sort();
    const opts = [['all', 'All'], ['fav', '★'], ['land', 'Landscape'], ['port', 'Portrait']];
    if (net.lives.length) opts.push(['live', '● Live']);
    for (const c of crates) opts.push([`crate:${c}`, c]);
    if (!opts.some(([v]) => v === filter)) filter = 'all';
    filters.replaceChildren(...opts.map(([v, label]) =>
      h('button', { class: 'chip' + (v === filter ? ' on' : ''), type: 'button', onclick: () => { buzz(); filter = v; renderFilters(); renderGrid(); } }, label)));
  }

  function renderGrid() {
    const s = net.state;
    const items = [];
    if (filter === 'all' || filter === 'live') {
      for (const l of net.lives) {
        if (query && !l.name.toLowerCase().includes(query)) continue;
        items.push(card({ src: l.src, name: l.name, thumb: app.liveThumbs[l.id], meta: 'live input', liveId: l.id, badges: h('span', { class: 'badge live' }, '● LIVE') }));
      }
    }
    if (filter !== 'live') {
      for (const c of net.clips) {
        if (filter === 'fav' && !s.favs[c.id]) continue;
        if (filter === 'land' && c.portrait) continue;
        if (filter === 'port' && !c.portrait) continue;
        if (filter.startsWith('crate:') && c.crate !== filter.slice(6)) continue;
        if (query && !(`${c.name} ${c.crate}`).toLowerCase().includes(query)) continue;
        const badges = [
          c.portrait ? h('span', { class: 'badge' }, '▯') : null,
          c.prep === 'ready' ? h('span', { class: 'badge ready', title: 'Ready for smooth scratching' }, '⚡') : null,
          c.prep === 'working' || c.prep === 'queued' ? h('span', { class: 'badge working' }, '⏳') : null,
        ];
        items.push(card({ src: c.id, name: c.name, thumb: c.thumb, meta: c.ready ? fmtTime(c.dur) : 'reading…', badges, fav: !!s.favs[c.id], favId: c.id }));
      }
    }
    grid.replaceChildren(...items);
    empty.textContent = items.length ? ''
      : net.clips.length ? 'Nothing matches.'
      : 'No clips yet. Put videos in the "media" folder on the laptop and they will show up here.';
  }

  let sig = '';
  function update() {
    const s = net.state;
    target.set(app.target);
    cueBtn.classList.toggle('on', cueMode);
    const ready = net.clips.filter((c) => c.prep === 'ready').length;
    const busy = net.clips.filter((c) => c.prep === 'working' || c.prep === 'queued').length;
    prepNote.textContent = !net.canPrep ? 'ffmpeg is missing on the laptop, so clips cannot be prepared for scratching.'
      : `⚡ ${ready} of ${net.clips.length} clips are prepared for smooth scratching and reverse` + (busy ? ` (${busy} in progress)` : '') + `. Prepared copies use ${fmtBytes(net.cache)}.`;
    prepBtn.disabled = !net.canPrep;
    // rebuild the grid only when something it shows has changed
    const next = JSON.stringify([net.clips.map((c) => [c.id, c.prep, c.ready, c.thumb]), net.lives.map((l) => l.id), s.favs,
      LAYERS.map((id) => [s.layers[id].src, s.layers[id].cue]), Object.keys(app.liveThumbs).length]);
    if (next !== sig) {
      sig = next;
      renderFilters();
      renderGrid();
    } else {
      // keep the live thumbnails moving without rebuilding the grid
      for (const img of grid.querySelectorAll('img[data-live]')) {
        const fresh = app.liveThumbs[img.dataset.live];
        if (fresh && img.src !== fresh) img.src = fresh;
      }
    }
  }
  return { el, update };
}
