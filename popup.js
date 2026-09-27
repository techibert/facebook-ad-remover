const HINTS = {
  off: 'Ads are shown normally.',
  grey: 'Ads are greyed out with a red outline so you can check detection.',
  hide: 'Ads are removed from the page; ad reels are skipped.',
};

const hint = document.getElementById('hint');
const radios = document.querySelectorAll('input[name="mode"]');

function show(mode) {
  for (const r of radios) r.checked = r.value === mode;
  hint.textContent = HINTS[mode];
}

chrome.storage.sync.get({ mode: 'grey' }, ({ mode }) => show(mode));

for (const r of radios) {
  r.addEventListener('change', () => {
    chrome.storage.sync.set({ mode: r.value });
    show(r.value);
  });
}

async function refreshCounts() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const counts = await chrome.tabs.sendMessage(tab.id, { type: 'far:count' });
    for (const key of ['feed', 'sidebar', 'marketplace', 'reel']) {
      document.getElementById(key).textContent = counts[key];
    }
  } catch {
    document.getElementById('stats').hidden = true;
    hint.textContent = 'Open facebook.com to use this extension.';
  }
}

refreshCounts();
setInterval(refreshCounts, 1000);
