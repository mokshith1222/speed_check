/**
 * AeroSpeed GPS - Application UI Controller & Interactive Handlers
 */

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Core Telematics Engine if on speedometer tool page
  let engine = null;
  if (typeof SpeedometerEngine !== 'undefined') {
    engine = new SpeedometerEngine();
    window.aeroSpeedEngine = engine;
  }

  // DOM Elements
  const btnStartGps = document.getElementById('btnStartGps');
  const btnStopGps = document.getElementById('btnStopGps');
  const btnToggleHud = document.getElementById('btnToggleHud');
  const btnResetTrip = document.getElementById('btnResetTrip');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnToggleSim = document.getElementById('btnToggleSim');
  const simPanel = document.getElementById('simulatorPanel');
  const simSpeedSlider = document.getElementById('simSpeedSlider');
  const simSpeedVal = document.getElementById('simSpeedVal');
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const navMenu = document.getElementById('navMenu');
  const cookieBanner = document.getElementById('cookieConsentBanner');
  const btnAcceptCookies = document.getElementById('btnAcceptCookies');
  const btnStart060Timer = document.getElementById('btnStart060Timer');
  const speedLimitInput = document.getElementById('speedLimitInput');
  const btnDismissAlert = document.getElementById('btnDismissLocationAlert');

  // ==========================================
  // GPS Start / Stop Handlers & Location Alerts
  // ==========================================
  if (btnDismissAlert && engine) {
    btnDismissAlert.addEventListener('click', () => {
      engine.hideLocationAlert();
    });
  }

  if (btnStartGps && engine) {
    btnStartGps.addEventListener('click', () => {
      engine.startTracking();
      btnStartGps.style.display = 'none';
      btnStopGps.style.display = 'inline-flex';
      if (simPanel) {
        simPanel.style.display = 'none';
        if (btnToggleSim) btnToggleSim.classList.remove('active');
      }
    });
  }

  if (btnStopGps && engine) {
    btnStopGps.addEventListener('click', () => {
      engine.stopTracking();
      btnStopGps.style.display = 'none';
      btnStartGps.style.display = 'inline-flex';
    });
  }

  // ==========================================
  // Unit Switcher (KM/H, MPH, KTS, M/S)
  // ==========================================
  const unitButtons = document.querySelectorAll('.unit-seg-btn');
  unitButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      unitButtons.forEach(b => b.classList.remove('active'));
      const target = e.currentTarget;
      target.classList.add('active');
      const selectedUnit = target.getAttribute('data-unit');
      if (engine) engine.setUnit(selectedUnit);

      // Update simulation slider range & label
      if (simSpeedSlider && typeof SpeedometerEngine !== 'undefined') {
        const conf = SpeedometerEngine.CONVERSIONS[selectedUnit];
        simSpeedSlider.max = conf.maxDial;
      }
    });
  });

  // ==========================================
  // HUD Windshield Mirror Mode
  // ==========================================
  if (btnToggleHud) {
    btnToggleHud.addEventListener('click', () => {
      const appContainer = document.getElementById('speedometerAppWrapper');
      if (!appContainer) return;
      const isHud = appContainer.classList.toggle('hud-mode-active');
      btnToggleHud.classList.toggle('active', isHud);

      if (isHud) {
        btnToggleHud.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg> EXIT HUD`;
      } else {
        btnToggleHud.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg> HUD MODE`;
      }
    });
  }

  // ==========================================
  // Trip Reset & CSV Export
  // ==========================================
  if (btnResetTrip && engine) {
    btnResetTrip.addEventListener('click', () => {
      engine.resetTrip();
      const origHtml = btnResetTrip.innerHTML;
      btnResetTrip.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> CLEARED`;
      setTimeout(() => {
        btnResetTrip.innerHTML = origHtml;
      }, 1000);
    });
  }

  if (btnExportCsv && engine) {
    btnExportCsv.addEventListener('click', () => {
      engine.exportTripCSV();
    });
  }

  // ==========================================
  // Desktop Simulation Controls
  // ==========================================
  if (btnToggleSim && engine) {
    btnToggleSim.addEventListener('click', () => {
      if (simPanel.style.display === 'none' || !simPanel.style.display) {
        simPanel.style.display = 'flex';
        btnToggleSim.classList.add('active');
        engine.startSimulation();
        if (btnStartGps) btnStartGps.style.display = 'inline-flex';
        if (btnStopGps) btnStopGps.style.display = 'none';
      } else {
        simPanel.style.display = 'none';
        btnToggleSim.classList.remove('active');
        engine.stopSimulation();
      }
    });
  }

  if (simSpeedSlider && engine) {
    simSpeedSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (simSpeedVal) simSpeedVal.textContent = val.toString();
      engine.setSimTargetSpeed(val);
    });
  }

  // Simulation Presets
  const simPresets = document.querySelectorAll('.sim-preset-btn');
  simPresets.forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (!engine) return;
      const speed = parseFloat(e.currentTarget.getAttribute('data-speed'));
      if (simSpeedSlider) simSpeedSlider.value = speed;
      if (simSpeedVal) simSpeedVal.textContent = speed.toString();
      engine.setSimTargetSpeed(speed);
    });
  });

  // ==========================================
  // Performance 0-60 / 0-100 Acceleration Timer
  // ==========================================
  if (btnStart060Timer && engine) {
    btnStart060Timer.addEventListener('click', () => {
      const targetSpeed = engine.unit === 'mph' ? 60 : 100;
      engine.startPerformanceTimer(targetSpeed);
    });
  }

  // ==========================================
  // Speed Limit Alert Config
  // ==========================================
  if (speedLimitInput && engine) {
    speedLimitInput.addEventListener('change', (e) => {
      engine.setSpeedLimit(e.target.value);
    });
  }

  // ==========================================
  // Dark / Light Theme Toggle
  // ==========================================
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('aerospeed_theme', newTheme);
    });
  }

  // Restore saved theme
  const savedTheme = localStorage.getItem('aerospeed_theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }

  // ==========================================
  // FAQ Accordion Interaction
  // ==========================================
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const questionBtn = item.querySelector('.faq-question');
    if (questionBtn) {
      questionBtn.addEventListener('click', () => {
        const isOpen = item.classList.contains('open');
        // Close other items
        faqItems.forEach(i => i.classList.remove('open'));
        if (!isOpen) {
          item.classList.add('open');
        }
      });
    }
  });

  // ==========================================
  // Mobile Nav Toggle
  // ==========================================
  if (mobileMenuBtn && navMenu) {
    mobileMenuBtn.addEventListener('click', () => {
      const isVisible = navMenu.style.display === 'flex';
      navMenu.style.display = isVisible ? 'none' : 'flex';
      if (!isVisible) {
        navMenu.style.flexDirection = 'column';
        navMenu.style.position = 'absolute';
        navMenu.style.top = '72px';
        navMenu.style.left = '0';
        navMenu.style.right = '0';
        navMenu.style.background = 'var(--bg-secondary)';
        navMenu.style.padding = '1.5rem';
        navMenu.style.borderBottom = '1px solid var(--border-subtle)';
      }
    });
  }

  // ==========================================
  // Cookie Consent Compliance Banner
  // ==========================================
  if (cookieBanner && !localStorage.getItem('aerospeed_cookie_consent')) {
    cookieBanner.style.display = 'flex';
  } else if (cookieBanner) {
    cookieBanner.style.display = 'none';
  }

  if (btnAcceptCookies) {
    btnAcceptCookies.addEventListener('click', () => {
      localStorage.setItem('aerospeed_cookie_consent', 'true');
      if (cookieBanner) cookieBanner.style.display = 'none';
    });
  }

  // ==========================================
  // PWA Service Worker Registration
  // ==========================================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('AeroSpeed PWA Service Worker registered:', reg.scope))
        .catch(err => console.log('Service Worker registration skipped:', err));
    });
  }
});
