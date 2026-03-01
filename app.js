import { createGate, createEndGate } from './gate.js';

const CONFIG = {
  googleForm: 'https://docs.google.com/forms/d/e/1FAIpQLSeK2rPrrUUo1YnIfrDUVive9NZjUZ-8cxWxOsWiEfUyKhqlug/viewform?usp=publish-editor',
  runSpeedMs: 0.0068, // forward speed per ms (~20% slower than before to add reaction time)
  strafeSpeedMs: 0.02, // left/right speed per ms
  gateSpacing: 22,
  trackWidth: 16,
  groundLength: 240,
  startZ: -60,
};

let engine;
let scene;
let camera;
let player;
let gateMeshes = [];
let gatePairs = [];
let generatedQuestions = [];
let selectedQuestions = [];
let currentQuestionIdx = 0;
let gameState = 'setup'; // setup | running | finished
let moveDir = 0;
let dragActive = false;
let dragTargetX = 0;
let results = { correct: 0, total: 0, points: 0 };
let trackSegments = [];

const ui = {
  fileInput: document.getElementById('fileInputGame'),
  setupPanel: document.getElementById('setupPanel'),
  promptInput: document.getElementById('promptInput'),
  countInput: document.getElementById('countInput'),
  generateBtn: document.getElementById('generateBtn'),
  startBtn: document.getElementById('startBtn'),
  resetBtn: document.getElementById('resetBtn'),
  questionList: document.getElementById('questionList'),
  selectionCount: document.getElementById('selectionCount'),
  statusText: document.getElementById('setupStatus'),
  statusDot: document.getElementById('statusDot'),
  questionText: document.getElementById('questionText'),
  questionNumber: document.getElementById('questionNumber'),
  runStatus: document.getElementById('runStatus'),
  resultPanel: document.getElementById('resultPanel'),
  scoreText: document.getElementById('scoreText'),
  retryBtn: document.getElementById('retryBtn'),
  regenBtn: document.getElementById('regenBtn'),
  surveyBtn: document.getElementById('surveyBtn'),
  hitFlash: document.getElementById('hitFlash'),
  hitText: document.getElementById('hitText'),
};

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('renderCanvas');
  engine = new BABYLON.Engine(canvas, true);
  scene = createScene(engine, canvas);

  bindUI();

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime();
    if (gameState === 'running') {
      movePlayer(dt);
      checkGateCollision();
    }
    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());
});

function bindUI() {
  ui.generateBtn.addEventListener('click', generateQuestions);
  ui.startBtn.addEventListener('click', startGameFromSelection);
  ui.resetBtn.addEventListener('click', resetSetup);
  ui.retryBtn.addEventListener('click', () => startGame(true));
  ui.regenBtn.addEventListener('click', () => resetSetup());
  ui.surveyBtn.addEventListener('click', () => window.open(CONFIG.googleForm, '_blank'));

  if (ui.questionText) {
    ui.questionText.style.whiteSpace = 'pre-line';
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'a' || e.key === 'ArrowLeft') moveDir = -1;
    if (e.key === 'd' || e.key === 'ArrowRight') moveDir = 1;
  });
  document.addEventListener('keyup', (e) => {
    if ((e.key === 'a' || e.key === 'ArrowLeft') && moveDir === -1) moveDir = 0;
    if ((e.key === 'd' || e.key === 'ArrowRight') && moveDir === 1) moveDir = 0;
  });

  window.addEventListener('pointerdown', (e) => {
    dragActive = true;
    updateDragTarget(e.clientX);
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragActive) return;
    updateDragTarget(e.clientX);
  });
  window.addEventListener('pointerup', () => {
    dragActive = false;
    moveDir = 0;
  });

  renderQuestionList([]);
  setStatus('Waiting to generate');
  setRunStatus('Not started');
}

function createScene(engine, canvas) {
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.62, 0.84, 1, 1);

  camera = new BABYLON.ArcRotateCamera('camera', BABYLON.Tools.ToRadians(-95), BABYLON.Tools.ToRadians(50), 14, new BABYLON.Vector3(0, 1.3, CONFIG.startZ + 4), scene);
  camera.lowerRadiusLimit = 12;
  camera.upperRadiusLimit = 16;
  camera.panningSensibility = 0;
  camera.angularSensibilityX = 0;
  camera.angularSensibilityY = 0;
  camera.fov = 0.65;
  // We will drive camera position manually; do not attach user controls.

  const light = new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0.2), scene);
  light.intensity = 0.9;

  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.4, -1, -0.2), scene);
  sun.position = new BABYLON.Vector3(0, 25, 10);
  sun.intensity = 0.7;

  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: CONFIG.trackWidth + 2, height: CONFIG.groundLength }, scene);
  const gMat = new BABYLON.StandardMaterial('ground-mat', scene);
  gMat.diffuseColor = new BABYLON.Color3(0.08, 0.09, 0.11); // dark asphalt
  gMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
  ground.material = gMat;

  // Shoulders on each side of the highway
  const shoulderMat = new BABYLON.StandardMaterial('shoulder-mat', scene);
  shoulderMat.diffuseColor = new BABYLON.Color3(0.18, 0.2, 0.24);
  shoulderMat.emissiveColor = shoulderMat.diffuseColor.scale(0.2);
  ['left', 'right'].forEach((side, i) => {
    const shoulder = BABYLON.MeshBuilder.CreatePlane(`shoulder-${side}`, { width: 2, height: CONFIG.groundLength }, scene);
    shoulder.rotation = new BABYLON.Vector3(Math.PI / 2, 0, 0);
    shoulder.position = new BABYLON.Vector3((i === 0 ? -1 : 1) * (CONFIG.trackWidth / 2 - 1), 0.015, 0);
    shoulder.material = shoulderMat;
  });

  // Edge lines to frame the highway lanes
  const edgeMat = new BABYLON.StandardMaterial('edge-line-mat', scene);
  edgeMat.diffuseColor = new BABYLON.Color3(0.9, 0.92, 0.95);
  edgeMat.emissiveColor = edgeMat.diffuseColor.scale(0.35);
  ['left', 'right'].forEach((side, i) => {
    const edge = BABYLON.MeshBuilder.CreatePlane(`edge-line-${side}`, { width: 0.18, height: CONFIG.groundLength }, scene);
    edge.rotation = new BABYLON.Vector3(Math.PI / 2, 0, 0);
    edge.position = new BABYLON.Vector3((i === 0 ? -1 : 1) * (CONFIG.trackWidth / 2 - 1.2), 0.02, 0);
    edge.material = edgeMat;
  });

  // Center dashed line in bright white; keep within ground bounds
  const dashHalf = 2;
  const groundMinZ = -CONFIG.groundLength / 2;
  const groundMaxZ = CONFIG.groundLength / 2;
  for (let z = groundMinZ + dashHalf, idx = 0; z <= groundMaxZ - dashHalf; z += 8, idx++) {
    const dash = BABYLON.MeshBuilder.CreatePlane(`dash-${idx}`, { width: 0.5, height: 4 }, scene);
    dash.rotation = new BABYLON.Vector3(Math.PI / 2, 0, 0);
    dash.position = new BABYLON.Vector3(0, 0.02, z);
    const dMat = new BABYLON.StandardMaterial(`dash-mat-${idx}`, scene);
    dMat.diffuseColor = new BABYLON.Color3(0.95, 0.95, 0.98);
    dMat.emissiveColor = dMat.diffuseColor.scale(0.45);
    dash.material = dMat;
  }

  // Side rails aligned to the track edges
  const railMat = new BABYLON.StandardMaterial('rail-mat', scene);
  railMat.diffuseColor = new BABYLON.Color3(0.72, 0.76, 0.82);
  railMat.emissiveColor = new BABYLON.Color3(0.35, 0.38, 0.42);
  railMat.specularColor = new BABYLON.Color3(0.9, 0.9, 0.95);
  ['left', 'right'].forEach((side, i) => {
    const rail = BABYLON.MeshBuilder.CreateBox(`rail-${side}`, { width: 0.25, height: 0.6, depth: CONFIG.groundLength }, scene);
    rail.position = new BABYLON.Vector3((i === 0 ? -1 : 1) * (CONFIG.trackWidth / 2 + 0.7), 0.6, 0);
    rail.material = railMat;
  });

  // Simple car: body + four wheels
  const body = BABYLON.MeshBuilder.CreateBox('car-body', { width: 1.2, height: 0.6, depth: 2.2 }, scene);
  const bodyMat = new BABYLON.StandardMaterial('car-body-mat', scene);
  bodyMat.diffuseColor = new BABYLON.Color3(0.16, 0.74, 0.93);
  bodyMat.emissiveColor = new BABYLON.Color3(0.1, 0.45, 0.65);
  body.material = bodyMat;

  const wheelMat = new BABYLON.StandardMaterial('car-wheel-mat', scene);
  wheelMat.diffuseColor = new BABYLON.Color3(0.1, 0.1, 0.1);
  wheelMat.emissiveColor = new BABYLON.Color3(0.05, 0.05, 0.05);

  const wheelOffsets = [
    [-0.55, -0.35, 0.9],
    [0.55, -0.35, 0.9],
    [-0.55, -0.35, -0.9],
    [0.55, -0.35, -0.9],
  ];
  wheelOffsets.forEach((o, i) => {
    const w = BABYLON.MeshBuilder.CreateCylinder(`car-wheel-${i}`, { diameter: 0.6, height: 0.35, tessellation: 16 }, scene);
    w.rotation.z = Math.PI / 2;
    w.position = new BABYLON.Vector3(o[0], o[1], o[2]);
    w.material = wheelMat;
    w.parent = body;
  });

  player = body;
  player.position = new BABYLON.Vector3(0, 0.6, CONFIG.startZ);
  player.isPickable = true;
  camera.target = player.position;

  const glow = new BABYLON.GlowLayer('glow', scene, { blurKernelSize: 16 });
  glow.intensity = 0.6;

  scene.registerBeforeRender(() => {
    player.position.y = 0.65 + Math.sin(performance.now() * 0.003) * 0.02;
    // Lock camera laterally so only the car shifts when strafing.
    camera.target = new BABYLON.Vector3(0, player.position.y, player.position.z);
    const followZ = player.position.z - 13;
    const followY = player.position.y + 4.8;
    camera.setPosition(new BABYLON.Vector3(0, followY, followZ));
  });

  return scene;
}

function createRoadMarker(text, position, size = 3, tint = new BABYLON.Color3(1, 1, 1), offsetX = 0, flipFacing = true, mirrorX = false) {
  const texSize = 256;
  const zId = position?.z ?? 0;
  const texture = new BABYLON.DynamicTexture(`road-marker-${text}-${zId}`, { width: texSize, height: texSize }, scene, false);
  texture.hasAlpha = true;
  const fontSize = Math.floor(texSize * 0.5);
  texture.drawText(text, texSize / 2, texSize / 2 + fontSize * 0.15, `bold ${fontSize}px Segoe UI`, '#f8fafc', 'transparent', true, true);

  const mat = new BABYLON.StandardMaterial(`road-marker-mat-${text}-${zId}`, scene);
  mat.diffuseTexture = texture;
  mat.emissiveColor = tint.scale(0.85);
  mat.specularColor = BABYLON.Color3.Black();
  mat.backFaceCulling = false;

  const basePos = position || {};
  const pos = basePos.clone ? basePos.clone() : new BABYLON.Vector3(basePos.x || 0, basePos.y || 0, basePos.z || 0);
  pos.y = Math.max(pos.y, 0.02);

  const plane = BABYLON.MeshBuilder.CreatePlane(`road-marker-${text}-${zId}`, { size }, scene);
  plane.material = mat;
  plane.position = pos;
  plane.position.x += offsetX; // nudge along x to align under gate panel
  const yaw = flipFacing ? Math.PI : 0;
  plane.rotation = new BABYLON.Vector3(-Math.PI / 2, yaw, 0); // face player along approach direction
  if (mirrorX) {
    plane.scaling = new BABYLON.Vector3(-1, 1, 1); // mirror text horizontally
  }
  plane.isPickable = false;
  return plane;
}

async function generateQuestions() {
  try {
    ui.generateBtn.disabled = true;
    setStatus('Generating questions...');
    const file = ui.fileInput?.files?.[0];
    if (!file) {
      setStatus('Please upload a pdf/docx/pptx file first', false, true);
      ui.generateBtn.disabled = false;
      return;
    }

    const fd = new FormData();
    fd.append('prompt', '');
    fd.append('count', Number(ui.countInput.value) || 8);
    fd.append('file', file);

    const res = await fetch('/api/generate-questions', { method: 'POST', body: fd });
    if (!res.ok) {
      let message = `Server error (${res.status})`;
      try {
        const text = await res.text();
        console.warn('Question API error body:', text); // surfacing raw response for devtools
        try {
          const errBody = JSON.parse(text);
          if (errBody?.error) message = errBody.error;
        } catch (parseErr) {
          console.warn('Failed to parse error response as JSON', parseErr);
        }
      } catch (readErr) {
        console.warn('Failed to read error response', readErr);
      }
      setStatus(message, false, true);
      return;
    }
    const data = await res.json();
    const raw = data?.result?.questions || data?.questions || [];
    generatedQuestions = normalizeTwoOptions(raw);
    renderQuestionList(generatedQuestions);
    setStatus('Generated. Pick the questions to play.', true);
  } catch (err) {
    console.warn('Generation failed, using fallback', err);
    generatedQuestions = fallbackQuestions();
    renderQuestionList(generatedQuestions);
    setStatus('Using fallback questions', false, true);
  } finally {
    ui.generateBtn.disabled = false;
  }
}

function normalizeTwoOptions(list) {
  return (list || []).map((q, idx) => {
    const opts = Array.isArray(q.options) ? q.options.slice(0, 2) : [];
    while (opts.length < 2) opts.push('Option');
    const labeled = opts.map((opt, i) => {
      const prefix = i === 0 ? 'A:' : 'B:';
      return opt?.trim().startsWith(prefix) ? opt : `${prefix} ${opt || 'Option'}`.trim();
    });
    const safeAnswer = Number.isFinite(Number(q.answerIndex)) ? Number(q.answerIndex) : 0;
    return {
      id: q.id || `q-${idx + 1}`,
      question: q.question || `Question ${idx + 1}`,
      options: labeled.slice(0, 2),
      answerIndex: Math.min(Math.max(0, safeAnswer), 1),
    };
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function fallbackQuestions() {
  return normalizeTwoOptions([
    { question: 'Is WebGL used for 3D graphics in browsers?', options: ['A: Yes', 'B: No'], answerIndex: 0 },
    { question: 'Does Vector3 describe 3D positions?', options: ['A: Yes', 'B: No'], answerIndex: 0 },
    { question: 'Do CSS media queries detect mesh collisions?', options: ['A: Yes', 'B: No'], answerIndex: 1 },
  ]);
}

function renderQuestionList(list) {
  ui.questionList.innerHTML = '';
  if (!list.length) {
    ui.questionList.innerHTML = '<p style="color:#9ca3af">No questions yet. Generate to begin.</p>';
    ui.selectionCount.textContent = '0 selected';
    return;
  }

  list.forEach((q, idx) => {
    const row = document.createElement('div');
    row.className = 'question-item';
    row.dataset.idx = idx.toString();
    row.dataset.answer = (q.answerIndex ?? 0).toString();

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.className = 'question-check';

    const body = document.createElement('div');
    const qInput = document.createElement('input');
    qInput.type = 'text';
    qInput.value = q.question || '';
    qInput.className = 'question-text-input';

    const optWrap = document.createElement('div');
    optWrap.style.display = 'grid';
    optWrap.style.gridTemplateColumns = '1fr 1fr';
    optWrap.style.gap = '6px';

    const opt0 = document.createElement('input');
    opt0.type = 'text';
    opt0.value = (q.options && q.options[0]) || 'Option 1';
    opt0.className = 'option-input';

    const opt1 = document.createElement('input');
    opt1.type = 'text';
    opt1.value = (q.options && q.options[1]) || 'Option 2';
    opt1.className = 'option-input';

    optWrap.appendChild(opt0);
    optWrap.appendChild(opt1);

    const answerBadge = document.createElement('div');
    answerBadge.textContent = `Correct: ${q.answerIndex === 1 ? 'B' : 'A'}`;
    answerBadge.style.fontSize = '12px';
    answerBadge.style.color = '#10b981';
    answerBadge.style.marginTop = '4px';

    body.appendChild(qInput);
    body.appendChild(optWrap);
    body.appendChild(answerBadge);

    row.appendChild(checkbox);
    row.appendChild(body);
    ui.questionList.appendChild(row);
  });

  updateSelectionCount();
  ui.questionList.querySelectorAll('.question-check').forEach((box) => box.addEventListener('change', updateSelectionCount));
}

function updateSelectionCount() {
  const boxes = ui.questionList.querySelectorAll('input[type="checkbox"]');
  const selected = Array.from(boxes).filter((b) => b.checked).length;
  ui.selectionCount.textContent = `${selected} selected`;
}

function startGameFromSelection() {
  const rows = Array.from(ui.questionList.querySelectorAll('.question-item'));
  const chosen = rows
    .filter((row) => row.querySelector('.question-check')?.checked)
    .map((row) => {
      const idx = Number(row.dataset.idx || '0');
      const base = generatedQuestions[idx] || {};
      const qInput = row.querySelector('.question-text-input');
      const optInputs = row.querySelectorAll('.option-input');
      const options = [optInputs[0]?.value || 'Option 1', optInputs[1]?.value || 'Option 2'];
      const answerIndex = Math.min(Math.max(0, Number(row.dataset.answer || base.answerIndex || 0)), 1);
      return {
        id: base.id || `q-${idx + 1}`,
        question: (qInput && qInput.value) || base.question || `Question ${idx + 1}`,
        options,
        answerIndex,
      };
    });

  if (!chosen.length) {
    setStatus('Select at least one question to start', false, true);
    return;
  }
  selectedQuestions = shuffle(chosen.slice());
  startGame(false);
}

function startGame(isRetry) {
  if (!selectedQuestions.length) {
    setStatus('Generate and select questions first', false, true);
    return;
  }

  gateMeshes.forEach((g) => g.dispose());
  trackSegments.forEach((m) => m.dispose());
  gateMeshes = [];
  gatePairs = [];
  trackSegments = [];
  currentQuestionIdx = 0;
  results = { correct: 0, total: selectedQuestions.length };
  results.points = 0;
  gameState = 'running';
  ui.resultPanel.classList.add('hidden');
  ui.setupPanel.classList.add('hidden');
  resetPlayerPosition();
  buildCourse();
  updateBanner();
  setRunStatus(isRetry ? 'Replay started' : 'Run started');

  // Drop generated output UI/state once the run begins; keep only the in-run selection.
  generatedQuestions = [];
  renderQuestionList([]);
  if (ui.fileInput) ui.fileInput.value = '';
}

function resetSetup() {
  generatedQuestions = [];
  selectedQuestions = [];
  renderQuestionList([]);
  setStatus('Reset. Generate again.');
  setRunStatus('Not started');
  ui.resultPanel.classList.add('hidden');
  ui.setupPanel.classList.remove('hidden');
  if (ui.fileInput) ui.fileInput.value = '';
  gateMeshes.forEach((g) => g.dispose());
  trackSegments.forEach((m) => m.dispose());
  gateMeshes = [];
  gatePairs = [];
  trackSegments = [];
  currentQuestionIdx = 0;
  resetPlayerPosition();
  gameState = 'setup';
  updateBanner();
}

function setStatus(text, ok = false, error = false) {
  ui.statusText.textContent = text;
  ui.statusDot.classList.toggle('ok', ok);
  ui.statusDot.classList.toggle('err', error);
}

function setRunStatus(text) {
  ui.runStatus.textContent = text;
}

function updateDragTarget(clientX) {
  const limit = CONFIG.trackWidth / 2 - 1.2;
  const normalized = (clientX / window.innerWidth) * 2 - 1; // -1 left, 1 right
  dragTargetX = Math.min(Math.max(normalized * limit, -limit), limit);
}

function stripOptionPrefix(text) {
  const value = (text || '').trim();
  return value.replace(/^[AaBb]\s*:\s*/, '').trim() || value;
}

function updateBanner() {
  if (!selectedQuestions.length) {
    ui.questionNumber.textContent = 'Question --/--';
    ui.questionText.textContent = 'Generate and start the run to see questions here.';
    return;
  }
  const total = selectedQuestions.length;
  const idx = Math.min(currentQuestionIdx + 1, total);
  ui.questionNumber.textContent = `Question ${idx}/${total}`;
  const q = selectedQuestions[currentQuestionIdx];
  if (q) {
    const opts = q.options || [];
    const optA = stripOptionPrefix(opts[0] || 'A option');
    const optB = stripOptionPrefix(opts[1] || 'B option');
    ui.questionText.textContent = `${q.question}\nA: ${optA}\nB: ${optB}`;
  } else {
    ui.questionText.textContent = 'Head to the finish gate';
  }
  updateGateVisibility();
}

function resetPlayerPosition() {
  player.position = new BABYLON.Vector3(0, 0.6, CONFIG.startZ);
}

function buildCourse() {
  let zPos = CONFIG.startZ + 18;
  const laneWidth = CONFIG.trackWidth;
  const baseSpacing = laneWidth / 3;
  const gateOffset = baseSpacing * 0.6; // bring A/B closer to center
  const gateWidth = baseSpacing * 0.8;
  const centerWidth = laneWidth * 1.2; // stretch neutral collider to cover any gaps as hard out-of-bounds
  const startX = -gateOffset; // left center

  selectedQuestions.forEach((q, qIdx) => {
    const pair = [];

    const leftGate = createGate(scene, player, {
      label: 'A',
      position: new BABYLON.Vector3(startX, 0, zPos),
      color: new BABYLON.Color3(0.85, 0.36, 0.2), // burnt sienna for option A (avoids blue-yellow axis)
      width: gateWidth,
      showLabel: false,
      onEnter: () => handleGateHit(qIdx, 0, leftGate),
      metadata: { questionId: q.id, optionIndex: 0, type: 'option' },
    });
    gateMeshes.push(leftGate);
    pair.push(leftGate);

    const midGate = createGate(scene, player, {
      label: '[ ]',
      position: new BABYLON.Vector3(0, 0, zPos),
      color: new BABYLON.Color3(0.55, 0.55, 0.6), // neutral center check lane
      width: centerWidth,
      panelAlpha: 0.25,
      hideVisuals: true, // keep collider only so the lane is invisible but still detectable
      onEnter: () => handleGateHit(qIdx, -1, midGate),
      metadata: { type: 'neutral', questionId: q.id, optionIndex: -1 },
    });
    gateMeshes.push(midGate);
    pair.push(midGate);

    const rightGate = createGate(scene, player, {
      label: 'B',
      position: new BABYLON.Vector3(gateOffset, 0, zPos),
      color: new BABYLON.Color3(0.55, 0.12, 0.55), // plum for option B (avoids blue-yellow axis)
      width: gateWidth,
      showLabel: false,
      onEnter: () => handleGateHit(qIdx, 1, rightGate),
      metadata: { questionId: q.id, optionIndex: 1, type: 'option' },
    });
    gateMeshes.push(rightGate);
    pair.push(rightGate);

    gatePairs.push(pair);

    const markerZ = zPos - 2.5;
    const markerSize = gateWidth * 1.2;
    const markerOffsetA = markerSize * 0.08; // nudge A slightly right
    const markerOffsetB = -markerSize * 0.12; // nudge B further left
    const markerA = createRoadMarker('A', new BABYLON.Vector3(startX, 0.02, markerZ), markerSize, new BABYLON.Color3(0.85, 0.36, 0.2), markerOffsetA, true, false);
    const markerB = createRoadMarker('B', new BABYLON.Vector3(gateOffset, 0.02, markerZ), markerSize, new BABYLON.Color3(0.55, 0.12, 0.55), markerOffsetB, true, true);
    trackSegments.push(markerA, markerB);

    zPos += CONFIG.gateSpacing;
  });
}

function handleGateHit(questionIdx, optionIdx, gate) {
  if (gameState !== 'running') return;
  const question = selectedQuestions[questionIdx];
  if (!question) return;
  if (questionIdx !== currentQuestionIdx) return; // only current question counts

  const correct = optionIdx === question.answerIndex;
  if (correct) results.correct += 1;
  if (correct) results.points = (results.points || 0) + 10;
  const panelMat = gate?.metadata?.panelMat;
  if (panelMat) {
    panelMat.emissiveColor = correct ? new BABYLON.Color3(0.1, 0.6, 0.28) : new BABYLON.Color3(0.7, 0.2, 0.2);
  }

  const hitLabel = optionIdx >= 0 ? question.options[optionIdx] : 'No answer';
  showHitFeedback(correct, hitLabel);

  currentQuestionIdx += 1;
  if (currentQuestionIdx >= selectedQuestions.length) {
    ui.questionText.textContent = 'All questions answered!';
    finishRun();
  } else {
    updateBanner();
  }
}

function checkGateCollision() {
  if (gameState !== 'running') return;
  const pair = gatePairs[currentQuestionIdx];
  if (!pair) return;
  player.computeWorldMatrix(true);
  for (let optIdx = 0; optIdx < pair.length; optIdx++) {
    const gate = pair[optIdx];
    if (!gate || gate.metadata?.hit === true) continue;
    if (!gate.isEnabled()) continue;
    const collider = gate.metadata?.collider || gate;
    collider.computeWorldMatrix(true);
    if (player.intersectsMesh(collider, false)) {
      gate.metadata.hit = true;
      const opt = typeof gate.metadata?.optionIndex === 'number' ? gate.metadata.optionIndex : optIdx;
      handleGateHit(currentQuestionIdx, opt, gate);
      return;
    }
  }
}

function updateGateVisibility() {
  gatePairs.forEach((pair, idx) => {
    const visible = idx === currentQuestionIdx;
    pair.forEach((gate) => {
      if (!gate) return;
      gate.setEnabled(visible);
    });
  });
}

function showHitFeedback(correct, label) {
  const flash = ui.hitFlash;
  const text = ui.hitText;
  if (!flash || !text) return;

  text.textContent = correct ? 'Correct!' : 'Wrong gate';
  text.style.borderColor = correct ? '#34d399' : '#f25f5c';
  text.style.color = correct ? '#c7f9cc' : '#fecdd3';
  flash.classList.toggle('error', !correct);

  flash.classList.remove('hidden');
  text.classList.remove('hidden');
  // trigger reflow for transition
  void flash.offsetWidth;
  flash.classList.add('show');
  text.classList.add('show');

  // tiny pulse on player
  player.scaling = new BABYLON.Vector3(1.1, 1.1, 1.1);
  setTimeout(() => {
    player.scaling = new BABYLON.Vector3(1, 1, 1);
    flash.classList.remove('show');
    text.classList.remove('show');
  }, 500);

  setTimeout(() => {
    flash.classList.add('hidden');
    text.classList.add('hidden');
  }, 800);
}

function finishRun() {
  if (gameState !== 'running') return;
  gameState = 'finished';
  setRunStatus('Finished');
  showResult();
}

function showResult() {
  const pts = results.points || 0;
  const score = `${pts} points  •  ${results.correct} / ${results.total} correct`;
  ui.scoreText.textContent = score;
  ui.resultPanel.classList.remove('hidden');
}

function movePlayer(deltaMs) {
  player.position.z += CONFIG.runSpeedMs * deltaMs;
  if (dragActive) {
    // Smoothly steer toward the drag target when user is dragging
    const lerp = 0.18;
    const dx = dragTargetX - player.position.x;
    player.position.x += dx * lerp;
  } else {
    player.position.x += moveDir * CONFIG.strafeSpeedMs * deltaMs;
  }
  const limit = CONFIG.trackWidth / 2 - 1.2;
  player.position.x = Math.min(Math.max(player.position.x, -limit), limit);
}
