(() => {
  const INIT_KEY = '__acamind_overrides_init_v2';
  if (window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  const STORAGE_KEY = 'acamind_collapse_state_v1';
  const UPLOAD_FLASH_CLASS = 'sci-upload-flash';
  let uploadFlashTimer = null;

  function loadState() {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // ignore
    }
    return {};
  }

  function saveState(state) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }

  function shouldForceOpen(detailsEl) {
    try {
      if (!detailsEl) return false;
      if (detailsEl.closest('.sci-paper-item--translating')) return true;
      if (detailsEl.querySelector('.sci-paper-item--translating')) return true;
    } catch {
      // ignore
    }
    return false;
  }

  function initDetails(detailsEl) {
    if (!(detailsEl instanceof HTMLDetailsElement)) return;
    if (!detailsEl.classList.contains('sci-collapse')) return;

    const id = (detailsEl.getAttribute('id') || '').trim();
    if (!id) return;
    if (detailsEl.dataset.sciCollapseInit === '1') return;

    const state = loadState();
    const forced = shouldForceOpen(detailsEl);
    if (forced) {
      detailsEl.open = true;
      state[id] = true;
      saveState(state);
    } else if (Object.prototype.hasOwnProperty.call(state, id)) {
      detailsEl.open = !!state[id];
    } else {
      state[id] = !!detailsEl.open;
      saveState(state);
    }

    const syncPaperOpenClass = () => {
      const paperItem = detailsEl.closest('.sci-paper-item');
      if (!(paperItem instanceof HTMLElement)) return;
      if (detailsEl.open) {
        paperItem.classList.add('sci-paper-item--open-live');
      } else {
        paperItem.classList.remove('sci-paper-item--open-live');
      }
    };

    syncPaperOpenClass();

    detailsEl.addEventListener('toggle', () => {
      const next = loadState();
      const forcedNow = shouldForceOpen(detailsEl);
      if (forcedNow) {
        detailsEl.open = true;
        next[id] = true;
      } else {
        next[id] = !!detailsEl.open;
      }
      saveState(next);
      syncPaperOpenClass();
    });

    detailsEl.dataset.sciCollapseInit = '1';
  }

  function scan(root) {
    if (!(root instanceof Element)) return;
    if (root.matches('details.sci-collapse')) {
      initDetails(root);
    }
    root.querySelectorAll('details.sci-collapse').forEach((el) => initDetails(el));
  }

  function findUploadButton() {
    const btn =
      document.getElementById('upload-button') ||
      document.getElementById('upload-button-loading');
    return btn instanceof HTMLElement ? btn : null;
  }

  function findUploadInput() {
    const byId = document.getElementById('upload-button-input');
    if (byId instanceof HTMLInputElement) return byId;
    const any = document.querySelector('input[type="file"]');
    return any instanceof HTMLInputElement ? any : null;
  }

  function flashUploadButton() {
    const btn = findUploadButton();
    if (!btn) return;
    try {
      btn.classList.add(UPLOAD_FLASH_CLASS);
      btn.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch {
      // ignore
    }
    if (uploadFlashTimer) window.clearTimeout(uploadFlashTimer);
    uploadFlashTimer = window.setTimeout(() => {
      try {
        btn.classList.remove(UPLOAD_FLASH_CLASS);
      } catch {
        // ignore
      }
      uploadFlashTimer = null;
    }, 1200);
  }

  function onRootClick(ev) {
    try {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const upload = target.closest('[data-sci-upload="pdf"]');
      if (!upload) return;

      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === 'function') {
        ev.stopImmediatePropagation();
      }

      flashUploadButton();

      const btn = findUploadButton();
      if (btn && typeof btn.click === 'function') {
        btn.click();
        return;
      }

      const input = findUploadInput();
      if (input && typeof input.click === 'function') {
        input.click();
      }
    } catch {
      // ignore
    }
  }

  function setup() {
    const root = document.getElementById('root') || document.body;
    scan(root);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          scan(node);
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });

    root.addEventListener('click', onRootClick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup, { once: true });
  } else {
    setup();
  }
})();
