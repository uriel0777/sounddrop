/* ─── SoundDrop — Frontend Logic ──────────────────────────────────────────── */

const searchInput  = document.getElementById('search-input');
const searchBtn    = document.getElementById('search-btn');
const clearBtn     = document.getElementById('clear-btn');
const searchBtnTxt = searchBtn.querySelector('.search-btn-text');
const searchBtnLdr = searchBtn.querySelector('.search-btn-loader');
const resultsSection = document.getElementById('results-section');
const resultsGrid    = document.getElementById('results-grid');
const resultsCount   = document.getElementById('results-count');
const resultsQueryLbl = document.getElementById('results-query-label');
const emptyState   = document.getElementById('empty-state');
const errorState   = document.getElementById('error-state');
const errorTitle   = document.getElementById('error-title');
const errorMsg     = document.getElementById('error-message');
const retryBtn     = document.getElementById('retry-btn');
const cardTpl      = document.getElementById('card-template');

let lastQuery = '';
let searchDebounce = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function showSection(which) {
  resultsSection.style.display = 'none';
  emptyState.style.display     = 'none';
  errorState.style.display     = 'none';
  if (which) which.style.display = '';
}

function setSearchLoading(loading) {
  searchBtn.disabled = loading;
  searchBtnTxt.style.display = loading ? 'none' : '';
  searchBtnLdr.style.display = loading ? '' : 'none';
}

function skeletonCards(n = 6) {
  resultsGrid.innerHTML = '';
  for (let i = 0; i < n; i++) {
    resultsGrid.insertAdjacentHTML('beforeend', `
      <div class="skel-card">
        <div class="skeleton skel-thumb"></div>
        <div class="skel-body">
          <div class="skeleton skel-line"></div>
          <div class="skeleton skel-line skel-short"></div>
          <div class="skel-btns">
            <div class="skeleton skel-btn"></div>
            <div class="skeleton skel-btn"></div>
          </div>
        </div>
      </div>`);
  }
  showSection(resultsSection);
}

function formatViews(v) {
  if (!v) return '';
  const n = parseInt(v.replace(/,/g, ''), 10);
  if (isNaN(n)) return v;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B views`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(0)}K views`;
  return `${n} views`;
}

// ─── Render Results ──────────────────────────────────────────────────────────

function renderResults(videos) {
  resultsGrid.innerHTML = '';

  if (!videos || videos.length === 0) {
    showSection(emptyState);
    return;
  }

  showSection(resultsSection);
  resultsCount.textContent = `${videos.length} result${videos.length !== 1 ? 's' : ''}`;

  videos.forEach((video, idx) => {
    const clone = cardTpl.content.cloneNode(true);
    const card  = clone.querySelector('.result-card');

    // Thumbnail
    const thumb = clone.querySelector('.card-thumb');
    thumb.src = video.thumbnail || `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`;
    thumb.alt = video.title;
    thumb.onerror = () => { thumb.src = `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`; };

    // Duration
    clone.querySelector('.card-duration').textContent = video.duration || '';

    // YouTube link
    const ytLink = clone.querySelector('.card-yt-link');
    ytLink.href = `https://www.youtube.com/watch?v=${video.id}`;

    // Title
    clone.querySelector('.card-title').textContent = video.title;

    // Meta
    clone.querySelector('.card-channel').textContent = video.channel;

    const viewsEl = clone.querySelector('.card-views');
    const formattedViews = formatViews(video.views);
    viewsEl.textContent = formattedViews;
    if (!formattedViews) viewsEl.style.display = 'none';

    const uploadedEl = clone.querySelector('.card-uploaded');
    uploadedEl.textContent = video.uploadedAt || '';
    if (!video.uploadedAt) uploadedEl.style.display = 'none';

    // Download buttons
    const statusEl = clone.querySelector('.card-dl-status');
    const mp3Btn   = clone.querySelector('.dl-mp3');
    const mp4Btn   = clone.querySelector('.dl-mp4');

    [mp3Btn, mp4Btn].forEach((btn) => {
      btn.addEventListener('click', () => {
        triggerDownload(video, btn.dataset.format, mp3Btn, mp4Btn, statusEl);
      });
    });

    card.style.animationDelay = `${Math.min(idx * 0.04, 0.2)}s`;
    resultsGrid.appendChild(clone);
  });
}

// ─── Download ────────────────────────────────────────────────────────────────

function triggerDownload(video, format, mp3Btn, mp4Btn, statusEl) {
  const activeBtn = format === 'mp3' ? mp3Btn : mp4Btn;
  const label = activeBtn.querySelector('.btn-label');
  const origLabel = label.textContent;

  // Lock UI
  mp3Btn.disabled = true;
  mp4Btn.disabled = true;
  activeBtn.classList.add('loading');
  label.textContent = 'Preparing';
  statusEl.style.display = '';
  statusEl.className = 'card-dl-status busy';
  statusEl.textContent = `⏳ Downloading ${format.toUpperCase()}… This may take a moment.`;

  const params = new URLSearchParams({
    videoId: video.id,
    format,
    title: video.title,
  });

  const url = `/api/download?${params}`;

  // Use fetch then create an object URL for the blob (shows progress)
  fetch(url)
    .then(async (res) => {
      if (!res.ok) {
        let msg = `Server error ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
        throw new Error(msg);
      }

      // Extract filename from header
      const disposition = res.headers.get('Content-Disposition') || '';
      let filename = `${video.title}.${format}`;
      const match = disposition.match(/filename="?([^"]+)"?/);
      if (match) {
        try { filename = decodeURIComponent(match[1]); } catch (_) {}
      }

      // Stream into a blob (needed to trigger save dialog)
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      return filename;
    })
    .then((filename) => {
      activeBtn.classList.remove('loading');
      activeBtn.classList.add('success');
      label.textContent = origLabel;
      statusEl.className = 'card-dl-status done';
      statusEl.textContent = `✅ Downloaded: ${filename}`;

      setTimeout(() => {
        activeBtn.classList.remove('success');
        mp3Btn.disabled = false;
        mp4Btn.disabled = false;
        setTimeout(() => {
          statusEl.style.display = 'none';
          statusEl.className = 'card-dl-status';
        }, 4000);
      }, 2000);
    })
    .catch((err) => {
      console.error('Download error:', err);
      activeBtn.classList.remove('loading');
      activeBtn.classList.add('error');
      label.textContent = origLabel;
      statusEl.className = 'card-dl-status fail';
      statusEl.textContent = `❌ Failed: ${err.message}`;

      setTimeout(() => {
        activeBtn.classList.remove('error');
        mp3Btn.disabled = false;
        mp4Btn.disabled = false;
      }, 3000);
    });
}

// ─── Search ──────────────────────────────────────────────────────────────────

async function doSearch(query) {
  query = query.trim();
  if (!query) return;
  lastQuery = query;

  // Update URL without reload
  history.replaceState(null, '', `?q=${encodeURIComponent(query)}`);

  resultsQueryLbl.textContent = `"${query}"`;
  setSearchLoading(true);
  skeletonCards(6);

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    renderResults(data.results);
  } catch (err) {
    console.error('Search failed:', err);
    errorTitle.textContent = 'Search failed';
    errorMsg.textContent = err.message || 'Could not reach the server. Make sure it is running.';
    showSection(errorState);
  } finally {
    setSearchLoading(false);
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

searchBtn.addEventListener('click', () => doSearch(searchInput.value));

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch(searchInput.value);
});

searchInput.addEventListener('input', () => {
  clearBtn.style.display = searchInput.value ? '' : 'none';
});

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearBtn.style.display = 'none';
  searchInput.focus();
  showSection(null);
  history.replaceState(null, '', location.pathname);
});

retryBtn.addEventListener('click', () => {
  if (lastQuery) doSearch(lastQuery);
});

// ─── On Load: restore search from URL params ──────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  if (q) {
    searchInput.value = q;
    clearBtn.style.display = '';
    doSearch(q);
  }
  // Autofocus search
  searchInput.focus();
});
