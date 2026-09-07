/**
 * AeroSpeed GPS - Precision Speedometer & Telematics Engine
 * Handles GPS Geolocation, Doppler/Haversine velocity estimation,
 * Kalman speed smoothing, Analog Canvas Gauge rendering,
 * Performance 0-60/0-100 timer, Web Audio alarm, and Desktop Simulator.
 */

class SpeedometerEngine {
  constructor() {
    // Current state
    this.speed = 0; // stored internally in km/h
    this.unit = 'kmh'; // 'kmh', 'mph', 'knots', 'ms'
    this.maxSpeed = 0;
    this.avgSpeed = 0;
    this.tripDistance = 0; // km
    this.tripTime = 0; // seconds
    this.altitude = 0; // meters
    this.heading = 0; // degrees
    this.accuracy = 0; // meters
    
    // Performance timer
    this.timerActive = false;
    this.timerTarget = 60; // target in current unit (e.g., 60 mph or 100 km/h)
    this.timerStartTime = null;
    this.timerElapsed = 0;
    this.timerHistory = [];

    // Speed Warning
    this.speedLimit = 80; // in current unit
    this.warningActive = false;
    this.lastAlarmBeep = 0;
    this.audioCtx = null;

    // Simulation & Tracking state
    this.isTracking = false;
    this.isSimulating = false;
    this.watchId = null;
    this.tripInterval = null;
    this.simInterval = null;
    this.lastPosition = null;

    // Smoothing filter
    this.smoothedSpeed = 0;
    this.filterFactor = 0.35; // Exponential smoothing factor

    // Trip Points for export
    this.tripLogs = [];

    // Canvas Gauge
    this.canvas = document.getElementById('speedGaugeCanvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.targetGaugeSpeed = 0;
    this.displayedGaugeSpeed = 0;

    this.initCanvas();
    this.startGaugeAnimation();
  }

  // Unit conversion multipliers from km/h
  static get CONVERSIONS() {
    return {
      kmh: { factor: 1.0, label: 'KM/H', maxDial: 240, step: 20 },
      mph: { factor: 0.621371, label: 'MPH', maxDial: 160, step: 20 },
      knots: { factor: 0.539957, label: 'KTS', maxDial: 130, step: 10 },
      ms: { factor: 0.277778, label: 'M/S', maxDial: 70, step: 10 }
    };
  }

  setUnit(newUnit) {
    if (SpeedometerEngine.CONVERSIONS[newUnit]) {
      this.unit = newUnit;
      this.updateUI();
    }
  }

  setSpeedLimit(limit) {
    this.speedLimit = parseFloat(limit) || 0;
  }

  // ==========================================
  // Location Permission & In-App Alerts
  // ==========================================
  showLocationAlert(title, text, type = 'warning') {
    const banner = document.getElementById('locationAlertBanner');
    const titleEl = document.getElementById('locationAlertTitle');
    const textEl = document.getElementById('locationAlertText');
    const iconEl = document.getElementById('locationAlertIcon');
    if (!banner) return;

    banner.className = `location-alert-banner ${type}`;
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.innerHTML = text;
    if (iconEl) {
      iconEl.textContent = type === 'error' ? '🚫' : (type === 'success' ? '✅' : '📍');
    }
    banner.style.display = 'flex';
  }

  hideLocationAlert() {
    const banner = document.getElementById('locationAlertBanner');
    if (banner) banner.style.display = 'none';
  }

  // ==========================================
  // GPS Geolocation Tracking
  // ==========================================
  startTracking() {
    if (!('geolocation' in navigator)) {
      this.showLocationAlert(
        'Geolocation API Unsupported',
        'Your browser does not support the W3C Geolocation API. Please use a modern browser such as Google Chrome, Safari, or Microsoft Edge.',
        'error'
      );
      return false;
    }

    this.isTracking = true;
    this.isSimulating = false;
    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = null;
    }

    const badge = document.getElementById('gpsStatusBadge');
    if (badge) {
      badge.className = 'badge badge-gps-searching';
      badge.innerHTML = '<span class="badge-dot"></span> ACQUIRING GPS FIX...';
    }

    // Check permissions query if supported
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then((result) => {
        if (result.state === 'denied') {
          this.handleGPSError({ code: 1, message: 'User denied Geolocation' });
        } else if (result.state === 'prompt') {
          this.showLocationAlert(
            'Location Permission Required',
            'Please click <strong>Allow</strong> in your browser\'s location permission prompt to start reading live satellite velocity.',
            'warning'
          );
        }
      }).catch(() => {});
    }

    this.startTripTimer();

    const options = {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000
    };

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handleGPSPosition(pos),
      (err) => this.handleGPSError(err),
      options
    );

    return true;
  }

  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.isTracking = false;
    this.speed = 0;
    this.smoothedSpeed = 0;
    this.stopTripTimer();
    this.hideLocationAlert();
    this.updateStatusBadge();
    this.updateUI();
  }

  handleGPSPosition(position) {
    const coords = position.coords;
    let rawSpeedKmh = 0;

    // Direct Doppler velocity from hardware satellite receiver (in m/s)
    if (coords.speed !== null && !isNaN(coords.speed) && coords.speed >= 0) {
      if (coords.speed < 0.35) {
        // Stationary filter (< 1.25 km/h) -> Filter stationary desk/hand jitter to solid 0
        rawSpeedKmh = 0;
      } else {
        rawSpeedKmh = coords.speed * 3.6;
      }
    } else if (this.lastPosition) {
      // Fallback: Haversine distance / time delta
      const timeDelta = (position.timestamp - this.lastPosition.timestamp) / 1000;
      if (timeDelta > 0.8) {
        const distKm = this.calculateHaversine(
          this.lastPosition.coords.latitude,
          this.lastPosition.coords.longitude,
          coords.latitude,
          coords.longitude
        );
        const distMeters = distKm * 1000;
        const noiseRadius = Math.max(3.0, (coords.accuracy || 10) * 0.4);

        if (distMeters < noiseRadius) {
          // Movement is within stationary GPS uncertainty circle -> 0 km/h
          rawSpeedKmh = 0;
        } else {
          const calculatedSpeed = (distKm / timeDelta) * 3600;
          if (calculatedSpeed < 1.8) {
            rawSpeedKmh = 0;
          } else if (calculatedSpeed > 350) {
            // Discard single-sample GPS teleport glitch
            rawSpeedKmh = this.smoothedSpeed;
          } else {
            rawSpeedKmh = calculatedSpeed;
          }
        }
      }
    } else {
      rawSpeedKmh = 0;
    }

    // Apply Kalman / exponential smoothing filter
    if (rawSpeedKmh === 0) {
      this.smoothedSpeed = 0;
      this.speed = 0;
    } else {
      this.smoothedSpeed = (this.filterFactor * rawSpeedKmh) + ((1 - this.filterFactor) * this.smoothedSpeed);
      this.speed = Math.max(0, this.smoothedSpeed);
    }

    // Update telemetry coordinates
    this.altitude = coords.altitude !== null ? coords.altitude : 0;
    this.heading = coords.heading !== null && !isNaN(coords.heading) ? coords.heading : 0;
    this.accuracy = coords.accuracy || 0;

    // Calculate real distance only when truly in motion
    if (this.lastPosition && this.speed > 1.0) {
      const dist = this.calculateHaversine(
        this.lastPosition.coords.latitude,
        this.lastPosition.coords.longitude,
        coords.latitude,
        coords.longitude
      );
      if (!isNaN(dist) && dist > 0.003) {
        this.tripDistance += dist;
      }
    }

    this.lastPosition = position;
    this.hideLocationAlert();

    const badge = document.getElementById('gpsStatusBadge');
    if (badge && this.isTracking) {
      badge.className = 'badge badge-gps-active';
      badge.innerHTML = `<span class="badge-dot"></span> GPS LOCKED (±${Math.round(this.accuracy)}m)`;
    }

    this.recordMetrics();
    this.checkPerformanceTimer();
    this.checkSpeedWarning();
    this.updateUI();
  }

  handleGPSError(error) {
    console.warn('GPS Error:', error.code, error.message);
    const badge = document.getElementById('gpsStatusBadge');
    const btnStartGps = document.getElementById('btnStartGps');
    const btnStopGps = document.getElementById('btnStopGps');

    if (error.code === 1) {
      // PERMISSION_DENIED
      this.isTracking = false;
      this.stopTripTimer();
      if (btnStartGps) btnStartGps.style.display = 'inline-flex';
      if (btnStopGps) btnStopGps.style.display = 'none';

      if (badge) {
        badge.className = 'badge badge-gps-denied';
        badge.innerHTML = '<span class="badge-dot"></span> LOCATION PERMISSION BLOCKED';
      }

      this.showLocationAlert(
        'Location Access Denied in Browser',
        'AeroSpeed cannot calculate live speed without GPS permission. Please click the site settings/lock icon in your browser address bar and set <strong>Location</strong> to <strong>Allow</strong>, then refresh or click START GPS TRACKING.',
        'error'
      );
    } else if (error.code === 2) {
      // POSITION_UNAVAILABLE
      if (badge) {
        badge.className = 'badge badge-gps-searching';
        badge.innerHTML = '<span class="badge-dot"></span> SEARCHING SATELLITES...';
      }
      this.showLocationAlert(
        'Searching for GPS Satellite Fix',
        'Satellite signal is weak or obstructed. If you are indoors, please step near a window or move outdoors for clear line-of-sight to GNSS satellites.',
        'warning'
      );
    } else if (error.code === 3) {
      // TIMEOUT
      if (badge) {
        badge.className = 'badge badge-gps-searching';
        badge.innerHTML = '<span class="badge-dot"></span> GPS TIMEOUT (RETRYING...)';
      }
    }
  }

  // Haversine Great-Circle Distance
  calculateHaversine(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // ==========================================
  // Desktop Simulation Engine
  // ==========================================
  startSimulation() {
    this.stopTracking();
    this.isSimulating = true;
    if (typeof this.targetSimSpeed === 'undefined' || this.targetSimSpeed === null) {
      this.targetSimSpeed = 65; // default km/h
    }
    this.startTripTimer();
    this.updateStatusBadge();

    if (this.simInterval) clearInterval(this.simInterval);
    this.simInterval = setInterval(() => {
      // Smoothly approach target speed
      const delta = (this.targetSimSpeed - this.speed) * 0.15;
      this.speed = Math.max(0, this.speed + delta);

      // Add simulated distance (100ms = 0.1 sec = 0.1 / 3600 hrs)
      const hourFraction = (0.1 / 3600);
      this.tripDistance += this.speed * hourFraction;

      // Simulated altitude and heading fluctuation
      this.heading = (this.heading + 0.2) % 360;
      this.altitude = 45 + Math.sin(Date.now() / 5000) * 8;
      this.accuracy = 2.4;

      this.recordMetrics();
      this.checkPerformanceTimer();
      this.checkSpeedWarning();
      this.updateUI();
    }, 100);
  }

  setSimTargetSpeed(speedInCurrentUnit) {
    const conf = SpeedometerEngine.CONVERSIONS[this.unit];
    const speedKmh = speedInCurrentUnit / conf.factor;
    this.targetSimSpeed = Math.max(0, speedKmh);
  }

  stopSimulation() {
    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = null;
    }
    this.isSimulating = false;
    this.speed = 0;
    this.stopTripTimer();
    this.updateStatusBadge();
    this.updateUI();
  }

  // ==========================================
  // Trip Logging & Statistics
  // ==========================================
  startTripTimer() {
    if (this.tripInterval) clearInterval(this.tripInterval);
    this.tripInterval = setInterval(() => {
      this.tripTime += 1;
      this.updateTripTimeDisplay();
    }, 1000);
  }

  stopTripTimer() {
    if (this.tripInterval) {
      clearInterval(this.tripInterval);
      this.tripInterval = null;
    }
  }

  resetTrip() {
    this.tripDistance = 0;
    this.tripTime = 0;
    this.maxSpeed = this.speed;
    this.avgSpeed = 0;
    this.tripLogs = [];
    this.updateTripTimeDisplay();
    this.updateUI();
  }

  recordMetrics() {
    if (this.speed > this.maxSpeed) {
      this.maxSpeed = this.speed;
    }

    if (this.tripTime > 0) {
      // avgSpeed in km/h = total km / total hours
      const totalHours = this.tripTime / 3600;
      this.avgSpeed = this.tripDistance / totalHours;
    } else {
      this.avgSpeed = 0;
    }

    // Log for CSV export every 5 seconds
    if (this.tripTime % 5 === 0 && this.speed > 0) {
      this.tripLogs.push({
        time: new Date().toISOString(),
        speedKmh: this.speed.toFixed(2),
        altitudeM: this.altitude.toFixed(1),
        headingDeg: this.heading.toFixed(0),
        distKm: this.tripDistance.toFixed(3)
      });
    }
  }

  exportTripCSV() {
    if (this.tripLogs.length === 0) {
      alert('No trip data points recorded yet. Drive or run simulation first.');
      return;
    }

    let csvContent = 'data:text/csv;charset=utf-8,Timestamp,Speed_KMH,Altitude_M,Heading_Deg,Distance_KM\n';
    this.tripLogs.forEach(row => {
      csvContent += `${row.time},${row.speedKmh},${row.altitudeM},${row.headingDeg},${row.distKm}\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `aerospeed_trip_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ==========================================
  // Acceleration Performance Timer (0-60 / 0-100)
  // ==========================================
  startPerformanceTimer(targetSpeed) {
    this.timerTarget = targetSpeed;
    this.timerActive = true;
    this.timerStartTime = null;
    this.timerElapsed = 0;

    const timerValEl = document.getElementById('perfTimerValue');
    if (timerValEl) timerValEl.textContent = 'WAITING FOR LAUNCH';
  }

  checkPerformanceTimer() {
    if (!this.timerActive) return;

    const conf = SpeedometerEngine.CONVERSIONS[this.unit];
    const currentDisplaySpeed = this.speed * conf.factor;

    // Detect launch
    if (!this.timerStartTime && currentDisplaySpeed > 1) {
      this.timerStartTime = performance.now();
    }

    if (this.timerStartTime) {
      const now = performance.now();
      this.timerElapsed = ((now - this.timerStartTime) / 1000).toFixed(2);
      const timerValEl = document.getElementById('perfTimerValue');
      if (timerValEl) timerValEl.textContent = `${this.timerElapsed}s`;

      // Target reached
      if (currentDisplaySpeed >= this.timerTarget) {
        this.timerActive = false;
        this.timerHistory.push({
          target: `${this.timerTarget} ${conf.label}`,
          time: `${this.timerElapsed}s`,
          date: new Date().toLocaleTimeString()
        });
        this.renderTimerHistory();
        this.playBeep(880, 0.4); // Confirmation high beep
      }
    }
  }

  renderTimerHistory() {
    const listEl = document.getElementById('perfTimerHistoryList');
    if (!listEl) return;
    listEl.innerHTML = this.timerHistory.map(item => `
      <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:0.85rem;">
        <span>0-${item.target}</span>
        <strong style="color:var(--accent-green);">${item.time}</strong>
        <span style="color:var(--text-muted); font-size:0.75rem;">${item.date}</span>
      </div>
    `).join('');
  }

  // ==========================================
  // Overspeed Alert & Web Audio Synthesizer
  // ==========================================
  checkSpeedWarning() {
    const conf = SpeedometerEngine.CONVERSIONS[this.unit];
    const currentDisplaySpeed = this.speed * conf.factor;
    const alertEl = document.getElementById('speedWarningAlert');

    if (this.speedLimit > 0 && currentDisplaySpeed > this.speedLimit) {
      this.warningActive = true;
      if (alertEl) {
        alertEl.classList.add('active');
        alertEl.textContent = `⚠️ SPEED LIMIT EXCEEDED (${Math.round(currentDisplaySpeed)} / ${this.speedLimit} ${conf.label})`;
      }

      // Play beep every 1.2 seconds
      const now = Date.now();
      if (now - this.lastAlarmBeep > 1200) {
        this.playBeep(750, 0.2);
        this.lastAlarmBeep = now;
      }
    } else {
      this.warningActive = false;
      if (alertEl) {
        alertEl.classList.remove('active');
      }
    }
  }

  playBeep(freq = 600, duration = 0.15) {
    try {
      if (!this.audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) this.audioCtx = new AudioContext();
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      if (!this.audioCtx) return;

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);
      gain.gain.setValueAtTime(0.1, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + duration);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start();
      osc.stop(this.audioCtx.currentTime + duration);
    } catch (e) {
      // Silent catch on browser audio block
    }
  }

  // ==========================================
  // Canvas Gauge Rendering & Micro-Animations
  // ==========================================
  initCanvas() {
    if (!this.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = 360 * dpr;
    this.canvas.height = 360 * dpr;
    if (this.ctx) this.ctx.scale(dpr, dpr);
  }

  startGaugeAnimation() {
    const render = () => {
      const conf = SpeedometerEngine.CONVERSIONS[this.unit];
      this.targetGaugeSpeed = this.speed * conf.factor;

      // Smooth needle interpolation
      this.displayedGaugeSpeed += (this.targetGaugeSpeed - this.displayedGaugeSpeed) * 0.12;

      this.drawAnalogGauge();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }

  drawAnalogGauge() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const width = 360;
    const height = 360;
    const cx = width / 2;
    const cy = height / 2;
    const radius = 145;

    ctx.clearRect(0, 0, width, height);

    const conf = SpeedometerEngine.CONVERSIONS[this.unit];
    const maxVal = conf.maxDial;

    // Gauge Arc Angles (from 135 deg to 405 deg / 270 deg span)
    const startAngle = 0.75 * Math.PI;
    const endAngle = 2.25 * Math.PI;
    const totalAngle = 1.5 * Math.PI;

    // 1. Background Track
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.stroke();

    // 2. Active Speed Glow Arc
    const currentPercent = Math.min(1, Math.max(0, this.displayedGaugeSpeed / maxVal));
    const activeEndAngle = startAngle + (totalAngle * currentPercent);

    if (currentPercent > 0.005) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, activeEndAngle);

      // Dynamic Gradient based on speed
      const grad = ctx.createConicGradient(startAngle, cx, cy);
      grad.addColorStop(0, '#00f2fe');
      grad.addColorStop(0.5, '#4facfe');
      grad.addColorStop(0.85, '#ffb703');
      grad.addColorStop(1, '#ff3366');

      ctx.strokeStyle = grad;
      ctx.lineWidth = 14;
      ctx.lineCap = 'round';
      ctx.shadowColor = this.warningActive ? '#ff3366' : '#00f2fe';
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.shadowBlur = 0; // Reset
    }

    // 3. Tick Marks & Numbers
    const step = conf.step;
    for (let val = 0; val <= maxVal; val += (step / 2)) {
      const isMajor = (val % step === 0);
      const angle = startAngle + ((val / maxVal) * totalAngle);
      const innerR = isMajor ? radius - 26 : radius - 18;
      const outerR = radius - 10;

      const x1 = cx + Math.cos(angle) * innerR;
      const y1 = cy + Math.sin(angle) * innerR;
      const x2 = cx + Math.cos(angle) * outerR;
      const y2 = cy + Math.sin(angle) * outerR;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = isMajor ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = isMajor ? 2.5 : 1.2;
      ctx.stroke();

      if (isMajor) {
        const textR = radius - 38;
        const tx = cx + Math.cos(angle) * textR;
        const ty = cy + Math.sin(angle) * textR;
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillStyle = 'rgba(148, 163, 184, 0.8)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(val.toString(), tx, ty);
      }
    }

    // 4. Center Needle Pointer
    const needleAngle = startAngle + (currentPercent * totalAngle);
    const needleLen = radius - 25;
    const nx = cx + Math.cos(needleAngle) * needleLen;
    const ny = cy + Math.sin(needleAngle) * needleLen;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(nx, ny);
    ctx.strokeStyle = this.warningActive ? '#ff3366' : '#00f2fe';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = this.warningActive ? '#ff3366' : '#00f2fe';
    ctx.shadowBlur = 15;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Needle Center Cap
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, 2 * Math.PI);
    ctx.fillStyle = '#141c2e';
    ctx.fill();
    ctx.strokeStyle = '#00f2fe';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // ==========================================
  // UI Synchronization
  // ==========================================
  updateUI() {
    const conf = SpeedometerEngine.CONVERSIONS[this.unit];
    const displaySpeed = Math.round(this.speed * conf.factor);
    const displayMax = Math.round(this.maxSpeed * conf.factor);
    const displayAvg = Math.round(this.avgSpeed * conf.factor);
    const displayDist = (this.tripDistance * (this.unit === 'mph' ? 0.621371 : 1)).toFixed(2);
    const distUnit = this.unit === 'mph' ? 'MI' : 'KM';

    // Main Digital Speed
    const speedEl = document.getElementById('digitalSpeedDisplay');
    if (speedEl) speedEl.textContent = displaySpeed.toString();

    const unitEl = document.getElementById('speedUnitDisplay');
    if (unitEl) unitEl.textContent = conf.label;

    // Telemetry Cards
    const maxSpeedEl = document.getElementById('telemetryMaxSpeed');
    if (maxSpeedEl) maxSpeedEl.textContent = displayMax.toString();

    const avgSpeedEl = document.getElementById('telemetryAvgSpeed');
    if (avgSpeedEl) avgSpeedEl.textContent = displayAvg.toString();

    const distEl = document.getElementById('telemetryDistance');
    if (distEl) distEl.textContent = displayDist.toString();

    const distUnitEl = document.getElementById('telemetryDistanceUnit');
    if (distUnitEl) distUnitEl.textContent = distUnit;

    const altEl = document.getElementById('telemetryAltitude');
    if (altEl) altEl.textContent = Math.round(this.altitude).toString();

    const headEl = document.getElementById('telemetryHeading');
    if (headEl) headEl.textContent = `${Math.round(this.heading)}° ${this.getCompassDirection(this.heading)}`;

    const accEl = document.getElementById('telemetryAccuracy');
    if (accEl) accEl.textContent = `±${this.accuracy.toFixed(1)}m`;
  }

  getCompassDirection(deg) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(deg / 45) % 8;
    return dirs[idx] || 'N';
  }

  updateTripTimeDisplay() {
    const timeEl = document.getElementById('telemetryTripTime');
    if (!timeEl) return;
    const hrs = Math.floor(this.tripTime / 3600);
    const mins = Math.floor((this.tripTime % 3600) / 60);
    const secs = this.tripTime % 60;
    timeEl.textContent = `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  updateStatusBadge() {
    const badge = document.getElementById('gpsStatusBadge');
    if (!badge) return;

    if (this.isTracking) {
      badge.className = 'badge badge-gps-active';
      badge.innerHTML = '<span class="badge-dot"></span> GPS LIVE TRACKING';
    } else if (this.isSimulating) {
      badge.className = 'badge badge-simulating';
      badge.innerHTML = '<span class="badge-dot"></span> SIMULATION MODE';
    } else {
      badge.className = 'badge badge-gps-inactive';
      badge.innerHTML = '<span class="badge-dot"></span> GPS STANDBY';
    }
  }
}

window.SpeedometerEngine = SpeedometerEngine;
