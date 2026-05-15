const startButton = document.querySelector('#start-button');
const stopButton = document.querySelector('#stop-button');
const screenshotButton = document.querySelector('#screenshot-button');
const refreshButton = document.querySelector('#refresh-button');
const revealButton = document.querySelector('#reveal-button');
const taskInput = document.querySelector('#task-input');
const outcomeSelect = document.querySelector('#outcome-select');
const notesInput = document.querySelector('#notes-input');
const intervalSelect = document.querySelector('#interval-select');
const videoSelect = document.querySelector('#video-select');
const recordingStatus = document.querySelector('#recording-status');
const previewPanel = document.querySelector('.preview-panel');
const previewStatus = document.querySelector('#preview-status');
const screenPreview = document.querySelector('#screen-preview');
const mouseCount = document.querySelector('#mouse-count');
const screenshotCount = document.querySelector('#screenshot-count');
const videoSize = document.querySelector('#video-size');
const chunkCount = document.querySelector('#chunk-count');
const sessionPath = document.querySelector('#session-path');
const activeApp = document.querySelector('#active-app');
const activeWindow = document.querySelector('#active-window');
const activeUrl = document.querySelector('#active-url');
const databasePath = document.querySelector('#database-path');
const duration = document.querySelector('#duration');
const lastEvent = document.querySelector('#last-event');
const eventCount = document.querySelector('#event-count');
const eventList = document.querySelector('#event-list');
const sessionList = document.querySelector('#session-list');
const detailTitle = document.querySelector('#detail-title');
const detailStarted = document.querySelector('#detail-started');
const detailDuration = document.querySelector('#detail-duration');
const detailEvents = document.querySelector('#detail-events');
const detailVideo = document.querySelector('#detail-video');
const detailTask = document.querySelector('#detail-task');
const detailOutcome = document.querySelector('#detail-outcome');
const sessionThumb = document.querySelector('#session-thumb');
const sessionVideo = document.querySelector('#session-video');
const thumbWrap = document.querySelector('.thumb-wrap');
const viewTitle = document.querySelector('#view-title');
const navButtons = [...document.querySelectorAll('.nav-item[data-view]')];
const viewPanels = [...document.querySelectorAll('[data-view-panel]')];
const compactSessionsPanel = document.querySelector('.saved-panel.compact');
const sessionListMount = document.querySelector('.session-list-mount');
const databasePathCopy = document.querySelector('#database-path-copy');
const mirrorRefreshButton = document.querySelector('.mirror-refresh');

const state = {
  recording: false,
  activeSessionId: null,
  selectedSessionId: null,
  stream: null,
  mediaRecorder: null,
  autoCaptureTimer: null,
  cursorTimer: null,
  contextTimer: null,
  durationTimer: null,
  startedAt: null,
  lastContextKey: '',
  currentContext: null,
  lastMouseMoveAt: 0,
  eventTotal: 0,
  mouseEvents: 0,
  screenshots: 0,
  videoBytes: 0,
  videoChunks: 0,
  chunkWrites: [],
  playbackEvents: [],
  playbackStartedAt: null
};

function setRecording(isRecording) {
  state.recording = isRecording;
  startButton.disabled = isRecording;
  stopButton.disabled = !isRecording;
  screenshotButton.disabled = !isRecording;
  taskInput.disabled = isRecording;
  intervalSelect.disabled = isRecording;
  videoSelect.disabled = isRecording;
  recordingStatus.textContent = isRecording ? 'Recording' : 'Idle';
  recordingStatus.classList.toggle('recording', isRecording);
  startButton.textContent = isRecording ? 'Recording in Progress' : 'Begin Recording';
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatDate(value) {
  if (!value) {
    return '--';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function currentTaskDescription() {
  return cleanText(taskInput.value, 'Untitled recording');
}

function contextKey(context) {
  if (!context?.ok) {
    return context?.permissionNeeded ? 'permission-needed' : 'context-unavailable';
  }

  return [
    context.app?.name ?? '',
    context.app?.bundleId ?? '',
    context.window?.title ?? '',
    context.browser?.title ?? '',
    context.browser?.url ?? '',
    context.browser?.error ?? ''
  ].join('|');
}

function updateContextDisplay(context) {
  state.currentContext = context;

  if (!context?.ok) {
    activeApp.textContent = context?.permissionNeeded ? 'Permission needed' : 'Unavailable';
    activeWindow.textContent = context?.error || 'No active context';
    activeUrl.textContent = 'Not available';
    return;
  }

  activeApp.textContent = context.app?.name || 'Unknown';
  activeWindow.textContent = context.browser?.title || context.window?.title || 'No window title';
  activeUrl.textContent = context.browser?.url || context.browser?.error || 'Not available';
}

function eventSummary(type, payload = {}) {
  if (type === 'context') {
    if (payload.permissionNeeded) {
      return 'macOS Automation permission is needed for active app/window tracking.';
    }

    if (payload.browser?.url) {
      return [
        payload.app?.name || 'Unknown app',
        payload.browser?.title || payload.window?.title || 'No title',
        payload.browser.url
      ]
        .filter(Boolean)
        .join(' - ');
    }

    if (payload.browser?.permissionNeeded || payload.browser?.error) {
      return [
        payload.app?.name || 'Unknown app',
        payload.window?.title || 'No window title',
        payload.browser?.error || 'Browser automation permission needed'
      ]
        .filter(Boolean)
        .join(' - ');
    }

    return [
      payload.app?.name || 'Unknown app',
      payload.window?.title || 'No window title',
      payload.browser?.url || ''
    ]
      .filter(Boolean)
      .join(' - ');
  }

  if (type === 'mouse') {
    return `${payload.kind || 'mouse'} at ${payload.screenX}, ${payload.screenY}`;
  }

  if (type === 'frame') {
    return `${payload.file} (${payload.width}x${payload.height})`;
  }

  if (type === 'video-chunk') {
    return `saved ${formatBytes(payload.bytes)} of video`;
  }

  if (type === 'session-start') {
    return payload.task ? `${payload.task}` : `session ${payload.id}`;
  }

  if (type === 'session-stop') {
    return `${payload.outcome || 'unknown'} - ${payload.frames || 0} frames - ${payload.video}`;
  }

  return JSON.stringify(payload);
}

function updateCounters() {
  mouseCount.textContent = String(state.mouseEvents);
  screenshotCount.textContent = String(state.screenshots);
  videoSize.textContent = formatBytes(state.videoBytes);
  chunkCount.textContent = String(state.videoChunks);
  eventCount.textContent = `${state.eventTotal} recorded`;
}

function resetCounters() {
  state.eventTotal = 0;
  state.mouseEvents = 0;
  state.screenshots = 0;
  state.videoBytes = 0;
  state.videoChunks = 0;
  state.chunkWrites = [];
  updateCounters();
}

function switchView(viewName) {
  for (const button of navButtons) {
    button.classList.toggle('active', button.dataset.view === viewName);
  }

  for (const panel of viewPanels) {
    panel.classList.toggle('active', panel.dataset.viewPanel === viewName);
  }

  if (viewName === 'sessions') {
    viewTitle.textContent = 'Saved Sessions';
    sessionListMount.append(sessionList);
    return;
  }

  viewTitle.textContent = 'System Recorder';
  compactSessionsPanel.append(sessionList);
}

function addLog(type, payload = {}, options = {}) {
  if (options.hidden) {
    return;
  }

  const item = document.createElement('li');
  const time = document.createElement('time');
  const label = document.createElement('b');
  const code = document.createElement('code');

  time.textContent = new Date().toLocaleTimeString();
  label.textContent = type;
  code.textContent = eventSummary(type, payload);
  item.append(time, label, code);
  eventList.prepend(item);

  while (eventList.children.length > 140) {
    eventList.lastElementChild.remove();
  }

  lastEvent.textContent = type;
  state.eventTotal += 1;
  updateCounters();
}

function targetSummary(target) {
  if (!(target instanceof Element)) {
    return 'unknown';
  }

  const id = target.id ? `#${target.id}` : '';
  const role = target.getAttribute('role') ? `[role="${target.getAttribute('role')}"]` : '';
  return `${target.tagName.toLowerCase()}${id}${role}`;
}

async function recordEvent(type, payload, options = {}) {
  if (!state.recording) {
    return;
  }

  try {
    await window.signalTrail.recordEvent(type, payload);
    addLog(type, payload, options);
  } catch (error) {
    addLog('error', { message: error.message });
  }
}

function mousePayload(kind, event) {
  return {
    kind,
    x: Math.round(event.clientX),
    y: Math.round(event.clientY),
    screenX: Math.round(event.screenX),
    screenY: Math.round(event.screenY),
    button: event.button,
    buttons: event.buttons,
    target: targetSummary(event.target),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    devicePixelRatio: window.devicePixelRatio
  };
}

function handleMouseMove(event) {
  if (!state.recording) {
    return;
  }

  const now = Date.now();

  if (now - state.lastMouseMoveAt < 120) {
    return;
  }

  state.lastMouseMoveAt = now;
  state.mouseEvents += 1;
  updateCounters();
  recordEvent('mouse', mousePayload('mousemove', event), { hidden: true });
}

function handleMouseAction(kind) {
  return (event) => {
    if (!state.recording) {
      return;
    }

    state.mouseEvents += 1;
    updateCounters();
    recordEvent('mouse', mousePayload(kind, event));
  };
}

async function startScreenStream() {
  resetPlayback();
  previewStatus.textContent = 'Requesting screen';

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false
  });

  state.stream = stream;
  screenPreview.controls = false;
  screenPreview.muted = true;
  screenPreview.removeAttribute('src');
  screenPreview.srcObject = stream;
  await screenPreview.play();
  previewPanel.classList.add('streaming');
  previewStatus.textContent = 'Streaming';

  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (state.recording) {
      stopRecording();
    }
  });

  return stream;
}

function supportedMimeType() {
  const options = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];

  return options.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function startMediaRecorder(stream) {
  if (videoSelect.value === 'off') {
    addLog('video-preview-only', {});
    return;
  }

  if (!window.MediaRecorder) {
    addLog('video-unavailable', { reason: 'MediaRecorder is not available' });
    return;
  }

  const mimeType = supportedMimeType();
  const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

  mediaRecorder.addEventListener('dataavailable', (event) => {
    if (!event.data || event.data.size === 0 || !state.recording) {
      return;
    }

    const chunkIndex = state.videoChunks + 1;
    const write = event.data.arrayBuffer().then(async (buffer) => {
      const result = await window.signalTrail.saveVideoChunk(buffer, {
        chunkIndex,
        mimeType: mediaRecorder.mimeType,
        elapsedMs: Date.now() - state.startedAt
      });

      if (result.ok) {
        state.videoChunks += 1;
        state.videoBytes += result.bytes;
        updateCounters();
        if (state.videoChunks === 1 || state.videoChunks % 15 === 0) {
          addLog('video-chunk', {
            chunk: state.videoChunks,
            bytes: result.bytes
          });
        }
      }
    });

    state.chunkWrites.push(write.catch((error) => addLog('error', { message: error.message })));
  });

  mediaRecorder.addEventListener('error', (event) => {
    addLog('video-error', { message: event.error?.message ?? 'Unknown recorder error' });
  });

  mediaRecorder.start(1000);
  state.mediaRecorder = mediaRecorder;
  addLog('video-start', { mimeType: mediaRecorder.mimeType || 'default' });
}

async function stopMediaRecorder() {
  const mediaRecorder = state.mediaRecorder;

  if (!mediaRecorder) {
    return;
  }

  await new Promise((resolve) => {
    mediaRecorder.addEventListener('stop', resolve, { once: true });

    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    } else {
      resolve();
    }
  });

  await Promise.allSettled(state.chunkWrites);
  state.mediaRecorder = null;
}

function stopScreenStream() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  screenPreview.srcObject = null;
  previewPanel.classList.remove('streaming');
  previewStatus.textContent = 'Ready';
}

async function captureScreenshot(trigger = 'manual') {
  if (!state.recording) {
    return;
  }

  try {
    const result = await window.signalTrail.captureScreenshot({ trigger });

    if (!result.ok) {
      addLog('frame-skipped', result);
      return;
    }

    state.screenshots += 1;
    updateCounters();
    addLog('frame', {
      file: result.file,
      width: result.width,
      height: result.height
    });
  } catch (error) {
    addLog('error', { message: error.message });
  }
}

function startAutoCapture() {
  const intervalMs = Number(intervalSelect.value);

  if (!intervalMs) {
    return;
  }

  state.autoCaptureTimer = window.setInterval(() => {
    captureScreenshot('interval');
  }, intervalMs);
}

function stopAutoCapture() {
  if (state.autoCaptureTimer) {
    window.clearInterval(state.autoCaptureTimer);
    state.autoCaptureTimer = null;
  }
}

function startCursorTracking() {
  window.clearInterval(state.cursorTimer);

  state.cursorTimer = window.setInterval(async () => {
    if (!state.recording) {
      return;
    }

    try {
      const cursor = await window.signalTrail.cursor();
      state.mouseEvents += 1;
      updateCounters();
      await window.signalTrail.recordEvent('cursor', cursor);
    } catch (error) {
      addLog('error', { message: error.message });
    }
  }, 250);
}

function stopCursorTracking() {
  window.clearInterval(state.cursorTimer);
  state.cursorTimer = null;
}

async function sampleActiveContext(forceLog = false) {
  if (!state.recording) {
    return;
  }

  try {
    const context = await window.signalTrail.activeContext();
    const key = contextKey(context);
    updateContextDisplay(context);

    if (forceLog || key !== state.lastContextKey) {
      state.lastContextKey = key;
      await recordEvent('context', context);
    }
  } catch (error) {
    addLog('error', { message: error.message });
  }
}

function startContextTracking() {
  window.clearInterval(state.contextTimer);
  state.lastContextKey = '';
  sampleActiveContext(true);

  state.contextTimer = window.setInterval(() => {
    sampleActiveContext(false);
  }, 1200);
}

function stopContextTracking() {
  window.clearInterval(state.contextTimer);
  state.contextTimer = null;
}

function startDurationTimer() {
  window.clearInterval(state.durationTimer);
  state.durationTimer = window.setInterval(() => {
    duration.textContent = formatDuration(Date.now() - state.startedAt);
  }, 500);
}

function stopDurationTimer() {
  window.clearInterval(state.durationTimer);
  state.durationTimer = null;
}

async function startRecording() {
  resetCounters();
  eventList.replaceChildren();

  try {
    const stream = await startScreenStream();
    const task = currentTaskDescription();
    const response = await window.signalTrail.start({
      task: {
        description: task
      },
      autoScreenshotIntervalMs: Number(intervalSelect.value),
      video: videoSelect.value
    });

    state.activeSessionId = response.session.id;
    state.selectedSessionId = response.session.id;
    state.startedAt = Date.now();
    sessionPath.textContent = response.session.dir;
    databasePath.textContent = response.databasePath;
    setRecording(true);
    startDurationTimer();
    addLog('session-start', { id: response.session.id, task });
    startMediaRecorder(stream);
    startAutoCapture();
    startCursorTracking();
    startContextTracking();
    captureScreenshot('session-start');
    renderSessionList(response.sessions);
    selectSession(response.session.id);
  } catch (error) {
    stopAutoCapture();
    stopScreenStream();
    setRecording(false);
    previewStatus.textContent = 'Screen permission needed';
    addLog('error', { message: error.message });
  }
}

async function stopRecording() {
  if (!state.recording) {
    return;
  }

  stopButton.disabled = true;
  stopAutoCapture();
  stopCursorTracking();
  stopContextTracking();
  await captureScreenshot('session-stop');
  await stopMediaRecorder();

  const elapsedMs = Date.now() - state.startedAt;
  const outcome = {
    status: outcomeSelect.value,
    notes: cleanText(notesInput.value, ''),
    task: currentTaskDescription()
  };
  const response = await window.signalTrail.stop({
    outcome,
    mouseEvents: state.mouseEvents,
    screenshots: state.screenshots,
    videoChunks: state.videoChunks,
    videoBytes: state.videoBytes,
    durationMs: elapsedMs
  });

  setRecording(false);
  stopDurationTimer();
  stopScreenStream();
  duration.textContent = formatDuration(elapsedMs);
  addLog('session-stop', {
    outcome: outcome.status,
    mouseEvents: state.mouseEvents,
    frames: state.screenshots,
    video: formatBytes(state.videoBytes)
  });

  renderSessionList(response.sessions);
  await selectSession(response.session?.id ?? state.activeSessionId);
  state.activeSessionId = null;
}

function renderSessionList(sessions = []) {
  sessionList.replaceChildren();

  if (!sessions.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-row';
    empty.textContent = 'No saved sessions yet';
    sessionList.append(empty);
    detailTitle.textContent = 'Selected Session';
    detailStarted.textContent = '--';
    detailDuration.textContent = '--';
    detailEvents.textContent = '--';
    detailVideo.textContent = '--';
    detailTask.textContent = '--';
    detailOutcome.textContent = '--';
    revealButton.disabled = true;
    resetPlayback();
    sessionThumb.removeAttribute('src');
    thumbWrap.classList.remove('has-image', 'has-video');
    clearStoredEvents();
    return;
  }

  for (const session of sessions) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    const image = document.createElement('img');
    const meta = document.createElement('span');
    const title = document.createElement('strong');
    const details = document.createElement('span');

    button.type = 'button';
    button.className = 'session-item';
    button.classList.toggle('selected', session.id === state.selectedSessionId);
    button.dataset.sessionId = session.id;

    image.className = 'session-thumb';
    image.alt = '';
    image.src = session.thumbnailDataUrl || '';

    if (!session.thumbnailDataUrl) {
      image.style.visibility = 'hidden';
    }

    meta.className = 'session-meta';
    title.textContent =
      session.status === 'recording'
        ? 'Recording now'
        : session.task?.description || session.name;
    details.textContent = `${formatDate(session.startedAt)} - ${
      session.counts.context || 0
    } contexts - ${session.counts.events} events - ${formatBytes(
      session.counts.videoBytes
    )}`;
    meta.append(title, details);
    button.append(image, meta);
    button.addEventListener('click', () => selectSession(session.id));
    row.append(button);
    sessionList.append(row);
  }
}

function addStoredEvent(record) {
  const item = document.createElement('li');
  const time = document.createElement('time');
  const label = document.createElement('b');
  const code = document.createElement('code');

  time.textContent = `${formatDuration(eventOffsetSeconds(record) * 1000)} | ${new Date(
    record.ts
  ).toLocaleTimeString()}`;
  label.textContent = record.type;
  code.textContent = JSON.stringify(record.payload);
  item.append(time, label, code);
  eventList.append(item);
}

function eventOffsetSeconds(record) {
  if (!state.playbackStartedAt || !record?.ts) {
    return 0;
  }

  return Math.max(0, (new Date(record.ts).getTime() - state.playbackStartedAt) / 1000);
}

function isActionEvent(record) {
  return !['video-chunk'].includes(record.type);
}

function renderStoredEvents(events = [], options = {}) {
  if (state.recording) {
    return;
  }

  eventList.replaceChildren();
  const visibleEvents = options.playback
    ? events
        .filter(isActionEvent)
        .filter((record) => eventOffsetSeconds(record) <= options.currentTime)
    : events.filter(isActionEvent);

  for (const record of visibleEvents.slice(-80).reverse()) {
    addStoredEvent(record);
  }

  eventCount.textContent = options.playback
    ? `${visibleEvents.length}/${events.filter(isActionEvent).length} streamed`
    : `${visibleEvents.length} actions shown`;
  lastEvent.textContent = visibleEvents.at(-1)?.type ?? 'Standby';
}

function clearStoredEvents() {
  if (state.recording) {
    return;
  }

  eventList.replaceChildren();
  eventCount.textContent = '0 recorded';
  lastEvent.textContent = 'Standby';
}

function updatePlaybackEvents(event) {
  if (state.recording || !state.playbackEvents.length) {
    return;
  }

  const playbackVideo = event?.currentTarget ?? (screenPreview.src ? screenPreview : sessionVideo);
  renderStoredEvents(state.playbackEvents, {
    playback: true,
    currentTime: playbackVideo.currentTime
  });
}

function clearVideoSource(video) {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function resetPlayback() {
  clearVideoSource(sessionVideo);
  clearVideoSource(screenPreview);
  screenPreview.controls = false;
  screenPreview.muted = true;
  screenPreview.srcObject = null;
  state.playbackEvents = [];
  state.playbackStartedAt = null;
  thumbWrap.classList.remove('has-video');
  previewPanel.classList.remove('streaming');
  previewStatus.textContent = 'Ready';
}

function loadPlayback(detail) {
  if (!detail.videoUrl || detail.counts.videoBytes <= 0) {
    resetPlayback();
    return;
  }

  sessionVideo.src = detail.videoUrl;
  thumbWrap.classList.add('has-video');

  screenPreview.srcObject = null;
  screenPreview.src = detail.videoUrl;
  screenPreview.controls = true;
  screenPreview.muted = false;
  screenPreview.autoplay = false;
  previewPanel.classList.add('streaming');
  previewStatus.textContent = 'Playback';
  updatePlaybackEvents({ currentTarget: screenPreview });
}

async function loadSessions() {
  const sessions = await window.signalTrail.listSessions();
  renderSessionList(sessions);

  if (!state.selectedSessionId && sessions[0]) {
    await selectSession(sessions[0].id);
  }
}

async function selectSession(id) {
  if (!id) {
    return;
  }

  state.selectedSessionId = id;
  const detail = await window.signalTrail.getSessionDetail(id);

  if (!detail) {
    return;
  }

  detailTitle.textContent = detail.status === 'recording' ? 'Recording Now' : detail.name;
  detailStarted.textContent = formatDate(detail.startedAt);
  detailDuration.textContent =
    detail.durationMs === null || detail.durationMs === undefined
      ? '--'
      : formatDuration(detail.durationMs);
  detailEvents.textContent = String(detail.counts.events);
  detailVideo.textContent = formatBytes(detail.counts.videoBytes);
  detailTask.textContent = detail.task?.description || '--';
  detailOutcome.textContent = detail.outcome?.status || '--';
  revealButton.disabled = false;
  state.playbackEvents = detail.events ?? [];
  state.playbackStartedAt = new Date(detail.startedAt).getTime();
  renderStoredEvents(detail.events);

  if (!state.recording && detail.latestContext) {
    updateContextDisplay(detail.latestContext);
  }

  if (detail.thumbnailDataUrl) {
    sessionThumb.src = detail.thumbnailDataUrl;
    thumbWrap.classList.add('has-image');
  } else {
    sessionThumb.removeAttribute('src');
    thumbWrap.classList.remove('has-image');
  }

  loadPlayback(detail);

  for (const button of sessionList.querySelectorAll('.session-item')) {
    button.classList.toggle('selected', button.dataset.sessionId === id);
  }
}

startButton.addEventListener('click', startRecording);
stopButton.addEventListener('click', stopRecording);
screenshotButton.addEventListener('click', () => captureScreenshot('manual'));
refreshButton.addEventListener('click', loadSessions);
mirrorRefreshButton.addEventListener('click', loadSessions);
sessionVideo.addEventListener('play', updatePlaybackEvents);
sessionVideo.addEventListener('seeked', updatePlaybackEvents);
sessionVideo.addEventListener('timeupdate', updatePlaybackEvents);
screenPreview.addEventListener('play', updatePlaybackEvents);
screenPreview.addEventListener('seeked', updatePlaybackEvents);
screenPreview.addEventListener('timeupdate', updatePlaybackEvents);
revealButton.addEventListener('click', () => {
  if (state.selectedSessionId) {
    window.signalTrail.revealSession(state.selectedSessionId);
  }
});

for (const button of navButtons) {
  button.addEventListener('click', () => switchView(button.dataset.view));
}

document.addEventListener('mousemove', handleMouseMove, { passive: true });
document.addEventListener('mousedown', handleMouseAction('mousedown'), { passive: true });
document.addEventListener('mouseup', handleMouseAction('mouseup'), { passive: true });
document.addEventListener('click', handleMouseAction('click'), { passive: true });

window.signalTrail.status().then(async (status) => {
  setRecording(status.isRecording);
  databasePath.textContent = status.databasePath;
  databasePathCopy.textContent = status.databasePath;

  if (status.session) {
    sessionPath.textContent = status.session.dir;
  }

  await loadSessions();
});
