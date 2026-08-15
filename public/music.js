(function () {
  const PLAYLIST = 'PLAPpNTL9QCDvosgGmDoN0v8YwDFtBBo1n';
  const FIRST = 'CoJxgs3yneI';
  let player = null;
  let ready = false;
  let wantPlay = false;
  let apiLoading = false;

  function loadSettings() {
    try {
      return Object.assign({ music: true, musicVol: 35 }, JSON.parse(localStorage.getItem('pdg_settings') || '{}'));
    } catch (_) {
      return { music: true, musicVol: 35 };
    }
  }

  function vol() {
    const v = Number(loadSettings().musicVol);
    return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 35));
  }

  function ensureApi() {
    if (window.YT && window.YT.Player) return;
    if (apiLoading) return;
    apiLoading = true;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }

  function mount() {
    if (player || !window.YT || !window.YT.Player) return;
    let box = document.getElementById('ytbg');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ytbg';
      box.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(box);
    }
    player = new window.YT.Player('ytbg', {
      height: '1',
      width: '1',
      videoId: FIRST,
      playerVars: {
        listType: 'playlist',
        list: PLAYLIST,
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        playsinline: 1,
        rel: 0,
        loop: 1
      },
      events: {
        onReady: function () {
          ready = true;
          apply();
          if (wantPlay && loadSettings().music) safePlay();
        },
        onStateChange: function (e) {
          if (e.data === window.YT.PlayerState.ENDED && player && player.nextVideo) player.nextVideo();
        }
      }
    });
  }

  function safePlay() {
    if (!player || !ready) return;
    try {
      player.setVolume(vol());
      player.unMute();
      player.playVideo();
    } catch (_) {}
  }

  function apply() {
    if (!player || !ready) return;
    const s = loadSettings();
    try {
      player.setVolume(vol());
      if (!s.music || vol() === 0) player.pauseVideo();
      else if (wantPlay) safePlay();
    } catch (_) {}
  }

  function start() {
    wantPlay = true;
    ensureApi();
    if (window.YT && window.YT.Player) mount();
    apply();
    if (ready && loadSettings().music) safePlay();
  }

  function next() { start(); if (player && player.nextVideo) player.nextVideo(); }
  function prev() { start(); if (player && player.previousVideo) player.previousVideo(); }

  function trackName() {
    try {
      const d = player && player.getVideoData && player.getVideoData();
      return (d && d.title) || 'Playlist YouTube';
    } catch (_) {
      return 'Playlist YouTube';
    }
  }

  window.onYouTubeIframeAPIReady = function () { mount(); };
  window.PDGMusic = { start, apply, next, prev, trackName, list: [{ name: 'Playlist YouTube' }] };
  document.addEventListener('pointerdown', start, { once: true });
})();
